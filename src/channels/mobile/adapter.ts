import type { Server, ServerWebSocket } from "bun";
import { extname } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ApprovalDecision,
  Attachment,
  ChannelAdapter,
  OutgoingMessage,
  ToolApprovalRequest,
  UnifiedMessage,
} from "../types.ts";
import type { MobileChannelConfig } from "../../core/config.ts";
import { mobileLog } from "../../utils/logger.ts";
import { extractMediaRefs, stripMediaRefs } from "../../utils/media.ts";
import { COMMANDS } from "../commands-catalog.ts";
import { SessionFileStore, filePathFor } from "./files.ts";
import type {
  MobileApprovalRequest,
  MobileApprovalResponse,
  MobileAttachmentMeta,
  MobileAttachmentRef,
  MobileChatHistory,
  MobileChatMessage,
  MobileChatSend,
  MobileClientFrame,
  MobileFileDelete,
  MobileFilesList,
  MobileServerFrame,
  MobileSessionArchive,
  MobileSessionDelete,
  MobileSessionHistory,
  MobileSessionList,
} from "./types.ts";
import { DEFAULT_MOBILE_THREAD } from "./types.ts";
import { MobileStreamer } from "./stream.ts";
import type { MobileSessionStore } from "./sessions.ts";
import { sanitizeThreadId } from "./sessions.ts";

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
// Healthy connections are idle on data frames for long stretches (protocol-level pings keep
// TCP alive); only reclaim sockets that look dead for 10 minutes.
const STALE_SOCKET_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_MEDIA_ENTRIES = 1000;

interface MobileSessionData {
  deviceId: string;
  lastSeen: number;
}

interface MediaEntry {
  path: string;
  type: "image" | "audio" | "video" | "file";
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  audioAsVoice?: boolean;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MobileAdapter implements ChannelAdapter {
  readonly platform = "mobile" as const;
  private server?: Server<MobileSessionData>;
  private sockets = new Map<string, ServerWebSocket<MobileSessionData>>();
  private media = new Map<string, MediaEntry>();
  private mediaOrder: string[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private messageHandler?: (msg: UnifiedMessage) => Promise<void>;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private config: MobileChannelConfig,
    private store: MobileSessionStore,
  ) {
    this.files = new SessionFileStore(this.config);
  }

  private files: SessionFileStore;

  /** Actual bound port; 0 until started. Exposed for tests. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.config.port ?? 8080,
      fetch: (req, server) => this.handleFetch(req, server),
      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, message) => this.handleMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
    });
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
    await mobileLog("info", "mobile adapter started", { port: this.server.port });
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const ws of this.sockets.values()) {
      try {
        ws.close(1001, "server shutdown");
      } catch {
        // socket already gone
      }
    }
    this.sockets.clear();
    this.media.clear();
    this.mediaOrder = [];
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve("deny");
    }
    this.pendingApprovals.clear();
    this.server?.stop(true);
    this.server = undefined;
    await mobileLog("info", "mobile adapter stopped");
  }

  setConfig(config: MobileChannelConfig): void {
    this.config = config;
  }

  streamingEnabled(): boolean {
    return this.config.streaming?.enabled === true;
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    const ws = this.sockets.get(chatId);
    if (!ws) {
      await mobileLog("debug", "mobile send skipped: device offline", { deviceId: chatId });
      return;
    }

    const mediaRefs = extractMediaRefs(message.text);
    const text = stripMediaRefs(message.text);
    // The agent's explicit MEDIA: refs are trusted over programmatic attachments (same as telegram).
    const attachmentsToSend = mediaRefs.length > 0 ? [] : (message.attachments ?? []);

    if (!text && !mediaRefs.length && !attachmentsToSend.length) return;

    const attachments: MobileAttachmentMeta[] = [];
    for (const ref of mediaRefs) {
      const meta = this.registerMedia(ref.path, { type: "audio", audioAsVoice: ref.audioAsVoice, durationMs: ref.durationMs });
      if (meta) attachments.push(meta);
    }
    for (const att of attachmentsToSend) {
      if (!att.path) {
        await mobileLog("debug", "mobile attachment without local path skipped", { type: att.type });
        continue;
      }
      const meta = this.registerMedia(att.path, { type: att.type, mimeType: att.mimeType, filename: att.filename, sizeBytes: att.sizeBytes, width: att.width, height: att.height, durationMs: att.durationMs, audioAsVoice: att.audioAsVoice });
      if (meta) attachments.push(meta);
    }

    const frame: MobileChatMessage = {
      type: "chat.message",
      id: crypto.randomUUID(),
      text,
      threadId: message.threadId ?? DEFAULT_MOBILE_THREAD,
      attachments,
      replyToId: message.replyToId,
    };
    this.sendFrame(ws, frame);
  }

  async confirmTool(request: ToolApprovalRequest): Promise<ApprovalDecision> {
    if (this.config.approvals !== true) return "deny";
    const ws = this.sockets.get(request.chatId);
    if (!ws) return "deny";

    const id = crypto.randomUUID();
    const frame: MobileApprovalRequest = {
      type: "approval.request",
      id,
      threadId: request.threadId ?? DEFAULT_MOBILE_THREAD,
      toolName: request.toolName,
      args: request.args,
      replyToId: request.messageId,
      expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
    };
    this.sendFrame(ws, frame);

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve("deny");
      }, CONFIRM_TIMEOUT_MS);
      this.pendingApprovals.set(id, { resolve, timer });
    });
  }

  createStreamer(message: UnifiedMessage): MobileStreamer {
    const ws = this.sockets.get(message.chatId);
    return new MobileStreamer({
      id: crypto.randomUUID(),
      replyToId: message.id,
      threadId: message.threadId ?? DEFAULT_MOBILE_THREAD,
      minCharsBeforeDelta: this.config.streaming?.minChars,
      send: (frame) => this.sendFrame(ws, frame),
    });
  }

  onMessage(handler: (msg: UnifiedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private deviceFor(deviceId: string, token: string): boolean {
    const device = this.config.devices?.[deviceId];
    if (!device) return false;
    if (device.enabled === false) return false;
    // Constant-time compare: a token check with early exit would leak the prefix by timing.
    const expected = createHash("sha256").update(device.token).digest();
    const provided = createHash("sha256").update(token).digest();
    return timingSafeEqual(expected, provided);
  }

  private async handleFetch(req: Request, server: Server<MobileSessionData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    if (url.pathname === "/media" && req.method === "POST") {
      const deviceId = url.searchParams.get("device") ?? "";
      if (!this.deviceFor(deviceId, url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return this.handleUpload(deviceId, req);
    }

    if (url.pathname.startsWith("/media/")) {
      const id = url.pathname.slice("/media/".length);
      const deviceId = url.searchParams.get("device") ?? "";
      if (!this.deviceFor(deviceId, url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return this.serveMedia(id, deviceId);
    }

    if (url.pathname === "/mobile") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      if (!this.deviceFor(url.searchParams.get("device") ?? "", url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (server.upgrade(req, { data: { deviceId: url.searchParams.get("device")!, lastSeen: Date.now() } })) {
        return undefined;
      }
      return new Response("Upgrade Failed", { status: 500 });
    }

    return new Response("Not Found", { status: 404 });
  }

  private async serveMedia(id: string, deviceId?: string): Promise<Response> {
    const entry = this.media.get(id);
    if (entry) {
      const headers: Record<string, string> = {
        "Content-Type": entry.mimeType ?? "application/octet-stream",
      };
      if (entry.filename) {
        headers["Content-Disposition"] = `attachment; filename="${entry.filename.replace(/["\\]/g, "")}"`;
      }
      return new Response(Bun.file(entry.path), { headers });
    }
    // Attachments uploaded by the device itself: served back from the session files.
    if (deviceId) {
      const found = await this.files.readById(deviceId, id);
      if (found) {
        return new Response(Bun.file(found.path), {
          headers: {
            "Content-Type": found.file.mimeType,
            "Content-Disposition": `attachment; filename="${found.file.filename.replace(/["\\]/g, "")}"`,
          },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  private async handleUpload(deviceId: string, req: Request): Promise<Response> {
    const threadId = req.headers.get("x-thread-id")?.trim() || "default";
    const safeThread = sanitizeThreadId(threadId);
    const filename = (req.headers.get("x-filename") ?? "attachment").trim();
    const type = (req.headers.get("x-type") ?? "file").trim() as MobileAttachmentRef["type"];
    if (!safeThread) return new Response("Bad threadId", { status: 400 });
    // Reject oversized payloads from the declared length BEFORE buffering the body: the
    // client decides the bytes we hold in memory, so the cap must apply to the declaration.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > this.files.maxSizeBytes) {
      return new Response("File too large", { status: 413 });
    }
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const file = await this.files.save(deviceId, safeThread, filename, bytes);
      await mobileLog("info", "mobile file uploaded", { deviceId, threadId: safeThread, id: file.id, size: file.sizeBytes, type });
      return Response.json({ id: file.id, type: type || file.type, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes });
    } catch (err) {
      return new Response(err instanceof Error ? err.message : "Upload failed", { status: 413 });
    }
  }

  private registerMedia(path: string, meta: { type: "image" | "audio" | "video" | "file" } & Omit<MediaEntry, "path" | "type">): MobileAttachmentMeta | undefined {
    const id = crypto.randomUUID();
    this.media.set(id, { path, ...meta });
    this.mediaOrder.push(id);
    if (this.mediaOrder.length > MAX_MEDIA_ENTRIES) {
      const oldest = this.mediaOrder.shift();
      if (oldest) this.media.delete(oldest);
    }
    return {
      id,
      type: meta.type,
      mimeType: meta.mimeType ?? mimeTypeForPath(path),
      filename: meta.filename,
      sizeBytes: meta.sizeBytes,
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      audioAsVoice: meta.audioAsVoice,
    };
  }

  private handleOpen(ws: ServerWebSocket<MobileSessionData>): void {
    const existing = this.sockets.get(ws.data.deviceId);
    if (existing && existing !== ws) {
      try {
        existing.close(1000, "replaced");
      } catch {
        // already closed
      }
    }
    this.sockets.set(ws.data.deviceId, ws);
    void mobileLog("info", "mobile device connected", { deviceId: ws.data.deviceId });
  }

  private handleClose(ws: ServerWebSocket<MobileSessionData>): void {
    if (this.sockets.get(ws.data.deviceId) === ws) {
      this.sockets.delete(ws.data.deviceId);
    }
    void mobileLog("info", "mobile device disconnected", { deviceId: ws.data.deviceId });
  }

  private handleMessage(ws: ServerWebSocket<MobileSessionData>, message: string | Buffer): void {
    ws.data.lastSeen = Date.now();
    const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");

    let frame: MobileClientFrame | undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        frame = parsed as MobileClientFrame;
      }
    } catch {
      // Not JSON: treated as a plain-text chat.send (console mode).
    }

    if (!frame) {
      this.emitChatSend(ws.data.deviceId, { type: "chat.send", id: crypto.randomUUID(), text: raw });
      return;
    }

    switch (frame.type) {
      case "chat.send":
        void this.emitChatSend(ws.data.deviceId, frame);
        break;
      case "approval.response":
        this.resolveApproval(frame);
        break;
      case "ping":
        // Transport-level pings are answered by the server; nothing to reply to.
        break;
      case "device.capabilities":
        // Accepted and ignored: capabilities gate the M3 device tools.
        break;
      case "session.list":
        this.handleSessionList(ws, frame);
        break;
      case "commands.list":
        void ws.send(JSON.stringify({
          type: "commands.list.result",
          commands: COMMANDS.map(({ command, description }) => ({ name: command, description })),
        }));
        break;
      case "files.list":
        void this.handleFilesList(ws, frame);
        break;
      case "files.delete":
        void this.handleFileDelete(ws, frame);
        break;
      case "session.history":
        this.handleSessionHistory(ws, frame);
        break;
      case "session.archive":
        void this.handleSessionArchive(ws, frame);
        break;
      case "session.delete":
        void this.handleSessionDelete(ws, frame);
        break;
    }
  }

  private async emitChatSend(deviceId: string, frame: MobileChatSend): Promise<void> {
    const text = frame.text.trim();
    if (!text && !frame.attachments?.length) return;
    if (!this.messageHandler) return;

    const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_MOBILE_THREAD;

    const attachments: Attachment[] = [];
    for (const ref of frame.attachments ?? []) {
      const stored = await this.files.findById(deviceId, threadId, ref.id);
      if (!stored) continue;
      attachments.push({
        // The stored type comes from the file itself; `ref.type` is whatever the client claimed,
        // and a jpeg announced as "file" would silently skip vision routing.
        type: stored.type,
        path: filePathFor(deviceId, threadId, stored.id, stored.filename.split(".").at(-1) ?? "bin"),
        mimeType: stored.mimeType,
        filename: stored.filename,
        sizeBytes: stored.sizeBytes,
      });
    }

    void this.messageHandler({
      id: frame.id,
      platform: "mobile",
      userId: deviceId,
      chatId: deviceId,
      chatType: "dm",
      text,
      timestamp: frame.ts,
      attachments,
      isForwarded: false,
      threadId,
      sessionScope: "per-user",
      raw: frame,
    }).catch((err) => {
      void mobileLog("error", "mobile message handling failed", { deviceId, error: String(err) });
    });
  }

  private async handleSessionList(ws: ServerWebSocket<MobileSessionData>, frame: MobileSessionList): Promise<void> {
    try {
      const sessions = await this.store.list(ws.data.deviceId);
      this.sendFrame(ws, { type: "session.list.result", sessions });
    } catch (err) {
      await mobileLog("error", "mobile session.list failed", { deviceId: ws.data.deviceId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "session list failed" });
    }
  }

  private async handleSessionHistory(ws: ServerWebSocket<MobileSessionData>, frame: MobileSessionHistory): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      const messages = await this.store.history(ws.data.deviceId, threadId, frame.limit);
      const result: MobileChatHistory = { type: "chat.history", threadId, messages };
      this.sendFrame(ws, result);
    } catch (err) {
      await mobileLog("error", "mobile session.history failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "history failed" });
    }
  }

  private async handleSessionArchive(ws: ServerWebSocket<MobileSessionData>, frame: MobileSessionArchive): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      await this.store.archive(ws.data.deviceId, threadId);
      await this.files.removeSessionFiles(ws.data.deviceId, threadId);
      this.sendFrame(ws, { type: "chat.history", threadId, messages: [] });
    } catch (err) {
      await mobileLog("error", "mobile session.archive failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "archive failed" });
    }
  }

  private async handleSessionDelete(ws: ServerWebSocket<MobileSessionData>, frame: MobileSessionDelete): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      await this.store.remove(ws.data.deviceId, threadId);
      await this.files.removeSessionFiles(ws.data.deviceId, threadId);
      this.sendFrame(ws, { type: "chat.history", threadId, messages: [] });
    } catch (err) {
      await mobileLog("error", "mobile session.delete failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "delete failed" });
    }
  }

  private async handleFilesList(ws: ServerWebSocket<MobileSessionData>, frame: MobileFilesList): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      const [files, totalBytes] = await Promise.all([
        this.files.list(ws.data.deviceId, threadId),
        this.files.sessionSizeBytes(ws.data.deviceId, threadId),
      ]);
      this.sendFrame(ws, { type: "files.list.result", threadId, files, totalBytes });
    } catch (err) {
      await mobileLog("error", "mobile files.list failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "files.list failed" });
    }
  }

  private async handleFileDelete(ws: ServerWebSocket<MobileSessionData>, frame: MobileFileDelete): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      const removed = await this.files.remove(ws.data.deviceId, threadId, frame.id);
      if (removed) {
        await this.handleFilesList(ws, { type: "files.list", threadId });
      } else {
        this.sendFrame(ws, { type: "error", message: "file not found" });
      }
    } catch (err) {
      await mobileLog("error", "mobile files.delete failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "files.delete failed" });
    }
  }

  private resolveApproval(frame: MobileApprovalResponse): void {
    const pending = this.pendingApprovals.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(frame.id);
    pending.resolve(frame.accepted ? "allow-session" : "deny");
  }

  private sendFrame(ws: ServerWebSocket<MobileSessionData> | undefined, frame: MobileServerFrame): void {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      void mobileLog("debug", "mobile send failed", { error: String(err) });
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [deviceId, ws] of this.sockets) {
      if (now - ws.data.lastSeen > STALE_SOCKET_MS) {
        try {
          ws.close(1001, "stale");
        } catch {
          // already closed
        }
        this.sockets.delete(deviceId);
      }
    }
  }
}

function mimeTypeForPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".zip": "application/zip",
  };
  return map[ext];
}
