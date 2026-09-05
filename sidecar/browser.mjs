// Shared CDP connection, context, and the session/page registries.
//
// WHY a single connection: connectOverCDP attaches to an EXTERNAL Chromium managed by
// systemd. browser.close() would kill it, so it is never called; on "disconnected" the
// state resets and the next task reconnects.
import crypto from "node:crypto";
import { chromium } from "playwright-core";

export const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";

let browser = null;
let connectPromise = null;

export const sessions = new Map(); // sessionId -> { viewport, currentPageId }
export const allPages = new Map(); // pageId -> Page
const pageToId = new WeakMap(); // Page -> pageId

// Pages whose next dialog must NOT be auto-accepted, so an agent can answer a prompt()
// or dismiss a confirm() deliberately. Auto-accept stays the default: an unanswered
// native dialog blocks the whole page indefinitely.
const dialogOverrides = new Map(); // pageId -> { accept, promptText }

// Downloads are queued as they happen: an agent typically clicks first and only then asks
// for the file, so waiting on the event alone would miss downloads already completed.
const pendingDownloads = new Map(); // pageId -> Download[]

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

export async function ensureContext(viewport) {
  const b = await connect();
  const contexts = b.contexts();
  if (contexts.length > 0) {
    // Do NOT resize existing pages: they may be tabs the human is using in the shared browser.
    return contexts[0];
  }
  // Memoize like connect(): two concurrent callers must not each create a context (the loser leaks).
  if (contextPromise) return contextPromise;
  contextPromise = b.newContext({ viewport }).finally(() => {
    contextPromise = null;
  });
  return contextPromise;
}

// Tabs are NEVER auto-closed: the shared browser stays open so the user can keep
// working on the same tabs across tasks. Tabs only disappear on explicit close-tab
// (the agent "tidying up"), when the user closes them, or on a browser restart.

export function idForPage(page) {
  let id = pageToId.get(page);
  if (!id) {
    id = crypto.randomUUID();
    pageToId.set(page, id);
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
  }
  return id;
}

export function setDialogOverride(pageId, accept, promptText) {
  dialogOverrides.set(pageId, { accept, promptText });
}

/** Id of an already-adopted page, without adopting it. Used by close-tab, which holds a
 *  Page and needs its id to prune the registry. */
export function existingIdForPage(page) {
  return pageToId.get(page);
}

export function getPage(pageId) {
  const page = allPages.get(pageId);
  if (!page) throw new Error(`Unknown pageId: ${pageId}`);
  return page;
}

export function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`Unknown sessionId: ${sessionId}`);
  return s;
}

export function dropPage(pageId) {
  const page = allPages.get(pageId);
  if (page) pageToId.delete(page);
  allPages.delete(pageId);
  dialogOverrides.delete(pageId);
  pendingDownloads.delete(pageId);
  pageResponses.delete(pageId);
}
