// Operations exposed over HTTP. One export per endpoint name; the server only routes.
import crypto from "node:crypto";
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
  sessions,
} from "./browser.mjs";
import { injectRefLabels, removeRefLabels, screenshotPath, snapshotPage } from "./snapshot.mjs";

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
    await getPage(body.pageId).locator(`[__ref="${body.ref}"]`).click();
    return {};
  },

  async type(body) {
    await getPage(body.pageId).locator(`[__ref="${body.ref}"]`).fill(body.text);
    return {};
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
      const target = page.locator(`[__ref="${body.ref}"]`);
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
    const target = page.locator(`[__ref="${body.ref}"]`);
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
        const candidate = page.getByRole(role, { name: value, exact });
        if ((await candidate.count()) > 0) {
          await candidate.first().click();
          return { via: `role=${role}${exact ? "" : "~"}` };
        }
      }
    }
    const byText = page.getByText(value, { exact: true });
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
      await page.locator(`[__ref="${body.ref}"]`).press(String(body.key));
    } else {
      await page.keyboard.press(String(body.key));
    }
    return {};
  },

  async scroll(body) {
    const page = getPage(body.pageId);
    if (body.ref !== undefined && body.ref !== null) {
      await page.locator(`[__ref="${body.ref}"]`).scrollIntoViewIfNeeded();
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
    return { type: "image", path, mimeType: "image/png" };
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
