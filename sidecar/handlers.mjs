// Operations exposed over HTTP. One export per endpoint name; the server only routes.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CDP_URL,
  adopt,
  allPages,
  birthOf,
  browserSession,
  closeTarget,
  dropPage,
  ensureContext,
  frontOf,
  markFront,
  getPage,
  hasChooser,
  idOf,
  isConnected,
  pageForTarget,
  pageTargets,
  popDownload,
  recordedResponses,
  responsive,
  setDialogOverride,
  takeChooser,
  windowOf,
  withFocus,
} from "./browser.mjs";
import { OFFSTAGE, go, input, stage, stagedWindows } from "./live.mjs";
import { injectRefLabels, removeRefLabels, resolveRef, screenshotPath, snapshotPage } from "./snapshot.mjs";

// Hard floor, independent of config: these would expose the browser session's credentials
// (cookies, storage, auth headers via request interception) or let the agent escape its own
// page. A hostile page steering the agent must not be able to reach them.
const byBirth = (a, b) => birthOf(a.pageId ?? a.id) - birthOf(b.pageId ?? b.id);

const CDP_DENIED = [
  /^Browser\./i,
  /^Target\./i,
  /^Storage\./i,
  /^Security\./i,
  /^Fetch\./i,
  /^Network\.(setCookie|setCookies|getCookies|getAllCookies|clearBrowserCookies|setExtraHTTPHeaders)/i,
];

async function settle(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // SPAs (Instagram, TikTok...) are still blank at domcontentloaded: give the JS a
  // chance to render before snapshotting, without hanging on never-idle pages.
  await page.waitForLoadState("load", { timeout: 8000 }).catch(() => undefined);
}

/** A new tab in the given window. CDP has no parameter for it: a new target opens in the window
 *  that has the focus, so a tab of this one is brought forward first, and the pair is one step for
 *  whoever else moves the focus (docs/browser-windows.md). The window is checked afterwards. */
async function openTabIn(ctx, windowId) {
  return withFocus(async () => {
    let anchor;
    for (const page of ctx.pages()) {
      const pageId = await adopt(page).catch(() => undefined);
      if (pageId && (await windowOf(pageId).catch(() => undefined)) === windowId) {
        anchor = page;
        break;
      }
    }
    if (!anchor) throw new Error(`Window ${windowId} has no tab left to open one beside.`);
    await anchor.bringToFront();
    const cdp = await browserSession();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const page = await pageForTarget(ctx, targetId);
    const landed = await windowOf(targetId);
    if (landed !== windowId) {
      await page.close().catch(() => undefined);
      throw new Error(`The new tab opened in another window (${landed}, not ${windowId}); nothing was left open.`);
    }
    return page;
  });
}

export const handlers = {
  // Navigates the given tab (pageId) in place unless newTab is set, so a task navigating several
  // times stays in ONE tab. A new tab opens in the window named by windowId, never wherever the
  // focus happens to be: another run may be working in the window that has it.
  async navigate(body) {
    const ctx = await ensureContext();
    const reuse = !body.newTab && body.pageId ? allPages.get(body.pageId) : undefined;
    let page;
    if (reuse && !reuse.isClosed()) {
      page = reuse;
    } else if (body.windowId !== undefined && body.windowId !== null) {
      page = await openTabIn(ctx, Number(body.windowId));
    } else {
      page = await ctx.newPage();
    }
    const pageId = await adopt(page);
    await settle(page, body.url);
    return { pageId, snapshot: await snapshotPage(page), url: page.url() };
  },

  // A real window, in the one context: same profile, same logins, its own tabs and focus.
  async "create-window"(body) {
    const ctx = await ensureContext();
    const cdp = await browserSession();
    const width = Number(body.viewport?.width ?? 1920);
    const height = Number(body.viewport?.height ?? 1080);
    // Born off the VNC screen, where a human may be working: the owner's own window, or the first
    // one of an empty screen, is put on it.
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, width, height, ...OFFSTAGE });
    const page = await pageForTarget(ctx, targetId);
    const windowId = await windowOf(targetId);
    if (body.onStage === true || (await stagedWindows()).size === 0) await stage(windowId);
    await settle(page, body.url);
    return { windowId, pageId: targetId, snapshot: await snapshotPage(page), url: page.url() };
  },

  // Asked of the browser, never of the pages: a tab stuck in its own JavaScript answers nothing,
  // its title included, and a listing that asked each tab waited on it for every run at once.
  async "list-windows"() {
    const ctx = await ensureContext();
    const cdp = await browserSession();
    const targets = await pageTargets();
    // The opener comes from Playwright, which keeps it without asking the page: the browser's own
    // list drops it for a target=_blank link, which Chromium opens noopener.
    const openers = new Map();
    await Promise.all(
      ctx.pages().map(async (page) => {
        const pageId = await adopt(page).catch(() => undefined);
        const opener = await page.opener().catch(() => null);
        const openerPageId = opener ? idOf(opener) : undefined;
        if (pageId && openerPageId) openers.set(pageId, openerPageId);
      }),
    );
    const located = await Promise.all(
      targets.map((t) =>
        cdp.send("Browser.getWindowForTarget", { targetId: t.id }).then(
          (r) => r.windowId,
          () => undefined, // closed between the listing and the lookup
        ),
      ),
    );
    const windows = new Map();
    targets.forEach((t, i) => {
      const windowId = located[i];
      if (windowId === undefined) return;
      const tabs = windows.get(windowId) ?? [];
      const openerPageId = openers.get(t.id) ?? t.openerId;
      tabs.push({ pageId: t.id, url: t.url, title: t.title, ...(openerPageId ? { openerPageId } : {}) });
      windows.set(windowId, tabs);
    });
    const staged = await stagedWindows().catch(() => new Set());
    return {
      windows: [...windows].map(([windowId, tabs]) => {
        tabs.sort(byBirth);
        // The tab the window shows: the one that came forward last, the newest if none was seen to.
        const shown = tabs.reduce((a, b) => (frontOf(b.pageId) >= frontOf(a.pageId) ? b : a));
        return { windowId, onStage: staged.has(windowId), tabs: tabs.map((t) => ({ ...t, active: t === shown })) };
      }),
    };
  },

  // Whether a tab's page still answers: a call that ran past its budget is either on a slow page or
  // on a frozen one, and the two call for opposite answers (wait, or close it).
  async probe(body) {
    const target = (await pageTargets()).find((t) => t.id === body.pageId);
    if (!target) return { open: false, responsive: false };
    return { open: true, responsive: await responsive(target), url: target.url };
  },

  async stage(body) {
    await ensureContext();
    await stage(Number(body.windowId));
    return {};
  },

  async input(body) {
    return input(body);
  },

  async go(body) {
    return go(body);
  },

  async "close-target"(body) {
    await closeTarget(String(body.pageId));
    return {};
  },

  async "close-window"(body) {
    const ctx = await ensureContext();
    const windowId = Number(body.windowId);
    for (const page of ctx.pages()) {
      const pageId = await adopt(page).catch(() => undefined);
      if (!pageId || (await windowOf(pageId).catch(() => undefined)) !== windowId) continue;
      await page.close().catch(() => undefined);
      dropPage(pageId);
    }
    return {};
  },

  // Reloads in place. A page the site re-renders on load (a dashboard that fetched stale state)
  // needs this more than a navigation, and there was no primitive for it: the agent wrote eval.
  async reload(body) {
    const page = await getPage(body.pageId);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("load", { timeout: 8000 }).catch(() => undefined);
    return { snapshot: await snapshotPage(page), url: page.url() };
  },

  async snapshot(body) {
    const snapshot = await snapshotPage(await getPage(body.pageId));
    if (!hasChooser(body.pageId)) return snapshot;
    return {
      ...snapshot,
      raw: `${snapshot.raw}\n\n[A file chooser is open on this page, waiting for a file: call browser_upload_file with the path.]`,
    };
  },

  // A request the PAGE makes, in the page's own context, so it carries the session's cookies
  // and obeys the same origin rules the site's scripts do. This is the one thing
  // responses/responseBody cannot do: they re-read what the page already fetched, never ask.
  async fetch(body) {
    const page = await getPage(body.pageId);
    const url = String(body.url ?? "");
    if (!url) throw new Error("fetch needs a url");
    const method = String(body.method ?? "GET").toUpperCase();
    const result = await page.evaluate(
      async ({ url, method, headers, payload }) => {
        const target = new URL(url, location.href).toString();
        const res = await fetch(target, {
          method,
          headers: headers ?? undefined,
          body: payload ?? undefined,
        });
        return {
          url: target,
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          body: await res.text(),
        };
      },
      { url, method, headers: body.headers ?? null, payload: body.body ?? null },
    );
    return { url: result.url, status: result.status, contentType: result.contentType, body: result.body };
  },

  // The visible text, which the accessibility tree does not carry and the agent otherwise
  // reaches for with a hand-rolled `document.body.innerText` through eval.
  async text(body) {
    const page = await getPage(body.pageId);
    const blocks = [];
    for (const frame of page.frames()) {
      const value = await frame
        .evaluate(() => (document.body ? document.body.innerText : ""))
        .catch(() => "");
      if (!value || !value.trim()) continue;
      blocks.push(frame === page.mainFrame() ? value : `[iframe ${frame.url().slice(0, 120)}]\n${value}`);
    }
    return { text: blocks.join("\n\n") };
  },

  // The JSON the page fetched for itself, listed newest first. Answers "where does this data
  // come from" without a single selector, which is the one strategy that survives a redesign.
  async responses(body) {
    const filter = body.filter ? String(body.filter).toLowerCase() : null;
    await getPage(body.pageId); // rejects an unknown or closed tab before reporting an empty log as fact
    const seen = recordedResponses(body.pageId);
    const matched = filter ? seen.filter((r) => r.url.toLowerCase().includes(filter)) : seen;
    return {
      total: seen.length,
      responses: matched
        .slice()
        .reverse()
        .map(({ id, url, status, type, method }) => ({ id, url, status, type, method })),
    };
  },

  // One recorded body, by the id `responses` gave. Read here rather than at capture time so a
  // body that the page has since discarded fails loudly on the call that wanted it.
  async responseBody(body) {
    await getPage(body.pageId);
    const record = recordedResponses(body.pageId).find((r) => r.id === Number(body.responseId));
    if (!record) throw new Error(`No recorded response ${body.responseId} on this page. Call responses first.`);
    let text;
    try {
      text = await record.handle.text();
    } catch (e) {
      throw new Error(`Response ${record.id} (${record.url}) is no longer readable: ${String(e)}`);
    }
    return { url: record.url, status: record.status, body: text };
  },

  // Grep over the snapshot the agent already reasons about. Without it, looking for one control
  // on a long page means pulling the whole tree again and paying for it in context.
  async find(body) {
    const query = String(body.query ?? "").toLowerCase();
    if (!query) throw new Error("find needs a query");
    const page = await getPage(body.pageId);
    const { raw } = await snapshotPage(page);
    const hits = raw.split("\n").filter((line) => line.toLowerCase().includes(query));
    return {
      query: body.query,
      matches: hits.length,
      lines: hits,
      url: page.url(),
    };
  },

  async click(body) {
    const { locator } = await resolveRef(await getPage(body.pageId), body.ref);
    await locator.click();
    return {};
  },

  async type(body) {
    const { locator } = await resolveRef(await getPage(body.pageId), body.ref);
    await locator.fill(body.text);
    return {};
  },

  async hover(body) {
    const { locator } = await resolveRef(await getPage(body.pageId), body.ref);
    await locator.hover();
    return {};
  },

  async drag(body) {
    const page = await getPage(body.pageId);
    const from = await resolveRef(page, body.fromRef);
    const to = await resolveRef(page, body.toRef);
    await from.locator.dragTo(to.locator);
    return {};
  },

  // Coordinates are FRACTIONS of the viewport, not pixels: screenshots are downscaled
  // before reaching the model, so pixel coordinates read off an image would land in the
  // wrong place. Fractions survive any resize.
  async "click-at"(body) {
    const page = await getPage(body.pageId);
    const x = Number(body.x);
    const y = Number(body.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
      throw new Error(`click-at expects fractions between 0 and 1, got x=${body.x} y=${body.y}.`);
    }
    const viewport =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
    const px = Math.round(x * viewport.width);
    const py = Math.round(y * viewport.height);
    await page.mouse.click(px, py);
    return { x: px, y: py, viewport };
  },

  async "wait-for"(body) {
    const page = await getPage(body.pageId);
    const timeout = Number(body.timeoutMs ?? 10000);
    if (body.text) {
      await page.getByText(String(body.text)).first().waitFor({ state: "visible", timeout });
      return { waited: "text" };
    }
    if (body.ref !== undefined && body.ref !== null) {
      const { locator } = await resolveRef(page, body.ref);
      await locator.waitFor({ state: "visible", timeout });
      return { waited: "ref" };
    }
    await page.waitForTimeout(timeout);
    return { waited: "delay" };
  },

  // Sites open uploads through a NATIVE OS file dialog, which DOM automation cannot touch.
  // Playwright can, three ways, tried in order of reliability. Note that a file input is
  // almost always hidden (opacity:0 / display:none), so it usually carries no ref at all —
  // hence ref is optional and the page-wide input lookup is the workhorse, not the fallback.
  async upload(body) {
    const page = await getPage(body.pageId);
    const paths = body.paths;
    const tried = [];

    const opened = takeChooser(body.pageId);
    if (opened) {
      await opened.setFiles(paths);
      return { via: "open-chooser" };
    }

    if (body.ref !== undefined && body.ref !== null) {
      const { locator: target } = await resolveRef(page, body.ref);
      const kind = await target
        .evaluate((el) => `${el.tagName.toLowerCase()}|${el.getAttribute("type") || ""}`)
        .catch(() => "");
      if (kind === "input|file") {
        await target.setInputFiles(paths);
        return { via: "ref-input" };
      }
      // The ref is a trigger (button/div): clicking it opens the native picker, which the
      // filechooser listener intercepts before the OS dialog ever becomes a problem.
      tried.push(`ref ${body.ref} is "${kind || "unknown"}", not a file input`);
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 8000 }),
          target.click(),
        ]);
        takeChooser(body.pageId); // the permanent listener saw the same chooser: it is answered
        await chooser.setFiles(paths);
        return { via: "filechooser" };
      } catch (e) {
        tried.push(`clicking it opened no file chooser (${e instanceof Error ? e.message : String(e)})`);
      }
    }

    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count();
    if (count === 0) {
      tried.push("no input[type=file] found in the page");
      throw new Error(`Upload failed. Tried: ${tried.join("; ")}.`);
    }
    await inputs.first().setInputFiles(paths);
    return { via: "page-input", fileInputs: count };
  },

  // Native <select> and custom comboboxes are two different problems wearing the same hat.
  async "select-option"(body) {
    const page = await getPage(body.pageId);
    const { locator: target, frame } = await resolveRef(page, body.ref);
    const value = String(body.value);
    const tag = await target.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");

    if (tag === "select") {
      try {
        await target.selectOption({ label: value });
      } catch {
        await target.selectOption(value);
      }
      return { via: "native-select" };
    }

    // Custom combobox: open it first. Options are searched page-wide because React renders
    // them in a portal at the end of <body>, not inside the trigger element.
    await target.click();
    await page.waitForTimeout(200);
    for (const role of ["option", "menuitemradio", "menuitemcheckbox", "menuitem", "treeitem"]) {
      for (const exact of [true, false]) {
        const candidate = frame.getByRole(role, { name: value, exact });
        if ((await candidate.count()) > 0) {
          await candidate.first().click();
          return { via: `role=${role}${exact ? "" : "~"}` };
        }
      }
    }
    const byText = frame.getByText(value, { exact: true });
    if ((await byText.count()) > 0) {
      await byText.first().click();
      return { via: "text" };
    }
    // Last rung: many comboboxes filter as you type and commit on Enter.
    await page.keyboard.type(value);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    return { via: "keyboard" };
  },

  async "press-key"(body) {
    const page = await getPage(body.pageId);
    if (body.ref !== undefined && body.ref !== null) {
      const { locator } = await resolveRef(page, body.ref);
      await locator.press(String(body.key));
    } else {
      await page.keyboard.press(String(body.key));
    }
    return {};
  },

  async scroll(body) {
    const page = await getPage(body.pageId);
    if (body.ref !== undefined && body.ref !== null) {
      const { locator } = await resolveRef(page, body.ref);
      await locator.scrollIntoViewIfNeeded();
    } else {
      const amount = Number(body.amount ?? 600);
      const dir = String(body.direction ?? "down");
      const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
      const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
      await page.mouse.wheel(dx, dy);
    }
    // Lazy-loaded lists render on scroll; snapshotting immediately would miss them.
    await page.waitForTimeout(300);
    return {};
  },

  async screenshot(body) {
    const page = await getPage(body.pageId);
    // Blank-screenshot guard: wait for the network to settle and give the compositor a
    // beat before capturing; both bounded so a busy page cannot stall the capture.
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    const path = screenshotPath();
    if (body.labels) {
      await injectRefLabels(page);
      // finally: if the screenshot throws, the red ref labels must not stay in the live page.
      try {
        await page.screenshot({ path, fullPage: body.fullPage });
      } finally {
        await removeRefLabels(page).catch(() => undefined);
      }
    } else {
      await page.screenshot({ path, fullPage: body.fullPage });
    }
    // The viewport travels with the shot so the agent can turn what it sees into
    // click-at fractions without guessing the page size.
    const viewport =
      page.viewportSize() ??
      (await page
        .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
        .catch(() => undefined));
    return { type: "image", path, mimeType: "image/png", viewport };
  },

  // Every tab, flat: the app's Browser page lists them. Agents read list-windows. Asked of the
  // browser for the same reason: a frozen tab must not freeze the page that shows it.
  async tabs() {
    const targets = await pageTargets();
    return { tabs: targets.sort(byBirth).map((t) => ({ id: t.id, url: t.url, title: t.title })) };
  },

  // Shows the tab in its window. Behind the focus lock: it moves what the next new tab opens after.
  async "focus-tab"(body) {
    const page = await getPage(body.pageId);
    await withFocus(() => page.bringToFront());
    markFront(String(body.pageId));
    return { pageId: body.pageId, url: page.url() };
  },

  async "close-tab"(body) {
    const page = await getPage(body.pageId);
    await page.close();
    dropPage(body.pageId);
    return {};
  },

  // --- low-level operations (gated on the Bun side by config) ---

  // The caller passes a statement body, not an expression, so `return` is required. Being
  // strict about it beats guessing between the two forms and silently returning undefined.
  async evaluate(body) {
    const page = await getPage(body.pageId);
    const value = await page.evaluate(`(async () => { ${body.js} })()`);
    return { value: JSON.stringify(value ?? null) };
  },

  // Raw CDP, inside the sidecar so it stays the single owner of the browser. The denylist is
  // enforced here as well as on the Bun side: no config value can open these up, because they
  // would hand the session's cookies, storage or other targets to whatever the page said.
  async cdp(body) {
    const method = String(body.method);
    if (CDP_DENIED.some((pattern) => pattern.test(method))) {
      throw new Error(`CDP method ${method} is permanently blocked (session credentials / other targets).`);
    }
    const page = await getPage(body.pageId);
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send(method, body.params ?? {});
      return { result: JSON.stringify(result ?? null) };
    } finally {
      await session.detach().catch(() => undefined);
    }
  },

  // Applies to the NEXT dialog on this page only; auto-accept resumes afterwards so an
  // unanswered native dialog can never freeze the page.
  async "handle-dialog"(body) {
    await getPage(body.pageId); // fail fast on an unknown page
    setDialogOverride(body.pageId, Boolean(body.accept), body.promptText);
    return { armed: true, accept: Boolean(body.accept) };
  },

  async "download-wait"(body) {
    await getPage(body.pageId); // fail fast: a stale pageId would otherwise burn the whole timeout
    const timeout = Number(body.timeoutMs ?? 30000);
    const deadline = Date.now() + timeout;
    let download = popDownload(body.pageId);
    while (!download && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      download = popDownload(body.pageId);
    }
    if (!download) throw new Error(`No download started within ${timeout}ms.`);
    const filename = download.suggestedFilename();
    await mkdir(body.dir, { recursive: true });
    const path = join(body.dir, filename);
    await download.saveAs(path);
    return { path, filename };
  },

  // page.pdf() is headless-only and this Chromium runs headful on Xvfb, so go through CDP.
  async pdf(body) {
    const page = await getPage(body.pageId);
    const session = await page.context().newCDPSession(page);
    try {
      const { data } = await session.send("Page.printToPDF", { printBackground: true });
      await mkdir(dirname(body.path), { recursive: true });
      await writeFile(body.path, Buffer.from(data, "base64"));
      return { path: body.path };
    } finally {
      await session.detach().catch(() => undefined);
    }
  },

  async health() {
    return { ok: true, connected: isConnected(), cdpUrl: CDP_URL };
  },
};
