// Operations exposed over HTTP. One export per endpoint name; the server only routes.
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CDP_URL,
  allPages,
  dropPage,
  ensureContext,
  existingIdForPage,
  getPage,
  getSession,
  idForPage,
  isConnected,
  popDownload,
  sessions,
  setDialogOverride,
} from "./browser.mjs";
import { injectRefLabels, removeRefLabels, resolveRef, screenshotPath, snapshotPage } from "./snapshot.mjs";

const MAX_LOW_LEVEL_OUTPUT = 20000;

// Hard floor, independent of config: these would expose the browser session's credentials
// (cookies, storage, auth headers via request interception) or let the agent escape its own
// page. A hostile page steering the agent must not be able to reach them.
const CDP_DENIED = [
  /^Browser\./i,
  /^Target\./i,
  /^Storage\./i,
  /^Security\./i,
  /^Fetch\./i,
  /^Network\.(setCookie|setCookies|getCookies|getAllCookies|clearBrowserCookies|setExtraHTTPHeaders)/i,
];

export const handlers = {
  async session(body) {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { viewport: body.viewport, currentPageId: null });
    return { sessionId };
  },

  // Reuses the given tab (reusePageId) unless newTab is set, so a task navigating
  // several times stays in ONE tab instead of spawning one per action.
  async navigate(body) {
    const session = getSession(body.sessionId);
    const ctx = await ensureContext(session.viewport);
    let page;
    const reuse = !body.newTab && body.reusePageId && allPages.get(body.reusePageId);
    if (reuse && !reuse.isClosed()) {
      page = reuse;
    } else {
      // Reuse target vanished (user closed the tab): open a fresh one rather than throwing.
      page = await ctx.newPage();
    }
    const pageId = idForPage(page); // registers close/dialog handlers on first sight
    session.currentPageId = pageId;
    await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // SPAs (Instagram, TikTok...) are still blank at domcontentloaded: give the JS a
    // chance to render before snapshotting, without hanging on never-idle pages.
    await page.waitForLoadState("load", { timeout: 8000 }).catch(() => undefined);
    return { pageId, snapshot: await snapshotPage(page), url: page.url() };
  },

  async snapshot(body) {
    return await snapshotPage(getPage(body.pageId));
  },

  async click(body) {
    const { locator } = await resolveRef(getPage(body.pageId), body.ref);
    await locator.click();
    return {};
  },

  async type(body) {
    const { locator } = await resolveRef(getPage(body.pageId), body.ref);
    await locator.fill(body.text);
    return {};
  },

  async hover(body) {
    const { locator } = await resolveRef(getPage(body.pageId), body.ref);
    await locator.hover();
    return {};
  },

  async drag(body) {
    const page = getPage(body.pageId);
    const from = await resolveRef(page, body.fromRef);
    const to = await resolveRef(page, body.toRef);
    await from.locator.dragTo(to.locator);
    return {};
  },

  // Coordinates are FRACTIONS of the viewport, not pixels: screenshots are downscaled
  // before reaching the model, so pixel coordinates read off an image would land in the
  // wrong place. Fractions survive any resize.
  async "click-at"(body) {
    const page = getPage(body.pageId);
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
    const page = getPage(body.pageId);
    const timeout = Math.min(Number(body.timeoutMs ?? 10000), 30000);
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
    const page = getPage(body.pageId);
    const paths = body.paths;
    const tried = [];

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
    const page = getPage(body.pageId);
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
    const page = getPage(body.pageId);
    if (body.ref !== undefined && body.ref !== null) {
      const { locator } = await resolveRef(page, body.ref);
      await locator.press(String(body.key));
    } else {
      await page.keyboard.press(String(body.key));
    }
    return {};
  },

  async scroll(body) {
    const page = getPage(body.pageId);
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
    const page = getPage(body.pageId);
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

  async tabs(body) {
    const ctx = await ensureContext(getSession(body.sessionId).viewport);
    const tabs = await Promise.all(
      ctx.pages().map(async (p, i) => ({
        id: String(i),
        url: p.url(),
        title: await p.title().catch(() => ""),
      })),
    );
    return { tabs };
  },

  async "focus-tab"(body) {
    const session = getSession(body.sessionId);
    const ctx = await ensureContext(session.viewport);
    const page = ctx.pages()[body.index];
    if (!page) throw new Error(`Tab ${body.index} not found.`);
    await page.bringToFront();
    const pageId = idForPage(page);
    session.currentPageId = pageId;
    return { pageId, url: page.url() };
  },

  async "close-tab"(body) {
    const ctx = await ensureContext(getSession(body.sessionId).viewport);
    const page = ctx.pages()[body.index];
    if (!page) throw new Error(`Tab ${body.index} not found.`);
    await page.close();
    const pageId = existingIdForPage(page);
    if (pageId) dropPage(pageId);
    return {};
  },

  // --- low-level operations (gated on the Bun side by config) ---

  // The caller passes a statement body, not an expression, so `return` is required. Being
  // strict about it beats guessing between the two forms and silently returning undefined.
  async evaluate(body) {
    const page = getPage(body.pageId);
    const value = await page.evaluate(`(async () => { ${body.js} })()`);
    const encoded = JSON.stringify(value ?? null);
    return {
      value: encoded.length > MAX_LOW_LEVEL_OUTPUT ? `${encoded.slice(0, MAX_LOW_LEVEL_OUTPUT)}...[truncated]` : encoded,
    };
  },

  // Raw CDP, inside the sidecar so it stays the single owner of the browser. The denylist is
  // enforced here as well as on the Bun side: no config value can open these up, because they
  // would hand the session's cookies, storage or other targets to whatever the page said.
  async cdp(body) {
    const method = String(body.method);
    if (CDP_DENIED.some((pattern) => pattern.test(method))) {
      throw new Error(`CDP method ${method} is permanently blocked (session credentials / other targets).`);
    }
    const page = getPage(body.pageId);
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send(method, body.params ?? {});
      const encoded = JSON.stringify(result ?? null);
      return {
        result: encoded.length > MAX_LOW_LEVEL_OUTPUT ? `${encoded.slice(0, MAX_LOW_LEVEL_OUTPUT)}...[truncated]` : encoded,
      };
    } finally {
      await session.detach().catch(() => undefined);
    }
  },

  // Applies to the NEXT dialog on this page only; auto-accept resumes afterwards so an
  // unanswered native dialog can never freeze the page.
  async "handle-dialog"(body) {
    getPage(body.pageId); // fail fast on an unknown page
    setDialogOverride(body.pageId, Boolean(body.accept), body.promptText);
    return { armed: true, accept: Boolean(body.accept) };
  },

  async "download-wait"(body) {
    getPage(body.pageId); // fail fast: a stale pageId would otherwise burn the whole timeout
    const timeout = Math.min(Number(body.timeoutMs ?? 30000), 120000);
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
    const page = getPage(body.pageId);
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

  // Ends the task's session bookkeeping only. Tabs are intentionally LEFT OPEN so
  // the shared browser persists for the next task/message; nothing is closed here.
  async cleanup(body) {
    sessions.delete(body.sessionId);
    return {};
  },

  async health() {
    return { ok: true, connected: isConnected(), cdpUrl: CDP_URL };
  },
};
