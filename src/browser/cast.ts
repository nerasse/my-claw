/**
 * The browser's live pictures, relayed to whoever watches -- docs/browser-live.md.
 *
 * One socket to the sidecar (`/cast`) carries every stream, whatever number of devices watch: the
 * sidecar is told the union of what they want, one screencast per tab, and each frame is handed to
 * the watchers of that tab. A tile and a full view of the same tab share one stream at the larger
 * size. The last frame of each tab is kept, because a page that does not change sends nothing:
 * without it a new watcher of a still page would wait for a picture forever.
 */

export type CastPreset = "tile" | "focus";

export interface CastOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  fps: number;
}

/**
 * A tile is watched to know what is happening, a full view to act in it. Measured on Chromium 147
 * (2026-09-27): 640 px frames of a busy page weigh 15 to 60 KB; 1600 px at 70 reaches 22 frames/s
 * and a tap shows on the next frame 77 ms later.
 */
export const CAST_PRESETS: Record<CastPreset, CastOptions> = {
  tile: { maxWidth: 640, maxHeight: 360, quality: 55, fps: 4 },
  focus: { maxWidth: 1600, maxHeight: 900, quality: 70, fps: 15 },
};

export interface CastFrame {
  pageId: string;
  /** Increases with every frame this server relays, whatever the tab. */
  seq: number;
  /** A JPEG, base64. */
  data: string;
  /** The page's viewport, in CSS pixels: what a fraction of the picture is a fraction of. */
  width: number;
  height: number;
}

export type CastEvent = { type: "frame"; frame: CastFrame } | { type: "gone"; pageId: string };

export interface CastStream {
  pageId: string;
  preset: CastPreset;
}

/** The part of a WebSocket this uses, so tests can stand a sidecar up in memory. */
export interface CastSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const OPEN = 1;
const MAX_BACKOFF_MS = 10_000;

interface Watcher {
  streams: Map<string, CastPreset>;
  deliver: (event: CastEvent) => void;
}

export class BrowserCast {
  private readonly watchers = new Map<object, Watcher>();
  private readonly last = new Map<string, CastFrame>();
  private socket: CastSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private backoff = 1000;
  private sent = "";
  private seq = 0;

  constructor(
    private readonly sidecarUrl: () => string,
    private readonly open: (url: string) => CastSocket = (url) => new WebSocket(url) as unknown as CastSocket,
  ) {}

  /** Replaces what `watcher` watches. An empty list is the same as `unwatch`. */
  watch(watcher: object, streams: CastStream[], deliver: (event: CastEvent) => void): void {
    if (streams.length === 0) {
      this.unwatch(watcher);
      return;
    }
    const before = this.watchers.get(watcher)?.streams ?? new Map<string, CastPreset>();
    const next = new Map(streams.map((s) => [s.pageId, s.preset] as const));
    this.watchers.set(watcher, { streams: next, deliver });
    this.sync();
    for (const pageId of next.keys()) {
      const frame = this.last.get(pageId);
      if (frame && !before.has(pageId)) deliver({ type: "frame", frame });
    }
  }

  unwatch(watcher: object): void {
    if (!this.watchers.delete(watcher)) return;
    this.sync();
  }

  /** What the sidecar is asked to stream: every watched tab, at the largest size anyone wants. */
  private wanted(): Map<string, CastOptions> {
    const presets = new Map<string, CastPreset>();
    for (const w of this.watchers.values()) {
      for (const [pageId, preset] of w.streams) {
        if (presets.get(pageId) !== "focus") presets.set(pageId, preset);
      }
    }
    return new Map([...presets].map(([pageId, preset]) => [pageId, CAST_PRESETS[preset]]));
  }

  private sync(): void {
    const wanted = this.wanted();
    for (const pageId of this.last.keys()) if (!wanted.has(pageId)) this.last.delete(pageId);
    if (wanted.size === 0) {
      clearTimeout(this.retry);
      this.retry = undefined;
      const socket = this.socket;
      this.socket = undefined;
      this.sent = "";
      socket?.close();
      return;
    }
    if (!this.socket) {
      if (!this.retry) this.connect();
      return;
    }
    if (this.socket.readyState !== OPEN) return;
    const message = JSON.stringify({ type: "watch", streams: [...wanted].map(([pageId, o]) => ({ pageId, ...o })) });
    if (message === this.sent) return;
    this.sent = message;
    this.socket.send(message);
  }

  private connect(): void {
    this.retry = undefined;
    const url = `${this.sidecarUrl().replace(/^http/, "ws")}/cast`;
    let socket: CastSocket;
    try {
      socket = this.open(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.backoff = 1000;
      this.sent = "";
      this.sync();
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.sent = "";
      if (this.wanted().size > 0) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
  }

  private receive(raw: unknown): void {
    let message: { type?: unknown; pageId?: unknown; data?: unknown; width?: unknown; height?: unknown };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.pageId !== "string") return;
    const pageId = message.pageId;
    if (message.type === "gone") {
      this.last.delete(pageId);
      this.fanOut(pageId, { type: "gone", pageId });
      return;
    }
    if (message.type !== "frame" || typeof message.data !== "string") return;
    const frame: CastFrame = {
      pageId,
      seq: ++this.seq,
      data: message.data,
      width: Number(message.width) || 0,
      height: Number(message.height) || 0,
    };
    if (!this.wanted().has(pageId)) return;
    this.last.set(pageId, frame);
    this.fanOut(pageId, { type: "frame", frame });
  }

  private fanOut(pageId: string, event: CastEvent): void {
    for (const w of this.watchers.values()) if (w.streams.has(pageId)) w.deliver(event);
  }
}
