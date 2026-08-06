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
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { currentRunId } from "../../utils/run-context.ts";
import { extractMediaRefs, stripMediaRefs } from "../../utils/media.ts";
import { COMMANDS } from "../commands-catalog.ts";
import { SessionFileStore, filePathFor } from "./files.ts";
import type {
  MyClawAppApprovalRequest,
  MyClawAppApprovalResponse,
  MyClawAppAttachmentMeta,
  MyClawAppAttachmentRef,
  MyClawAppChatHistory,
  MyClawAppChatMessage,
  MyClawAppChatSend,
  MyClawAppClientFrame,
  MyClawAppFileDelete,
  MyClawAppFilesList,
  MyClawAppDiagSnapshot,
  MyClawAppLogsTail,
  MyClawAppServerFrame,
  MyClawAppSessionArchive,
  MyClawAppSessionDelete,
  MyClawAppSessionHistory,
  MyClawAppSessionList,
} from "./types.ts";
import { DEFAULT_THREAD } from "./types.ts";
import { MyClawAppStreamer } from "./stream.ts";
import type { MyClawAppSessionStore } from "./sessions.ts";
import { sanitizeThreadId } from "./sessions.ts";

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
// Healthy connections are idle on data frames for long stretches (protocol-level pings keep
// TCP alive); only reclaim sockets that look dead for 10 minutes.
const STALE_SOCKET_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_MEDIA_ENTRIES = 1000;

interface MyClawAppSessionData {
  deviceId: string;
  /** Conversation namespace of the device (config `owner`, else the device id). */
  owner: string;
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

/** Supplied by the entry point: the adapter must not reach into the global config itself. */
export interface MyClawAppDiagnosticsProvider {
  snapshot(owner: string, threadId: string): Promise<string>;
  logs(query: { scope?: string; level?: string; run?: string; contains?: string; limit: number }): Promise<{ text: string; lines: number }>;
}

export class MyClawAppAdapter implements ChannelAdapter {
  readonly platform = "my-claw-app" as const;
  private server?: Server<MyClawAppSessionData>;
  private sockets = new Map<string, ServerWebSocket<MyClawAppSessionData>>();
  private media = new Map<string, MediaEntry>();
  private mediaOrder: string[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private messageHandler?: (msg: UnifiedMessage) => Promise<void>;
  private diagnostics?: MyClawAppDiagnosticsProvider;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private config: MyClawAppChannelConfig,
    private store: MyClawAppSessionStore,
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
    await myClawAppLog("info", "adapter started", { port: this.server.port });
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
    await myClawAppLog("info", "adapter stopped");
  }

  setConfig(config: MyClawAppChannelConfig): void {
    this.config = config;
  }

  streamingEnabled(): boolean {
    return this.config.streaming?.enabled === true;
  }

  async send(owner: string, message: OutgoingMessage): Promise<void> {
    if (this.socketsFor(owner).length === 0) {
      await myClawAppLog("debug", "send skipped: no device online", { owner });
      return;
    }

    const mediaRefs = extractMediaRefs(message.text);
    const text = stripMediaRefs(message.text);
    // The agent's explicit MEDIA: refs are trusted over programmatic attachments (same as telegram).
    const attachmentsToSend = mediaRefs.length > 0 ? [] : (message.attachments ?? []);

    if (!text && !mediaRefs.length && !attachmentsToSend.length) return;

    const attachments: MyClawAppAttachmentMeta[] = [];
    for (const ref of mediaRefs) {
      const meta = this.registerMedia(ref.path, { type: "audio", audioAsVoice: ref.audioAsVoice, durationMs: ref.durationMs });
      if (meta) attachments.push(meta);
    }
    for (const att of attachmentsToSend) {
      if (!att.path) {
        await myClawAppLog("debug", "attachment without local path skipped", { type: att.type });
        continue;
      }
      const meta = this.registerMedia(att.path, { type: att.type, mimeType: att.mimeType, filename: att.filename, sizeBytes: att.sizeBytes, width: att.width, height: att.height, durationMs: att.durationMs, audioAsVoice: att.audioAsVoice });
      if (meta) attachments.push(meta);
    }

    const frame: MyClawAppChatMessage = {
      type: "chat.message",
      id: crypto.randomUUID(),
      text,
      threadId: message.threadId ?? DEFAULT_THREAD,
      attachments,
      replyToId: message.replyToId,
      ...(currentRunId() ? { run: currentRunId() } : {}),
    };
    this.broadcast(owner, frame);
  }

  async confirmTool(request: ToolApprovalRequest): Promise<ApprovalDecision> {
    if (this.config.approvals !== true) return "deny";
    if (this.socketsFor(request.chatId).length === 0) return "deny";

    const id = crypto.randomUUID();
    const frame: MyClawAppApprovalRequest = {
      type: "approval.request",
      id,
      threadId: request.threadId ?? DEFAULT_THREAD,
      toolName: request.toolName,
      args: request.args,
      replyToId: request.messageId,
      expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
    };
    // Asked on every window of the owner; the first answer wins and clears the pending entry.
    this.broadcast(request.chatId, frame);

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve("deny");
      }, CONFIRM_TIMEOUT_MS);
      this.pendingApprovals.set(id, { resolve, timer });
    });
  }

  createStreamer(message: UnifiedMessage): MyClawAppStreamer {
    const owner = message.chatId;
    return new MyClawAppStreamer({
      id: crypto.randomUUID(),
      replyToId: message.id,
      threadId: message.threadId ?? DEFAULT_THREAD,
      minCharsBeforeDelta: this.config.streaming?.minChars,
      // Resolved per frame, not captured: a window that joins mid-answer still gets the rest.
      send: (frame) => this.broadcast(owner, frame),
    });
  }

  onMessage(handler: (msg: UnifiedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Injected by the entry point: the adapter has no view of the global config or the runtime. */
  onDiagnostics(provider: MyClawAppDiagnosticsProvider): void {
    this.diagnostics = provider;
  }

  /** Conversation namespace of a device: its configured owner, else the device id itself. */
  private ownerFor(deviceId: string): string {
    return this.config.devices?.[deviceId]?.owner?.trim() || deviceId;
  }

  private socketsFor(owner: string): ServerWebSocket<MyClawAppSessionData>[] {
    return [...this.sockets.values()].filter((ws) => ws.data.owner === owner);
  }

  private broadcast(owner: string, frame: MyClawAppServerFrame): void {
    for (const ws of this.socketsFor(owner)) this.sendFrame(ws, frame);
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

  private async handleFetch(req: Request, server: Server<MyClawAppSessionData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    if (url.pathname === "/media" && req.method === "POST") {
      const deviceId = url.searchParams.get("device") ?? "";
      if (!this.deviceFor(deviceId, url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return this.handleUpload(this.ownerFor(deviceId), req);
    }

    if (url.pathname.startsWith("/media/")) {
      const id = url.pathname.slice("/media/".length);
      const deviceId = url.searchParams.get("device") ?? "";
      if (!this.deviceFor(deviceId, url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return this.serveMedia(id, this.ownerFor(deviceId));
    }

    if (url.pathname === "/my-claw-app") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      if (!this.deviceFor(url.searchParams.get("device") ?? "", url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      const deviceId = url.searchParams.get("device")!;
      if (server.upgrade(req, { data: { deviceId, owner: this.ownerFor(deviceId), lastSeen: Date.now() } })) {
        return undefined;
      }
      return new Response("Upgrade Failed", { status: 500 });
    }

    return new Response("Not Found", { status: 404 });
  }

  private async serveMedia(id: string, owner?: string): Promise<Response> {
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
    // Attachments uploaded from the owner's devices: served back from the session files.
    if (owner) {
      const found = await this.files.readById(owner, id);
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

  private async handleUpload(owner: string, req: Request): Promise<Response> {
    const threadId = req.headers.get("x-thread-id")?.trim() || "default";
    const safeThread = sanitizeThreadId(threadId);
    const filename = (req.headers.get("x-filename") ?? "attachment").trim();
    const type = (req.headers.get("x-type") ?? "file").trim() as MyClawAppAttachmentRef["type"];
    if (!safeThread) {
      await myClawAppLog("warn", "upload rejected: bad threadId", { owner, threadId });
      return new Response("Bad threadId", { status: 400 });
    }
    // Reject oversized payloads from the declared length BEFORE buffering the body: the
    // client decides the bytes we hold in memory, so the cap must apply to the declaration.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > this.files.maxSizeBytes) {
      await myClawAppLog("warn", "upload rejected: too large", { owner, threadId: safeThread, declared, max: this.files.maxSizeBytes });
      return new Response("File too large", { status: 413 });
    }
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const file = await this.files.save(owner, safeThread, filename, bytes);
      await myClawAppLog("info", "file uploaded", { owner, threadId: safeThread, id: file.id, size: file.sizeBytes, type });
      return Response.json({ id: file.id, type: type || file.type, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Upload failed";
      await myClawAppLog("warn", "upload failed", { owner, threadId: safeThread, filename, reason });
      return new Response(reason, { status: 413 });
    }
  }

  private registerMedia(path: string, meta: { type: "image" | "audio" | "video" | "file" } & Omit<MediaEntry, "path" | "type">): MyClawAppAttachmentMeta | undefined {
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

  private handleOpen(ws: ServerWebSocket<MyClawAppSessionData>): void {
    const existing = this.sockets.get(ws.data.deviceId);
    if (existing && existing !== ws) {
      try {
        existing.close(1000, "replaced");
      } catch {
        // already closed
      }
    }
    this.sockets.set(ws.data.deviceId, ws);
    void myClawAppLog("info", "device connected", { deviceId: ws.data.deviceId });
  }

  private handleClose(ws: ServerWebSocket<MyClawAppSessionData>): void {
    if (this.sockets.get(ws.data.deviceId) === ws) {
      this.sockets.delete(ws.data.deviceId);
    }
    void myClawAppLog("info", "device disconnected", { deviceId: ws.data.deviceId });
  }

  private handleMessage(ws: ServerWebSocket<MyClawAppSessionData>, message: string | Buffer): void {
    ws.data.lastSeen = Date.now();
    const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");

    let frame: MyClawAppClientFrame | undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        frame = parsed as MyClawAppClientFrame;
      }
    } catch {
      // Not JSON: treated as a plain-text chat.send (console mode).
    }

    if (!frame) {
      this.emitChatSend(ws.data.owner, { type: "chat.send", id: crypto.randomUUID(), text: raw });
      return;
    }

    switch (frame.type) {
      case "chat.send":
        void this.emitChatSend(ws.data.owner, frame);
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
      case "diag.snapshot":
        void this.handleDiagSnapshot(ws, ws.data.owner, frame);
        break;
      case "logs.tail":
        void this.handleLogsTail(ws, frame);
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

  private async emitChatSend(owner: string, frame: MyClawAppChatSend): Promise<void> {
    const text = frame.text.trim();
    if (!text && !frame.attachments?.length) return;
    if (!this.messageHandler) return;

    const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;

    const attachments: Attachment[] = [];
    for (const ref of frame.attachments ?? []) {
      const stored = await this.files.findById(owner, threadId, ref.id);
      if (!stored) {
        await myClawAppLog("warn", "attachment not found, dropped from the message", { owner, threadId, id: ref.id });
        continue;
      }
      attachments.push({
        // The stored type comes from the file itself; `ref.type` is whatever the client claimed,
        // and a jpeg announced as "file" would silently skip vision routing.
        type: stored.type,
        path: filePathFor(owner, threadId, stored.id, stored.filename.split(".").at(-1) ?? "bin"),
        mimeType: stored.mimeType,
        filename: stored.filename,
        sizeBytes: stored.sizeBytes,
      });
    }

    void this.messageHandler({
      id: frame.id,
      platform: "my-claw-app",
      userId: owner,
      chatId: owner,
      chatType: "dm",
      text,
      timestamp: frame.ts,
      attachments,
      isForwarded: false,
      threadId,
      sessionScope: "per-user",
      raw: frame,
    }).catch((err) => {
      void myClawAppLog("error", "message handling failed", { owner, error: String(err) });
    });
  }

  private async handleSessionList(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionList): Promise<void> {
    try {
      const sessions = await this.store.list(ws.data.owner);
      this.sendFrame(ws, { type: "session.list.result", sessions });
    } catch (err) {
      await myClawAppLog("error", "session.list failed", { deviceId: ws.data.deviceId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "session list failed" });
    }
  }

  private async handleSessionHistory(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionHistory): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      const messages = await this.store.history(ws.data.owner, threadId, frame.limit);
      const result: MyClawAppChatHistory = { type: "chat.history", threadId, messages };
      this.sendFrame(ws, result);
    } catch (err) {
      await myClawAppLog("error", "session.history failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "history failed" });
    }
  }

  private async handleSessionArchive(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionArchive): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      await this.store.archive(ws.data.owner, threadId);
      await this.files.removeSessionFiles(ws.data.owner, threadId);
      this.sendFrame(ws, { type: "chat.history", threadId, messages: [] });
    } catch (err) {
      await myClawAppLog("error", "session.archive failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "archive failed" });
    }
  }

  private async handleSessionDelete(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionDelete): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      await this.store.remove(ws.data.owner, threadId);
      await this.files.removeSessionFiles(ws.data.owner, threadId);
      this.sendFrame(ws, { type: "chat.history", threadId, messages: [] });
    } catch (err) {
      await myClawAppLog("error", "session.delete failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "delete failed" });
    }
  }

  private async handleDiagSnapshot(
    ws: ServerWebSocket<MyClawAppSessionData>,
    deviceId: string,
    frame: MyClawAppDiagSnapshot,
  ): Promise<void> {
    if (!this.diagnostics) {
      this.sendFrame(ws, { type: "error", message: "diagnostics unavailable" });
      return;
    }
    try {
      const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;
      this.sendFrame(ws, { type: "diag.snapshot.result", text: await this.diagnostics.snapshot(deviceId, threadId) });
    } catch (err) {
      await myClawAppLog("error", "diag.snapshot failed", { deviceId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "diag.snapshot failed" });
    }
  }

  private async handleLogsTail(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppLogsTail): Promise<void> {
    if (!this.diagnostics) {
      this.sendFrame(ws, { type: "error", message: "diagnostics unavailable" });
      return;
    }
    const query = {
      ...(frame.scope ? { scope: frame.scope } : {}),
      ...(frame.level ? { level: frame.level } : {}),
      ...(frame.run ? { run: frame.run } : {}),
      ...(frame.contains ? { contains: frame.contains } : {}),
      limit: Math.min(Math.max(frame.limit ?? 200, 1), 1000),
    };
    try {
      const { text, lines } = await this.diagnostics.logs(query);
      this.sendFrame(ws, { type: "logs.tail.result", text, lines, query });
    } catch (err) {
      await myClawAppLog("error", "logs.tail failed", { deviceId: ws.data.deviceId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "logs.tail failed" });
    }
  }

  private async handleFilesList(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppFilesList): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      this.sendFrame(ws, { type: "error", message: "invalid threadId" });
      return;
    }
    try {
      const [files, totalBytes] = await Promise.all([
        this.files.list(ws.data.owner, threadId),
        this.files.sessionSizeBytes(ws.data.owner, threadId),
      ]);
      this.sendFrame(ws, { type: "files.list.result", threadId, files, totalBytes });
    } catch (err) {
      await myClawAppLog("error", "files.list failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "files.list failed" });
    }
  }

  private async handleFileDelete(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppFileDelete): Promise<void> {
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
      await myClawAppLog("error", "files.delete failed", { deviceId: ws.data.deviceId, threadId, error: String(err) });
      this.sendFrame(ws, { type: "error", message: "files.delete failed" });
    }
  }

  private resolveApproval(frame: MyClawAppApprovalResponse): void {
    const pending = this.pendingApprovals.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(frame.id);
    pending.resolve(frame.accepted ? "allow-session" : "deny");
  }

  private sendFrame(ws: ServerWebSocket<MyClawAppSessionData> | undefined, frame: MyClawAppServerFrame): void {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      void myClawAppLog("debug", "send failed", { error: String(err) });
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
