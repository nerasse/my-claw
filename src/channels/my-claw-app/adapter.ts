import type { Server, ServerWebSocket } from "bun";
import { basename, extname } from "node:path";
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
import { MIME_BY_EXTENSION, SessionFileStore, filePathFor, parseStoredName } from "./files.ts";
import type {
  MyClawAppApprovalRequest,
  MyClawAppApprovalResponse,
  MyClawAppAttachmentMeta,
  MyClawAppAttachmentRef,
  MyClawAppChatHistory,
  MyClawAppChatMessage,
  MyClawAppChatSend,
  MyClawAppChatStop,
  MyClawAppClientFrame,
  MyClawAppErrorScope,
  MyClawAppFileDelete,
  MyClawAppFilesList,
  MyClawAppDiagSnapshot,
  MyClawAppLogsTail,
  MyClawAppServerFrame,
  MyClawAppSessionArchive,
  MyClawAppSessionDelete,
  MyClawAppSessionHistory,
  MyClawAppSessionList,
  MyClawAppSessionRename,
  MyClawAppSessionClear,
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

/**
 * Speech-to-text engine control, injected for the same reason as the diagnostics provider: the
 * adapter must not reach into the global config or the voice runtime itself.
 */
export interface MyClawAppVoiceController {
  /** Configured choice, what it resolves to now, and whether cloud is usable at all. */
  status(): { mode: "cloud" | "local" | "auto"; resolved: "cloud" | "local"; cloudAvailable: boolean };
  /** Persisted, not just applied: a switch flipped in the app must survive a restart. */
  setMode(mode: "cloud" | "local" | "auto"): Promise<void>;
}

/** Supplied by the entry point: the adapter must not reach into the global config itself. */
export interface MyClawAppDiagnosticsProvider {
  snapshot(owner: string, threadId: string): Promise<string>;
  logs(query: { scope?: string; level?: string; run?: string; contains?: string; limit: number }): Promise<{ text: string; lines: number }>;
}

/**
 * Model control, injected for the same reason as the voice controller: the adapter must not
 * reach into the global config, the model picker or the session manager itself.
 */
export interface MyClawAppModelController {
  list(): { models: Array<{ id: string; label: string; group?: string }>; defaultModel: string };
  /** What runs on this thread now: override or configured default, plus effort state. */
  current(owner: string, threadId: string): Promise<{
    model: string;
    defaultModel: string;
    effort: { level: string; levels: string[]; supported: boolean };
  }>;
  /** Persists the override (or clears it, back to the default) and reports what was stored. */
  set(owner: string, threadId: string, modelId: string): Promise<{
    model: string;
    defaultModel: string;
    effort: { level: string; levels: string[]; supported: boolean };
  }>;
  setEffort(owner: string, threadId: string, level: string): Promise<{
    model: string;
    defaultModel: string;
    effort: { level: string; levels: string[]; supported: boolean };
  }>;
}

/** Text slash commands, executed server-side like on the other channels. */
export type MyClawAppCommandHandler = (
  owner: string,
  threadId: string,
  command: string,
  args: string,
) => Promise<string | undefined>;

export class MyClawAppAdapter implements ChannelAdapter {
  readonly platform = "my-claw-app" as const;
  private server?: Server<MyClawAppSessionData>;
  private sockets = new Map<string, ServerWebSocket<MyClawAppSessionData>>();
  private media = new Map<string, MediaEntry>();
  private mediaOrder: string[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private messageHandler?: (msg: UnifiedMessage) => Promise<void>;
  private diagnostics?: MyClawAppDiagnosticsProvider;
  private voice?: MyClawAppVoiceController;
  private models?: MyClawAppModelController;
  private commandHandler?: MyClawAppCommandHandler;
  private stopRun?: (sessionId: string) => boolean;
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

  onVoiceController(controller: MyClawAppVoiceController): void {
    this.voice = controller;
  }

  onModelController(controller: MyClawAppModelController): void {
    this.models = controller;
  }

  /** Executes text slash commands; when absent, they fall through to the agent like any message. */
  onCommandHandler(handler: MyClawAppCommandHandler): void {
    this.commandHandler = handler;
  }

  /** Stops the run of a session id (resolved here), so the adapter never reaches into core. */
  onStop(stop: (sessionId: string) => boolean): void {
    this.stopRun = stop;
  }

  /**
   * Delivered to every socket of the owner, like any other frame addressed to a conversation.
   * Transcripts arrive keyed by the file they came from; the id in the path is what the device
   * knows its bubbles by, so the mapping happens here rather than in the agent.
   */
  sendTranscript(
    owner: string,
    threadId: string,
    replyToId: string,
    transcripts: Array<{ path: string; text: string }>,
  ): void {
    const items: Array<{ id: string; text: string }> = [];
    for (const entry of transcripts) {
      const parsed = parseStoredName(basename(entry.path));
      if (parsed) items.push({ id: parsed.id, text: entry.text });
    }
    if (items.length === 0) return;
    for (const ws of this.socketsFor(owner)) {
      this.sendFrame(ws, { type: "chat.transcript", threadId, replyToId, items });
    }
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
      case "session.rename":
        void this.handleSessionRename(ws, frame);
        break;
      case "voice.mode.get":
        void this.handleVoiceMode(ws, undefined);
        break;
      case "voice.mode.set":
        void this.handleVoiceMode(ws, frame.mode);
        break;
      case "model.list":
        void this.handleModelList(ws);
        break;
      case "model.get":
        void this.handleModel(ws, frame.threadId, undefined);
        break;
      case "model.set":
        void this.handleModel(ws, frame.threadId, frame.model);
        break;
      case "model.effort.set":
        void this.handleModelEffort(ws, frame.threadId, frame.level);
        break;
      case "chat.stop":
        void this.handleChatStop(ws, frame);
        break;
      case "session.clear":
        void this.handleSessionClear(ws, frame);
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

    const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;

    // Slash commands run on the server, exactly as they do on the other channels: a command
    // sent to the model as a plain question would be answered from nothing. The user's own
    // bubble is drawn by the app from its send; only the result is new here. Only the catalog
    // is intercepted: an unknown /word is a question like any other and must reach the agent.
    if (text && !frame.attachments?.length && this.commandHandler) {
      const command = /^\/([a-z-]+)/i.exec(text)?.[1];
      if (command && COMMANDS.some((c) => c.command === command)) {
        try {
          const output = await this.commandHandler(owner, threadId, command, text.slice(command.length + 1).trim());
          // /clear and /new emptied the conversation server-side; the device must drop its
          // screen copy too, or it shows a chat that no longer exists on disk.
          if (command === "clear" || command === "new") {
            this.broadcast(owner, { type: "chat.cleared", threadId });
          }
          if (output) {
            this.broadcast(owner, {
              type: "chat.command.result",
              threadId,
              replyToId: frame.id,
              text: output,
            });
          }
          return;
        } catch (err) {
          void myClawAppLog("error", "command failed", { owner, threadId, command, error: String(err) });
          this.broadcast(owner, {
            type: "chat.command.result",
            threadId,
            replyToId: frame.id,
            text: `error: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
    }

    if (!this.messageHandler) return;

    const attachments: Attachment[] = [];
    for (const ref of frame.attachments ?? []) {
      const stored = await this.files.findById(owner, threadId, ref.id);
      if (!stored) {
        await myClawAppLog("warn", "attachment not found, dropped from the message", { owner, threadId, id: ref.id });
        continue;
      }
      // Only meaningful on audio, and gated on the type the file actually has: a client that
      // flags a jpeg as a voice note must not steer the STT policy with it.
      const voice = stored.type === "audio" && ref.audioAsVoice === true;
      attachments.push({
        // The stored type comes from the file itself; `ref.type` is whatever the client claimed,
        // and a jpeg announced as "file" would silently skip vision routing.
        type: stored.type,
        path: filePathFor(owner, threadId, stored.storedName),
        mimeType: stored.mimeType,
        filename: stored.filename,
        sizeBytes: stored.sizeBytes,
        ...(voice ? { audioAsVoice: true } : {}),
        ...(stored.type === "audio" && typeof ref.durationMs === "number" ? { durationMs: ref.durationMs } : {}),
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

  private async handleSessionRename(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionRename,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      await this.store.rename(ws.data.owner, threadId, frame.title ?? "");
      // Answered with the whole list, like every other mutation of it: the device renders the
      // result the server actually stored rather than the name it hoped for.
      this.handleSessionList(ws, { type: "session.list" });
    } catch (err) {
      await this.refuse(ws, "session", "rename failed", { threadId, error: String(err) });
    }
  }

  /**
   * One handler for both frames: a set is only useful if it answers with the resulting state,
   * and the app renders that same state either way.
   */
  private async handleVoiceMode(
    ws: ServerWebSocket<MyClawAppSessionData>,
    mode: "cloud" | "local" | "auto" | undefined,
  ): Promise<void> {
    if (!this.voice) {
      await this.refuse(ws, "voice", "voice control unavailable");
      return;
    }
    try {
      if (mode) {
        if (mode !== "cloud" && mode !== "local" && mode !== "auto") {
          await this.refuse(ws, "voice", "invalid voice mode", { mode });
          return;
        }
        await this.voice.setMode(mode);
      }
      this.sendFrame(ws, { type: "voice.mode.result", ...this.voice.status() });
    } catch (err) {
      await this.refuse(ws, "voice", "voice.mode failed", { mode, error: String(err) });
    }
  }

  private async handleModelList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.models) {
      await this.refuse(ws, "model", "model control unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "model.list.result", ...this.models.list() });
    } catch (err) {
      await this.refuse(ws, "model", "model.list failed", { error: String(err) });
    }
  }

  /**
   * One handler for get and set, like voice: the answer is the state the server stored, so the
   * app has no optimistic branch to keep in sync.
   */
  private async handleModel(
    ws: ServerWebSocket<MyClawAppSessionData>,
    threadId: string,
    modelId: string | undefined,
  ): Promise<void> {
    const safeThread = sanitizeThreadId(threadId);
    if (!safeThread) {
      await this.refuse(ws, "model", "invalid threadId", { threadId });
      return;
    }
    if (!this.models) {
      await this.refuse(ws, "model", "model control unavailable");
      return;
    }
    try {
      if (modelId !== undefined) {
        const known = this.models.list().models.some((m) => m.id === modelId);
        if (!known) {
          await this.refuse(ws, "model", "unknown model", { threadId: safeThread, model: modelId });
          return;
        }
        const state = await this.models.set(ws.data.owner, safeThread, modelId);
        this.sendFrame(ws, { type: "model.result", threadId: safeThread, ...state });
        return;
      }
      const state = await this.models.current(ws.data.owner, safeThread);
      this.sendFrame(ws, { type: "model.result", threadId: safeThread, ...state });
    } catch (err) {
      await this.refuse(ws, "model", "model failed", { threadId: safeThread, model: modelId, error: String(err) });
    }
  }

  private async handleModelEffort(
    ws: ServerWebSocket<MyClawAppSessionData>,
    threadId: string,
    level: string,
  ): Promise<void> {
    const safeThread = sanitizeThreadId(threadId);
    if (!safeThread) {
      await this.refuse(ws, "model", "invalid threadId", { threadId });
      return;
    }
    if (!this.models) {
      await this.refuse(ws, "model", "model control unavailable");
      return;
    }
    try {
      const state = await this.models.setEffort(ws.data.owner, safeThread, level);
      this.sendFrame(ws, { type: "model.result", threadId: safeThread, ...state });
    } catch (err) {
      await this.refuse(ws, "model", "model.effort.set failed", { threadId: safeThread, level, error: String(err) });
    }
  }

  private async handleChatStop(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppChatStop,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "chat", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    if (!this.stopRun) {
      await this.refuse(ws, "chat", "stop unavailable");
      return;
    }
    const sessionId = this.store.resolveSessionId(ws.data.owner, threadId);
    const stopped = this.stopRun(sessionId);
    // Same words as the /stop command, so the app and the chat agree on what happened.
    this.sendFrame(ws, {
      type: "chat.command.result",
      threadId,
      text: stopped ? "Stopped." : "Nothing running.",
    });
  }

  private async handleSessionClear(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionClear,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      await this.store.clear(ws.data.owner, threadId);
      this.sendFrame(ws, { type: "chat.cleared", threadId });
      this.sendFrame(ws, {
        type: "chat.command.result",
        threadId,
        text: "History cleared.",
      });
    } catch (err) {
      await this.refuse(ws, "session", "session.clear failed", { threadId, error: String(err) });
    }
  }

  /**
   * Single exit for every refusal: it reaches the device tagged with the screen that asked,
   * and it is always logged. A refusal that appears nowhere turned a server-side bug into a
   * button the user could only report as "dead".
   */
  private async refuse(
    ws: ServerWebSocket<MyClawAppSessionData>,
    scope: MyClawAppErrorScope,
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await myClawAppLog("warn", `refused: ${message}`, { deviceId: ws.data.deviceId, scope, ...data });
    this.sendFrame(ws, { type: "error", message, scope });
  }

  private async handleSessionList(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionList): Promise<void> {
    try {
      const sessions = await this.store.list(ws.data.owner);
      this.sendFrame(ws, { type: "session.list.result", sessions });
    } catch (err) {
      await this.refuse(ws, "session", "session list failed", { error: String(err) });
    }
  }

  private async handleSessionHistory(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionHistory): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      const messages = await this.store.history(ws.data.owner, threadId, frame.limit);
      const result: MyClawAppChatHistory = { type: "chat.history", threadId, messages };
      this.sendFrame(ws, result);
    } catch (err) {
      await this.refuse(ws, "session", "history failed", { threadId, error: String(err) });
    }
  }

  private async handleSessionArchive(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionArchive): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      await this.store.archive(ws.data.owner, threadId);
      await this.files.removeSessionFiles(ws.data.owner, threadId);
      this.sendFrame(ws, { type: "chat.history", threadId, messages: [] });
    } catch (err) {
      await this.refuse(ws, "session", "archive failed", { threadId, error: String(err) });
    }
  }

  private async handleSessionDelete(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionDelete): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      await this.store.remove(ws.data.owner, threadId);
      await this.files.removeSessionFiles(ws.data.owner, threadId);
      this.sendFrame(ws, { type: "chat.history", threadId, messages: [] });
    } catch (err) {
      await this.refuse(ws, "session", "delete failed", { threadId, error: String(err) });
    }
  }

  private async handleDiagSnapshot(
    ws: ServerWebSocket<MyClawAppSessionData>,
    deviceId: string,
    frame: MyClawAppDiagSnapshot,
  ): Promise<void> {
    if (!this.diagnostics) {
      await this.refuse(ws, "diag", "diagnostics unavailable");
      return;
    }
    try {
      const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;
      this.sendFrame(ws, { type: "diag.snapshot.result", text: await this.diagnostics.snapshot(deviceId, threadId) });
    } catch (err) {
      await this.refuse(ws, "diag", "diag.snapshot failed", { error: String(err) });
    }
  }

  private async handleLogsTail(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppLogsTail): Promise<void> {
    if (!this.diagnostics) {
      await this.refuse(ws, "logs", "diagnostics unavailable");
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
      await this.refuse(ws, "logs", "logs.tail failed", { error: String(err) });
    }
  }

  private async handleFilesList(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppFilesList): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "files", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      const [files, totalBytes] = await Promise.all([
        this.files.list(ws.data.owner, threadId),
        this.files.sessionSizeBytes(ws.data.owner, threadId),
      ]);
      this.sendFrame(ws, { type: "files.list.result", threadId, files, totalBytes });
    } catch (err) {
      await this.refuse(ws, "files", "files.list failed", { threadId, error: String(err) });
    }
  }

  private async handleFileDelete(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppFileDelete): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "files", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      const removed = await this.files.remove(ws.data.owner, threadId, frame.id);
      if (removed) {
        await this.handleFilesList(ws, { type: "files.list", threadId });
      } else {
        await this.refuse(ws, "files", "file not found", { threadId, id: frame.id });
      }
    } catch (err) {
      await this.refuse(ws, "files", "files.delete failed", { threadId, error: String(err) });
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

/** Serving reuses the store's table: two lists drifted apart once, and .opus was the casualty. */
function mimeTypeForPath(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).slice(1).toLowerCase()];
}
