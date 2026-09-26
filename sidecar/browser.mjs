// Shared CDP connection, context, and the page registry.
//
// WHY a single connection: connectOverCDP attaches to an EXTERNAL Chromium managed by
// systemd. browser.close() would kill it, so it is never called; on "disconnected" the
// state resets and the next task reconnects.
//
// Pages are named by their CDP targetId and windows by their CDP window id, so both survive a
// restart of this process: the server keeps which run holds which window (docs/browser-windows.md).
import { chromium } from "playwright-core";
// Node 20 has no global WebSocket, and the probe below must reach a page without Playwright: the
// socket Playwright itself ships is the one already installed.
import { ws as WebSocket } from "playwright-core/lib/utilsBundle";

export const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";

let browser = null;
let connectPromise = null;
let browserCdp = null;

export const allPages = new Map(); // pageId (targetId) -> Page
const adoption = new WeakMap(); // Page -> Promise<pageId>
const idByPage = new WeakMap(); // Page -> pageId, once adopted
const watchedContexts = new WeakSet();

// Pages whose next dialog must NOT be auto-accepted, so an agent can answer a prompt()
// or dismiss a confirm() deliberately. Auto-accept stays the default: an unanswered
// native dialog blocks the whole page indefinitely.
const dialogOverrides = new Map(); // pageId -> { accept, promptText }

// Downloads are queued as they happen: an agent typically clicks first and only then asks
// for the file, so waiting on the event alone would miss downloads already completed.
const pendingDownloads = new Map(); // pageId -> Download[]

// A native file chooser a click opened. Without a listener Chromium shows GTK's "Open File"
// window, whose modal grab freezes every click on the display (2026-09-21, src/browser/unblock.ts)
// and, with runs in parallel, every run at once. With one, Playwright intercepts it: it is kept
// here until browser_upload_file hands it the files.
const pendingChoosers = new Map(); // pageId -> FileChooser

// What the page fetched, newest last. An SPA renders from JSON its own scripts asked for, so
// the data an agent wants is usually one response away, already parsed and stable, while the
// DOM holding it is virtualised and renamed at every deploy. Recorded passively for every page:
// an agent that has to arm a listener before acting has already missed the response it wanted.
const pageResponses = new Map(); // pageId -> ResponseRecord[]

// Only what an agent can actually read. Documents, media, fonts and styles are noise here, and
// keeping their handles alive would pin their buffers in memory for the life of the tab.
const RECORDED_TYPES = /^(application\/(json|.*\+json)|text\/(plain|csv))/i;

export function recordedResponses(pageId) {
  return pageResponses.get(pageId) ?? [];
}

export function forgetResponses(pageId) {
  pageResponses.delete(pageId);
}

export function popDownload(pageId) {
  const queue = pendingDownloads.get(pageId);
  return queue?.length ? queue.shift() : null;
}

export function takeChooser(pageId) {
  const chooser = pendingChoosers.get(pageId);
  pendingChoosers.delete(pageId);
  return chooser ?? null;
}

export function hasChooser(pageId) {
  return pendingChoosers.has(pageId);
}

export function isConnected() {
  return browser?.isConnected() ?? false;
}

// connectOverCDP attaches to every tab, and a tab whose renderer is stuck in its own JavaScript
// never answers the attach: the connection waits for it forever (measured 2026-09-26). The wait is
// bounded for each caller and reported with the frozen tabs, which the server may close; the
// attempt itself stays pending, and completes the moment they are gone.
const CONNECT_BUDGET_MS = 10000;

export async function connect() {
  if (browser?.isConnected()) return browser;
  const attempt = connectPromise ?? startConnect();
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(resolve, CONNECT_BUDGET_MS, null);
  });
  const connected = await Promise.race([attempt, budget]).finally(() => clearTimeout(timer));
  if (connected) return connected;
  const frozen = await frozenPages();
  throw Object.assign(
    new Error(
      frozen.length > 0
        ? `The browser cannot be reached while ${frozen.length} of its tabs is frozen: ${frozen.map((t) => t.url).join(", ")}`
        : "The browser did not answer the connection in time.",
    ),
    { frozen },
  );
}

function startConnect() {
  connectPromise = (async () => {
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
      browser.on("disconnected", () => {
        browser = null;
        browserCdp = null;
        allPages.clear();
      });
      return browser;
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

const PROBE_MS = 3000;

// The order tabs were first seen in, which is the order a window numbers them: the browser's own
// list reorders on every activation, and a number an agent read must still name the same tab.
const births = new Map(); // pageId -> seq
let born = 0;

export function birthOf(pageId) {
  if (!births.has(pageId)) births.set(pageId, ++born);
  return births.get(pageId);
}

/** Every tab, as the browser itself reports it: no tab is asked anything. */
export async function pageTargets() {
  const res = await fetch(`${CDP_URL}/json/list`);
  const targets = await res.json();
  return targets.filter((t) => t.type === "page");
}

/**
 * Whether the tab's page still runs JavaScript. A page stuck in a loop of its own answers nothing
 * a tool sends it, its title included, for as long as it lives; its browser process still answers
 * for it. Asked over a socket of its own, so neither a Playwright session nor its attach is needed.
 */
export function responsive(target) {
  return new Promise((resolve) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const done = (alive) => {
      clearTimeout(timer);
      socket.terminate();
      resolve(alive);
    };
    const timer = setTimeout(done, PROBE_MS, false);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1" } })));
    socket.on("message", (data) => {
      if (JSON.parse(String(data)).id === 1) done(true);
    });
    socket.on("error", () => done(false));
  });
}

export async function frozenPages() {
  const targets = await pageTargets();
  const alive = await Promise.all(targets.map((t) => responsive(t)));
  return targets.filter((_, i) => !alive[i]).map((t) => ({ pageId: t.id, url: t.url, title: t.title }));
}

/**
 * Closes a tab through the browser, which works when its page answers nothing and before any
 * connection exists. A frozen tab lingers about half a second while the browser gives up on its
 * renderer (measured 520-550 ms), so this waits for it to be gone: "closed" has to be true when the
 * run is told so, and the next listing must not show it.
 */
export async function closeTarget(pageId) {
  await fetch(`${CDP_URL}/json/close/${pageId}`);
  dropPage(pageId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await pageTargets()).some((t) => t.id === pageId)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let contextPromise = null;

export async function ensureContext(viewport) {
  const b = await connect();
  const contexts = b.contexts();
  // Do NOT resize existing pages: they may be tabs the human is using in the shared browser.
  const ctx =
    contexts[0] ??
    (await (contextPromise ??= b.newContext({ viewport }).finally(() => {
      // Memoized like connect(): two concurrent callers must not each create a context.
      contextPromise = null;
    })));
  if (!watchedContexts.has(ctx)) {
    watchedContexts.add(ctx);
    // Adopted as soon as they exist, popups included: the file chooser listener has to be on a
    // page before anything clicks in it, and a popup's opener has to be known to hand it to the
    // run that caused it.
    ctx.on("page", (page) => void adopt(page).catch(() => undefined));
    await Promise.all(ctx.pages().map((page) => adopt(page).catch(() => undefined)));
  }
  return ctx;
}

/** The browser-level CDP session: windows are a browser concept, not a page one. */
export async function browserSession() {
  const b = await connect();
  browserCdp ??= b.newBrowserCDPSession();
  return browserCdp;
}

export async function windowOf(pageId) {
  const cdp = await browserSession();
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: pageId });
  return windowId;
}

// bringToFront moves the focus the next Target.createTarget opens its tab after, so the two are
// one step for anyone else who moves it (docs/browser-windows.md).
let focusQueue = Promise.resolve();

export function withFocus(step) {
  const result = focusQueue.then(step, step);
  focusQueue = result.catch(() => undefined);
  return result;
}

/** The page CDP created for `targetId`, once the context has reported it. */
export async function pageForTarget(ctx, targetId) {
  for (let i = 0; i < 200; i++) {
    const known = allPages.get(targetId);
    if (known) return known;
    await Promise.all(ctx.pages().map((page) => adopt(page).catch(() => undefined)));
    if (allPages.has(targetId)) return allPages.get(targetId);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The browser never reported the page it opened (${targetId}).`);
}

/** The id of a page, registering it on first sight: close pruning, dialogs, downloads, choosers. */
export function adopt(page) {
  let pending = adoption.get(page);
  if (pending) return pending;
  pending = (async () => {
    const session = await page.context().newCDPSession(page);
    let id;
    try {
      id = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
    } finally {
      // Not awaited: a frozen page never acknowledges the detach, and every adoption that waited on
      // it (a new tab, a listing) waited forever with it.
      void session.detach().catch(() => undefined);
    }
    idByPage.set(page, id);
    allPages.set(id, page);
    birthOf(id);
    // Prune closed tabs (user-closed or crashed) so a stale handle isn't reused and misreported
    // as a sidecar outage; auto-accept dialogs on every adopted page, not just newly created ones.
    page.on("close", () => dropPage(id));
    page.on("dialog", (dialog) => {
      const override = dialogOverrides.get(id);
      if (override) {
        dialogOverrides.delete(id);
        const action = override.accept
          ? dialog.accept(override.promptText ?? undefined)
          : dialog.dismiss();
        void action.catch(() => undefined);
        return;
      }
      void dialog.accept().catch(() => undefined);
    });
    page.on("filechooser", (chooser) => {
      pendingChoosers.set(id, chooser);
    });
    page.on("download", (download) => {
      const queue = pendingDownloads.get(id) ?? [];
      queue.push(download);
      pendingDownloads.set(id, queue);
    });
    page.on("response", (response) => {
      const type = response.headers()["content-type"] ?? "";
      if (!RECORDED_TYPES.test(type)) return;
      const log = pageResponses.get(id) ?? [];
      // The body is not read here: awaiting it inside the event handler would race the next
      // navigation, which disposes the response and rejects the read. The handle is kept and
      // the body is pulled on demand, where a failure can be reported to the caller.
      log.push({
        id: log.length ? log[log.length - 1].id + 1 : 1,
        url: response.url(),
        status: response.status(),
        type,
        method: response.request().method(),
        handle: response,
      });
      pageResponses.set(id, log);
    });
    return id;
  })();
  adoption.set(page, pending);
  pending.catch(() => adoption.delete(page));
  return pending;
}

/** The id of an adopted page, or undefined: used for openers, which may predate us. */
export function idOf(page) {
  return idByPage.get(page);
}

export function setDialogOverride(pageId, accept, promptText) {
  dialogOverrides.set(pageId, { accept, promptText });
}

/** The page for an id. One unknown to this process may still be open: after a restart of the
 *  sidecar the tabs are adopted again before the id is declared gone. */
export async function getPage(pageId) {
  let page = allPages.get(pageId);
  if (!page) {
    await ensureContext();
    page = allPages.get(pageId);
  }
  if (!page) throw new Error(`Unknown pageId: ${pageId}. The tab is gone: browser_list_windows shows what is open.`);
  return page;
}

export function dropPage(pageId) {
  allPages.delete(pageId);
  births.delete(pageId);
  dialogOverrides.delete(pageId);
  pendingDownloads.delete(pageId);
  pendingChoosers.delete(pageId);
  pageResponses.delete(pageId);
}
