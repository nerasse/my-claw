// my-claw browser sidecar.
//
// WHY this exists: Playwright's chromium.connectOverCDP hangs forever under Bun
// (the app runtime), while it works under Node. This process owns ALL Playwright
// usage and runs under Node; the Bun app drives it over loopback HTTP. Playwright
// objects (Page/Context) never cross the process boundary — they are referenced by
// opaque string ids. Screenshots are written to /tmp (shared FS) and only the path
// is returned.
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 9223);
const HOST = process.env.HOST || "127.0.0.1";
const SCREENSHOT_DIR = "/tmp";

// --- shared CDP connection (one per process, reused across sessions) ---
let browser = null;
let connectPromise = null;

async function connect() {
  if (browser?.isConnected()) return browser;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
      browser.on("disconnected", () => {
        browser = null;
        sessions.clear();
        allPages.clear();
      });
      return browser;
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

let contextPromise = null;

async function ensureContext(viewport) {
  const b = await connect();
  const contexts = b.contexts();
  if (contexts.length > 0) {
    // Do NOT resize existing pages: they may be tabs the human is using in the shared browser.
    return contexts[0];
  }
  // Memoize like connect(): two concurrent callers must not each create a context (the loser leaks).
  if (contextPromise) return contextPromise;
  contextPromise = b.newContext({ viewport }).finally(() => { contextPromise = null; });
  return contextPromise;
}

// --- session + page registries ---
const sessions = new Map(); // sessionId -> { viewport, currentPageId }
const allPages = new Map(); // pageId -> Page
const pageToId = new WeakMap(); // Page -> pageId

// Tabs are NEVER auto-closed: the shared browser stays open so the user can keep
// working on the same tabs across tasks. Tabs only disappear on explicit close-tab
// (the agent "tidying up"), when the user closes them, or on a browser restart.

function idForPage(page) {
  let id = pageToId.get(page);
  if (!id) {
    id = crypto.randomUUID();
    pageToId.set(page, id);
    allPages.set(id, page);
    // Prune closed tabs (user-closed or crashed) so a stale handle isn't reused and misreported
    // as a sidecar outage; auto-accept dialogs on every adopted page, not just newly created ones.
    page.on("close", () => dropPage(id));
    page.on("dialog", (dialog) => void dialog.accept().catch(() => undefined));
  }
  return id;
}

function getPage(pageId) {
  const page = allPages.get(pageId);
  if (!page) throw new Error(`Unknown pageId: ${pageId}`);
  return page;
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`Unknown sessionId: ${sessionId}`);
  return s;
}

function dropPage(pageId) {
  const page = allPages.get(pageId);
  if (page) pageToId.delete(page);
  allPages.delete(pageId);
}

// --- snapshot helpers (ported from the Bun-side service) ---
function extractRefs(snapshot) {
  const refs = [];
  const regex = /\[__ref="(\d+)"\]/g;
  let match;
  while ((match = regex.exec(snapshot)) !== null) {
    refs.push(Number(match[1]));
  }
  return [...new Set(refs)].sort((a, b) => a - b);
}

const MAX_REFS = 400;

// Playwright's ariaSnapshot({ ref: true }) emits no usable ref markers in this
// build, so we assign our own: stamp every visible interactive element with a
// __ref attribute (clicked via [__ref="N"], also used by the label overlay) and
// list them. The aria tree is kept for readable page context.
async function snapshotPage(page) {
  const ariaTree = await page.locator("body").ariaSnapshot().catch(() => "");

  const interactive = await page.evaluate((max) => {
    // role=option/listbox/menuitemradio/treeitem are load-bearing: custom React
    // comboboxes render their options as plain divs carrying those roles. Without them
    // in this list the options appear in the aria tree but get no ref, so the agent can
    // see them and still be unable to click any of them.
    const SELECTOR = [
      "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
      "[role=button]", "[role=link]", "[role=textbox]", "[role=searchbox]",
      "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=listbox]",
      "[role=option]", "[role=menuitem]", "[role=menuitemcheckbox]",
      "[role=menuitemradio]", "[role=treeitem]", "[role=tab]", "[role=switch]",
      "[role=slider]", "[role=spinbutton]",
      "label", "summary", '[tabindex]:not([tabindex="-1"])',
      "[contenteditable='']", "[contenteditable=true]", "[onclick]",
    ].join(",");
    for (const el of Array.from(document.querySelectorAll("[__ref]"))) {
      el.removeAttribute("__ref");
    }
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const inViewport =
        rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
      candidates.push({ el, inViewport });
    }
    // Viewport-first: the ref budget is capped, so off-screen page chrome (footers, hidden
    // menus) must never consume the budget before the element the agent is looking at.
    const ordered = [
      ...candidates.filter((c) => c.inViewport),
      ...candidates.filter((c) => !c.inViewport),
    ];
    const lines = [];
    let ref = 0;
    for (const { el, inViewport } of ordered) {
      if (ref >= max) break;
      ref += 1;
      el.setAttribute("__ref", String(ref));
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name = (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        (typeof el.value === "string" ? el.value : "") ||
        el.innerText ||
        el.getAttribute("title") ||
        el.getAttribute("name") ||
        ""
      ).replace(/\s+/g, " ").trim().slice(0, 80);
      lines.push(`[__ref="${ref}"] ${role} "${name}"${inViewport ? "" : " (offscreen — scroll to reach)"}`);
    }
    return lines.join("\n");
  }, MAX_REFS);

  const raw = interactive
    ? `${ariaTree}\n\nInteractive elements (click/type by ref):\n${interactive}`
    : ariaTree;
  return { raw, refs: extractRefs(raw) };
}

async function injectRefLabels(page) {
  await page.evaluate(() => {
    const elements = document.querySelectorAll("[__ref]");
    for (const el of Array.from(elements)) {
      const ref = el.getAttribute("__ref");
      if (!ref) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const label = document.createElement("div");
      label.textContent = ref;
      label.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;background:rgba(255,0,0,0.8);color:white;font-size:12px;font-weight:bold;padding:2px 6px;border-radius:3px;z-index:999999;pointer-events:none;font-family:monospace;`;
      label.setAttribute("data-my-claw-label", ref);
      document.body.appendChild(label);
    }
  });
}

async function removeRefLabels(page) {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("[data-my-claw-label]"))) {
      el.remove();
    }
  });
}

function screenshotPath() {
  return `${SCREENSHOT_DIR}/browser-${crypto.randomUUID()}.png`;
}

// --- operations (mirror the Bun-side BrowserService API) ---
const handlers = {
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
    const pageId = pageToId.get(page);
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
    return { ok: true, connected: browser?.isConnected() ?? false, cdpUrl: CDP_URL };
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${String(e)}`));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "").replace(/^\//, "").split("?")[0];
  const handler = handlers[path];
  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Unknown endpoint: ${path}` }));
    return;
  }
  try {
    const body = req.method === "GET" ? {} : await readBody(req);
    const result = await handler(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result ?? {}));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
  }
});

// A stray rejection from playwright-core internals must not kill the sidecar (Restart=always
// would then flap it); log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[sidecar] unhandled rejection:", reason);
});

server.on("error", (err) => {
  console.error("[sidecar] server error:", err);
  if (err && err.code === "EADDRINUSE") {
    console.error(`[sidecar] ${HOST}:${PORT} already in use (stale sidecar?) — exiting.`);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`my-claw browser sidecar listening on http://${HOST}:${PORT} (CDP ${CDP_URL})`);
});
