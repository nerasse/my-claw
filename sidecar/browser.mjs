// Shared CDP connection, context, and the page registry.
//
// WHY a single connection: connectOverCDP attaches to an EXTERNAL Chromium managed by
// systemd. browser.close() would kill it, so it is never called; on "disconnected" the
// state resets and the next task reconnects.
//
// Pages are named by their CDP targetId and windows by their CDP window id, so both survive a
// restart of this process: the server keeps which run holds which window (docs/browser-windows.md).
import { chromium } from "playwright-core";

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
const RESPONSE_LOG_MAX = 150;
const RESPONSE_BODY_MAX = 400000;

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

export { RESPONSE_BODY_MAX };

export function isConnected() {
  return browser?.isConnected() ?? false;
}

export async function connect() {
  if (browser?.isConnected()) return browser;
  if (connectPromise) return connectPromise;
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
      await session.detach().catch(() => undefined);
    }
    idByPage.set(page, id);
    allPages.set(id, page);
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
      if (log.length > RESPONSE_LOG_MAX) log.splice(0, log.length - RESPONSE_LOG_MAX);
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
  dialogOverrides.delete(pageId);
  pendingDownloads.delete(pageId);
  pendingChoosers.delete(pageId);
  pageResponses.delete(pageId);
}
