import type { BrowserInput } from "../../browser/types.ts";
import type { CastEvent, CastPreset } from "../../browser/cast.ts";
import type { BrowserSession } from "../../tools/browser/session.ts";
import type { WindowOverview } from "../../tools/browser/windows.ts";
import type {
  MyClawAppBrowserControl,
  MyClawAppBrowserInput,
  MyClawAppBrowserWatch,
  MyClawAppServerFrame,
} from "./types.ts";

/**
 * The owner's live view of the browser -- docs/browser-live.md.
 *
 * Devices watch the window listing and the pictures of the tabs they show; they tap, type and
 * scroll in those tabs, and pick the window the VNC screen shows. None of it holds a window: an
 * agent that works in one keeps working while the owner looks, or helps.
 */

/** How often the listing is read while someone watches it: cheap, since the browser answers it itself. */
export const LIST_EVERY_MS = 1500;
/** A device that has not drained this much of its pictures gets no new one until it has. */
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** Older than this, an input the outbox replays after a reconnect is dropped (see `MyClawAppBrowserInput`). */
export const INPUT_STALE_MS = 5000;

/** The part of a socket this uses. */
export interface LiveSocket {
  getBufferedAmount(): number;
}

type Send = (frame: MyClawAppServerFrame) => void;

interface Watcher {
  send: Send;
  windows: boolean;
  lastListing: string;
}

const BUTTONS = new Set(["left", "right", "middle"]);
const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);

function fraction(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A device's input as the sidecar takes it, or undefined for anything malformed. */
export function parseInput(raw: unknown): BrowserInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const button = typeof r["button"] === "string" && BUTTONS.has(r["button"]) ? (r["button"] as "left" | "right" | "middle") : undefined;
  const x = fraction(r["x"]);
  const y = fraction(r["y"]);
  switch (r["kind"]) {
    case "tap":
      if (x === undefined || y === undefined) return undefined;
      return { kind: "tap", x, y, ...(button ? { button } : {}), ...(r["double"] === true ? { double: true } : {}) };
    case "down":
    case "up":
    case "move":
      if (x === undefined || y === undefined) return undefined;
      return { kind: r["kind"], x, y, ...(button ? { button } : {}) };
    case "wheel": {
      const dx = finite(r["dx"]);
      const dy = finite(r["dy"]);
      if (x === undefined || y === undefined || dx === undefined || dy === undefined) return undefined;
      return { kind: "wheel", x, y, dx, dy };
    }
    case "text":
      return typeof r["text"] === "string" && r["text"].length > 0 ? { kind: "text", text: r["text"] } : undefined;
    case "key": {
      if (typeof r["key"] !== "string" || r["key"].length === 0) return undefined;
      const modifiers = Array.isArray(r["modifiers"])
        ? (r["modifiers"].filter((m) => typeof m === "string" && MODIFIERS.has(m)) as Array<"Alt" | "Control" | "Meta" | "Shift">)
        : [];
      return { kind: "key", key: r["key"], ...(modifiers.length ? { modifiers } : {}) };
    }
    default:
      return undefined;
  }
}

/** What a device asks for, as the preset the sidecar is told: anything else is a tile. */
export function presetOf(quality: unknown): CastPreset {
  return quality === "focus" || quality === "focus-large" || quality === "tile-large" ? quality : "tile";
}

function windowsFrame(windows: WindowOverview[]): MyClawAppServerFrame {
  return {
    type: "browser.windows.result",
    windows: windows.map((w) => ({
      alias: w.alias,
      windowId: w.windowId,
      onStage: w.onStage,
      state: w.state,
      ...(w.task ? { task: w.task } : {}),
      tabs: w.tabs,
    })),
  };
}

export class BrowserLive {
  private readonly watchers = new Map<LiveSocket, Watcher>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private listing: Promise<void> | undefined;

  constructor(
    private readonly browser: () => BrowserSession | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  watch(ws: LiveSocket, frame: MyClawAppBrowserWatch, send: Send): void {
    const session = this.browser();
    const streams = (Array.isArray(frame.streams) ? frame.streams : [])
      .filter((s) => typeof s?.pageId === "string")
      .map((s) => ({ pageId: s.pageId, preset: presetOf(s.quality) }));
    if (!frame.windows && streams.length === 0) {
      this.drop(ws);
      return;
    }
    const known = this.watchers.get(ws);
    const watcher: Watcher = { send, windows: frame.windows === true, lastListing: known?.lastListing ?? "" };
    this.watchers.set(ws, watcher);
    if (!session) {
      send({ type: "browser.windows.result", windows: [], error: "The browser is disabled on this server." });
      return;
    }
    session.cast.watch(ws, streams, (event) => this.deliver(ws, event));
    if (watcher.windows && !known?.windows) {
      watcher.lastListing = "";
      void this.list();
    }
    this.schedule();
  }

  drop(ws: LiveSocket): void {
    if (!this.watchers.delete(ws)) return;
    this.browser()?.cast.unwatch(ws);
    this.schedule();
  }

  async input(frame: MyClawAppBrowserInput, send: Send): Promise<void> {
    const session = this.browser();
    const input = parseInput(frame.input);
    if (!session || !input || typeof frame.pageId !== "string") return;
    if (typeof frame.ts !== "number" || this.now() - frame.ts > INPUT_STALE_MS) return;
    try {
      await session.client.input(frame.pageId, input);
    } catch (err) {
      send({ type: "browser.control.result", ok: false, error: String(err instanceof Error ? err.message : err) });
    }
  }

  async control(frame: MyClawAppBrowserControl, send: Send): Promise<void> {
    const session = this.browser();
    const answer = (ok: boolean, error?: string) =>
      send({ type: "browser.control.result", ...(typeof frame.id === "string" ? { id: frame.id } : {}), ok, ...(error ? { error } : {}) });
    if (!session) return answer(false, "The browser is disabled on this server.");
    const { client } = session;
    const windowId = typeof frame.windowId === "number" ? frame.windowId : undefined;
    const pageId = typeof frame.pageId === "string" ? frame.pageId : undefined;
    const url = typeof frame.url === "string" ? frame.url.trim() : "";
    // The owner's hand is on a browser agents read from: a local file opened there would be on
    // their screen next.
    if (/^file:/i.test(url)) return answer(false, "file:// is not a page: the browser navigates the web.");
    try {
      switch (frame.action) {
        case "stage":
          if (windowId === undefined) return answer(false, "Which window?");
          await client.stage(windowId);
          break;
        case "new_window":
          await client.createWindow(url ? withScheme(url) : "about:blank", { onStage: true });
          break;
        case "focus_tab":
          if (!pageId) return answer(false, "Which tab?");
          await client.focusTab(pageId);
          break;
        case "close_tab":
          if (!pageId) return answer(false, "Which tab?");
          await client.closeTab(pageId);
          break;
        case "close_window":
          if (windowId === undefined) return answer(false, "Which window?");
          await client.closeWindow(windowId);
          break;
        case "back":
        case "forward":
        case "reload":
          if (!pageId) return answer(false, "Which tab?");
          await client.go(pageId, { action: frame.action });
          break;
        case "goto":
          if (!pageId || !url) return answer(false, "Which tab, and where to?");
          await client.go(pageId, { action: "goto", url: withScheme(url) });
          break;
        default:
          return answer(false, `Unknown action: ${String(frame.action)}`);
      }
      answer(true);
    } catch (err) {
      answer(false, String(err instanceof Error ? err.message : err));
    }
    // What the action changed shows at once, not at the next tick.
    void this.list();
  }

  /** One read for every device: the listing is the same for all of them. */
  list(): Promise<void> {
    this.listing ??= this.readListing().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  private async readListing(): Promise<void> {
    const listeners = [...this.watchers.values()].filter((w) => w.windows);
    const session = this.browser();
    if (listeners.length === 0 || !session) return;
    let frame: MyClawAppServerFrame;
    try {
      frame = windowsFrame(await session.windows.overview());
    } catch (err) {
      frame = { type: "browser.windows.result", windows: [], error: String(err instanceof Error ? err.message : err) };
    }
    const text = JSON.stringify(frame);
    for (const w of listeners) {
      if (w.lastListing === text) continue;
      w.lastListing = text;
      w.send(frame);
    }
  }

  private deliver(ws: LiveSocket, event: CastEvent): void {
    const watcher = this.watchers.get(ws);
    if (!watcher) return;
    if (event.type === "gone") {
      watcher.send({ type: "browser.frame.gone", pageId: event.pageId });
      return;
    }
    // A slow link keeps its latest picture coming instead of a backlog of stale ones.
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) return;
    const { pageId, seq, data, width, height } = event.frame;
    watcher.send({ type: "browser.frame", pageId, seq, data, width, height });
  }

  private schedule(): void {
    const needed = [...this.watchers.values()].some((w) => w.windows);
    if (needed && !this.timer) this.timer = setInterval(() => void this.list(), LIST_EVERY_MS);
    if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** An address typed on a phone rarely carries its scheme. */
export function withScheme(url: string): string {
  // `localhost:3000` has a colon and no scheme: only `x://` and the few schemes without slashes count.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|view-source):/i.test(url) ? url : `https://${url}`;
}
