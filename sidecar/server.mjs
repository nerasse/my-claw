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
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 300000);
const SCREENSHOT_DIR = "/tmp";
const SCROLL_AMOUNT = 500;

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
        lastActive.clear();
      });
      return browser;
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

async function ensureContext(viewport) {
  const b = await connect();
  const contexts = b.contexts();
  if (contexts.length > 0) {
    const ctx = contexts[0];
    if (viewport) {
      for (const p of ctx.pages()) {
        await p.setViewportSize(viewport).catch(() => undefined);
      }
    }
    return ctx;
  }
  return b.newContext({ viewport });
}

// --- session + page registries ---
const sessions = new Map(); // sessionId -> { viewport, ownPageIds: Set<string> }
const allPages = new Map(); // pageId -> Page
const pageToId = new WeakMap(); // Page -> pageId
const lastActive = new Map(); // pageId -> timestamp

function idForPage(page) {
  let id = pageToId.get(page);
  if (!id) {
    id = crypto.randomUUID();
    pageToId.set(page, id);
    allPages.set(id, page);
  }
  lastActive.set(id, Date.now());
  return id;
}

function getPage(pageId) {
  const page = allPages.get(pageId);
  if (!page) throw new Error(`Unknown pageId: ${pageId}`);
  lastActive.set(pageId, Date.now());
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
  lastActive.delete(pageId);
}

// Close pages idle beyond the timeout (safety net; tasks also clean up explicitly).
setInterval(() => {
  const now = Date.now();
  for (const [pageId, ts] of lastActive) {
    if (now - ts > IDLE_TIMEOUT_MS) {
      const page = allPages.get(pageId);
      if (page) page.close().catch(() => undefined);
      dropPage(pageId);
      for (const s of sessions.values()) s.ownPageIds.delete(pageId);
    }
  }
}, 60000).unref();

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

const MAX_REFS = 200;

// Playwright's ariaSnapshot({ ref: true }) emits no usable ref markers in this
// build, so we assign our own: stamp every visible interactive element with a
// __ref attribute (clicked via [__ref="N"], also used by the label overlay) and
// list them. The aria tree is kept for readable page context.
async function snapshotPage(page) {
  const ariaTree = await page.locator("body").ariaSnapshot().catch(() => "");

  const interactive = await page.evaluate((max) => {
    const SELECTOR = [
      "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
      "[role=button]", "[role=link]", "[role=textbox]", "[role=checkbox]",
      "[role=radio]", "[role=combobox]", "[role=menuitem]", "[role=tab]",
      "[role=switch]", "[contenteditable='']", "[contenteditable=true]", "[onclick]",
    ].join(",");
    for (const el of Array.from(document.querySelectorAll("[__ref]"))) {
      el.removeAttribute("__ref");
    }
    const lines = [];
    let ref = 0;
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (ref >= max) break;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
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
      lines.push(`[__ref="${ref}"] ${role} "${name}"`);
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
    sessions.set(sessionId, { viewport: body.viewport, ownPageIds: new Set() });
    return { sessionId };
  },

  async navigate(body) {
    const session = getSession(body.sessionId);
    const ctx = await ensureContext(session.viewport);
    const page = await ctx.newPage();
    const pageId = idForPage(page);
    session.ownPageIds.add(pageId);
    page.on("dialog", (dialog) => void dialog.accept().catch(() => undefined));
    await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30000 });
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
    const path = screenshotPath();
    if (body.labels) {
      await injectRefLabels(page);
      await page.screenshot({ path, fullPage: body.fullPage });
      await removeRefLabels(page);
    } else {
      await page.screenshot({ path, fullPage: body.fullPage });
    }
    return { type: "image", path, mimeType: "image/png" };
  },

  async scroll(body) {
    const amount = body.direction === "up" ? -SCROLL_AMOUNT : SCROLL_AMOUNT;
    await getPage(body.pageId).evaluate(`window.scrollBy(0, ${amount})`);
    return {};
  },

  async back(body) {
    await getPage(body.pageId).goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    return {};
  },

  async tabs(body) {
    const ctx = await ensureContext(getSession(body.sessionId).viewport);
    return {
      tabs: ctx.pages().map((p, i) => ({ id: String(i), url: p.url(), title: "" })),
    };
  },

  async "focus-tab"(body) {
    const ctx = await ensureContext(getSession(body.sessionId).viewport);
    const page = ctx.pages()[body.index];
    if (!page) throw new Error(`Tab ${body.index} not found.`);
    await page.bringToFront();
    return { pageId: idForPage(page), url: page.url() };
  },

  async "close-tab"(body) {
    const ctx = await ensureContext(getSession(body.sessionId).viewport);
    const page = ctx.pages()[body.index];
    if (!page) throw new Error(`Tab ${body.index} not found.`);
    await page.close();
    const pageId = pageToId.get(page);
    if (pageId) {
      dropPage(pageId);
      getSession(body.sessionId).ownPageIds.delete(pageId);
    }
    return {};
  },

  // Close only the pages this session opened; never touches the shared CDP
  // connection (it is reused across tasks and backs the external Chromium).
  async cleanup(body) {
    const session = sessions.get(body.sessionId);
    if (session) {
      for (const pageId of session.ownPageIds) {
        const page = allPages.get(pageId);
        if (page) await page.close().catch(() => undefined);
        dropPage(pageId);
      }
      sessions.delete(body.sessionId);
    }
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

server.listen(PORT, HOST, () => {
  console.log(`my-claw browser sidecar listening on http://${HOST}:${PORT} (CDP ${CDP_URL})`);
});
