// What a human sees of the browser and does in it: the one window on the VNC screen, the live
// pictures of every window, and the owner's own clicks and keys -- docs/browser-live.md.
import { browserSession, frontOf, getPage, idOf, pageHooks, pageTargets, windowOf } from "./browser.mjs";

// The X screen the VNC server shows. One window stands on it; every other one is parked to its
// right, off the screen, where it renders, animates and takes input exactly as on it (measured on
// Chromium 147 without a window manager: 61 frames/s, clicks and screenshots unchanged).
export const STAGE = {
  width: Number(process.env.STAGE_WIDTH || 1920),
  height: Number(process.env.STAGE_HEIGHT || 1080),
};
const OFFSTAGE_LEFT = STAGE.width + 2000;

/**
 * The size every window works at: what the server asks for a new window (the config's `viewport`),
 * the screen's until it asks. One shape for every window is what makes the wall a grid -- a window
 * keeps the size it is born with, so a site's own `window.open(..., "width=500,height=600")` would
 * leave one window, and its tile, that shape for the rest of its life (docs/browser-live.md).
 */
let windowSize = { width: STAGE.width, height: STAGE.height };

/** The standard size, taken from what the server asked for a new window; returns it. */
export function standardSize(viewport) {
  const width = Math.round(Number(viewport?.width));
  const height = Math.round(Number(viewport?.height));
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) windowSize = { width, height };
  return windowSize;
}

/**
 * Chromium without a window manager gives a window one pixel less than it was asked for on each
 * axis once it fills the screen (measured on Chromium 147: 1919x1079 for 1920x1080, and exactly
 * what was asked below the screen's size). A window is at the standard size within a pixel.
 */
function atSize(bounds) {
  return Math.abs(bounds.width - windowSize.width) <= 1 && Math.abs(bounds.height - windowSize.height) <= 1;
}

async function boundsOf(windowId) {
  const cdp = await browserSession();
  return (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;
}

function onStage(bounds) {
  return bounds.windowState !== "minimized" && bounds.left < STAGE.width && bounds.left + bounds.width > 0 && bounds.top < STAGE.height;
}

/** Every window, from the browser's own list: no page is asked anything (a frozen one answers nothing). */
async function windowIds() {
  const targets = await pageTargets();
  const cdp = await browserSession();
  const ids = await Promise.all(
    targets.map((t) => cdp.send("Browser.getWindowForTarget", { targetId: t.id }).then((r) => r.windowId, () => undefined)),
  );
  return [...new Set(ids.filter((id) => id !== undefined))];
}

async function place(windowId, bounds) {
  const cdp = await browserSession();
  const current = await boundsOf(windowId);
  // A maximized or minimized window refuses a position until it is a normal one again.
  if (current.windowState !== "normal") await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds });
}

async function windowBounds() {
  const ids = await windowIds();
  const bounds = await Promise.all(ids.map((id) => boundsOf(id).catch(() => undefined)));
  return ids.flatMap((windowId, i) => (bounds[i] ? [{ windowId, bounds: bounds[i] }] : []));
}

export async function stagedWindows() {
  return new Set((await windowBounds()).filter(({ bounds }) => onStage(bounds)).map(({ windowId }) => windowId));
}

/**
 * Window placement is a read-then-write on the browser's own bounds, and two of them interleaved (a
 * listing putting a window back at the standard size while the owner stages another) leave two
 * windows on the screen. One queue, as for the focus.
 */
let placementQueue = Promise.resolve();

function withPlacement(step) {
  const result = placementQueue.then(step, step);
  placementQueue = result.catch(() => undefined);
  return result;
}

/**
 * Every window took the standard size once, at birth. A window the owner resizes by hand in VNC is
 * left as he left it: the wall follows the page, it does not overrule the person in front of it.
 */
const settled = new Set();

/**
 * Every window at the standard size, and the ids of the ones standing on the screen.
 *
 * Run with every listing, which reads every window's bounds anyway, so a window that was already
 * open when this rule arrived (or that the browser resized after its birth hook) is put right here.
 * A minimized window keeps stale bounds and is left alone; the ids are pruned to the windows that
 * still exist, which is what keeps this set from growing with the browser's history.
 */
export async function settleWindows() {
  return withPlacement(async () => {
    const windows = await windowBounds();
    const alive = new Set(windows.map(({ windowId }) => windowId));
    for (const windowId of settled) if (!alive.has(windowId)) settled.delete(windowId);
    await Promise.all(
      windows.map(({ windowId, bounds }) => {
        if (bounds.windowState !== "normal") return undefined;
        if (atSize(bounds)) return void settled.add(windowId);
        if (settled.has(windowId)) return undefined;
        settled.add(windowId);
        return place(windowId, onStage(bounds) ? { left: 0, top: 0, ...windowSize } : { ...OFFSTAGE, ...windowSize }).catch(
          () => undefined,
        );
      }),
    );
    return new Set(windows.filter(({ bounds }) => onStage(bounds)).map(({ windowId }) => windowId));
  });
}

/** Puts one window on the VNC screen and every other one off it. */
export async function stage(windowId) {
  return withPlacement(() => stageNow(windowId));
}

async function stageNow(windowId) {
  const ids = await windowIds();
  if (!ids.includes(windowId)) throw new Error(`There is no window ${windowId} in the browser.`);
  for (const id of ids) {
    if (id === windowId) continue;
    const bounds = await boundsOf(id).catch(() => undefined);
    if (bounds && onStage(bounds)) await place(id, { ...OFFSTAGE, ...windowSize });
  }
  await place(windowId, { left: 0, top: 0, ...windowSize });
}

export const OFFSTAGE = { left: OFFSTAGE_LEFT, top: 0 };

/**
 * A window a site just opened lands where the browser puts new windows, on the screen, over the
 * window a human may be working in. It is moved off unless it belongs there: its opener is the
 * window on the screen (a "sign in with" popup during a captcha), or the screen was empty. Either
 * way it takes the standard size, which is the whole point of this hook: a popup opened at the
 * size its site asked for would keep it, and its tile with it, until it closes.
 *
 * A tab born in a window already off the screen is the common case (`target=_blank`, a plain
 * `window.open`): that window is left where it stands.
 */
export async function keepOffStage(page, pageId) {
  return withPlacement(() => keepOffStageNow(page, pageId));
}

async function keepOffStageNow(page, pageId) {
  const windowId = await windowOf(pageId);
  const bounds = await boundsOf(windowId);
  if (!onStage(bounds)) {
    if (bounds.windowState === "normal" && !atSize(bounds)) {
      settled.add(windowId);
      await place(windowId, { ...OFFSTAGE, ...windowSize });
    }
    return;
  }
  const staged = await stagedWindows();
  staged.delete(windowId);
  if (staged.size > 0) {
    const opener = await page.opener().catch(() => null);
    const openerId = opener ? idOf(opener) : undefined;
    const openerWindow = openerId ? await windowOf(openerId).catch(() => undefined) : undefined;
    const forOwner = openerWindow !== undefined && (openerWindow === windowId || staged.has(openerWindow));
    if (!forOwner) return void (await place(windowId, { ...OFFSTAGE, ...windowSize }));
  }
  // It belongs on the screen (the screen was empty, or the owner is working there): it stands at the
  // screen's size rather than over the owner at some size of the site's choosing.
  settled.add(windowId);
  await place(windowId, { left: 0, top: 0, ...windowSize });
}

/** The screen went empty (its window closed): the window worked in last takes it. */
export async function refillStage() {
  return withPlacement(async () => {
    if ((await stagedWindows()).size > 0) return;
    const targets = await pageTargets();
    if (targets.length === 0) return;
    const latest = targets.reduce((a, b) => (frontOf(b.id) > frontOf(a.id) ? b : a));
    await stageNow(await windowOf(latest.id));
  });
}

// --- live pictures ---------------------------------------------------------------------------

// The last picture's geometry per tab: a tap arrives as a fraction of the picture the owner saw,
// and becomes page coordinates through it.
const geometry = new Map(); // pageId -> { width, height }

export function forgetLive(pageId) {
  geometry.delete(pageId);
}

/**
 * The pictures one watcher asked for. Chromium sends a frame when the page paints, and the next
 * one only once the last is acknowledged: holding the acknowledgement is what sets the rate, and a
 * page that does not change sends nothing at all. Starting on a frozen page never returns, which
 * stalls that stream and no other.
 */
export class Screencasts {
  constructor(emit) {
    this.emit = emit;
    this.casts = new Map(); // pageId -> { session, key, timer, closed }
  }

  async watch(streams) {
    const wanted = new Map();
    for (const s of Array.isArray(streams) ? streams : []) {
      if (typeof s?.pageId !== "string") continue;
      wanted.set(s.pageId, {
        maxWidth: clamp(s.maxWidth, 160, 3840, 960),
        maxHeight: clamp(s.maxHeight, 90, 2160, 540),
        quality: clamp(s.quality, 10, 100, 60),
        fps: clamp(s.fps, 1, 30, 5),
      });
    }
    for (const [pageId, cast] of this.casts) {
      const next = wanted.get(pageId);
      if (!next) this.stop(pageId);
      else if (JSON.stringify(next) !== cast.key) void this.restart(pageId, next);
    }
    for (const [pageId, opts] of wanted) if (!this.casts.has(pageId)) void this.start(pageId, opts);
  }

  async start(pageId, opts) {
    const cast = { session: null, key: JSON.stringify(opts), opts, timer: null, closed: false };
    this.casts.set(pageId, cast);
    try {
      const page = await getPage(pageId);
      const session = await page.context().newCDPSession(page);
      cast.session = session;
      if (cast.closed) return void session.detach().catch(() => undefined);
      page.once("close", () => {
        if (this.casts.get(pageId) === cast) {
          this.stop(pageId);
          this.emit({ type: "gone", pageId });
        }
      });
      session.on("Page.screencastFrame", (frame) => {
        if (cast.closed) return;
        const size = { width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight };
        geometry.set(pageId, size);
        this.emit({ type: "frame", pageId, data: frame.data, ...size });
        cast.timer = setTimeout(() => {
          session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
        }, 1000 / cast.opts.fps);
      });
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: opts.quality,
        maxWidth: opts.maxWidth,
        maxHeight: opts.maxHeight,
        everyNthFrame: 1,
      });
    } catch {
      if (this.casts.get(pageId) === cast) {
        this.casts.delete(pageId);
        this.emit({ type: "gone", pageId });
      }
    }
  }

  async restart(pageId, opts) {
    const cast = this.casts.get(pageId);
    if (!cast?.session) return;
    cast.key = JSON.stringify(opts);
    cast.opts = opts;
    cast.session.send("Page.stopScreencast").catch(() => undefined);
    await cast.session
      .send("Page.startScreencast", { format: "jpeg", quality: opts.quality, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight, everyNthFrame: 1 })
      .catch(() => undefined);
  }

  stop(pageId) {
    const cast = this.casts.get(pageId);
    if (!cast) return;
    this.casts.delete(pageId);
    cast.closed = true;
    clearTimeout(cast.timer);
    // Neither is awaited: a frozen page acknowledges nothing.
    cast.session?.send("Page.stopScreencast").catch(() => undefined);
    cast.session?.detach().catch(() => undefined);
  }

  close() {
    for (const pageId of [...this.casts.keys()]) this.stop(pageId);
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// --- the owner's input ------------------------------------------------------------------------

// A key an owner can name: a DOM `key` value (Enter, ArrowLeft, a, F5...), never free text.
const KEY = /^[A-Za-z0-9]{1,12}$|^[!-~]$/;
const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);

function point(pageId, x, y) {
  const size = geometry.get(pageId);
  if (!size) throw new Error("There is no live picture of this tab yet: open it on the page first.");
  const fx = Number(x);
  const fy = Number(y);
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) throw new Error("A position is a fraction of the picture, between 0 and 1.");
  return { x: fx * size.width, y: fy * size.height };
}

/**
 * The owner's hand on a page: taps, a mouse, a wheel, text and keys, placed on the picture they
 * saw. It goes through the page's own input, as real events (`isTrusted`), inside cross-origin
 * frames too, and it takes no window from anyone: an agent working there keeps working.
 */
export async function input(body) {
  const pageId = String(body.pageId);
  const page = await getPage(pageId);
  const kind = String(body.kind);
  const button = body.button === "right" || body.button === "middle" ? body.button : "left";
  switch (kind) {
    case "tap": {
      const { x, y } = point(pageId, body.x, body.y);
      await page.mouse.move(x, y);
      await page.mouse.click(x, y, { button, clickCount: body.double === true ? 2 : 1 });
      return {};
    }
    case "down":
    case "up":
    case "move": {
      const { x, y } = point(pageId, body.x, body.y);
      await page.mouse.move(x, y);
      if (kind === "down") await page.mouse.down({ button });
      if (kind === "up") await page.mouse.up({ button });
      return {};
    }
    case "wheel": {
      const { x, y } = point(pageId, body.x, body.y);
      await page.mouse.move(x, y);
      await page.mouse.wheel(Number(body.dx) || 0, Number(body.dy) || 0);
      return {};
    }
    case "text": {
      const text = String(body.text ?? "");
      if (text) await page.keyboard.insertText(text);
      return {};
    }
    case "key": {
      const key = String(body.key ?? "");
      const modifiers = (Array.isArray(body.modifiers) ? body.modifiers : []).filter((m) => MODIFIERS.has(m));
      if (!KEY.test(key)) throw new Error(`Not a key: ${JSON.stringify(key)}.`);
      await page.keyboard.press([...modifiers, key].join("+"));
      return {};
    }
    default:
      throw new Error(`Unknown input: ${kind}.`);
  }
}

/** Back, forward, reload or a new address, for the tab the owner is looking at. */
export async function go(body) {
  const page = await getPage(String(body.pageId));
  const options = { waitUntil: "commit", timeout: 30000 };
  switch (body.action) {
    case "back":
      await page.goBack(options);
      break;
    case "forward":
      await page.goForward(options);
      break;
    case "reload":
      await page.reload(options);
      break;
    case "goto":
      if (/^file:/i.test(String(body.url))) throw new Error("file:// is not a page: the browser navigates the web.");
      await page.goto(String(body.url), options);
      break;
    default:
      throw new Error(`Unknown navigation: ${body.action}.`);
  }
  return { url: page.url() };
}

// Several tabs close at once when a window does: one refill for the lot.
let refill = null;

pageHooks.born = (page, pageId) => keepOffStage(page, pageId);
pageHooks.closed = (pageId) => {
  forgetLive(pageId);
  clearTimeout(refill);
  refill = setTimeout(() => void refillStage().catch(() => undefined), 300);
};
