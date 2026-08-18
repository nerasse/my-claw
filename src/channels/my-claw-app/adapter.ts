import type { Server, ServerWebSocket } from "bun";
import { basename } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ApprovalDecision,
  Attachment,
  ChannelAdapter,
  OutgoingMessage,
  ToolApprovalRequest,
  UnifiedMessage,
  ChatLocation,
} from "../types.ts";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { readAppVersion } from "../../core/diagnostics.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { PairingSockets, type PairSocketData } from "./pair-socket.ts";
import { createTicket, deny, pairingEnabled } from "./pairing.ts";
import { touchDevice } from "./devices.ts";
import { pairPageResponse } from "./pair-page.ts";
import { deviceOfSession, pruneOrphanSessions, readCookie, SESSION_COOKIE } from "./web-session.ts";
import {
  clientIp,
  pairRedirect,
  requestHost,
  requestIsSecure,
  securityHeaders,
  serveBundle,
  webEnabled,
} from "./web.ts";
import { currentRunId } from "../../utils/run-context.ts";
import { extractMediaRefs, stripMediaRefs, mediaTypeForPath } from "../../utils/media.ts";
import { commandsFor } from "../commands-catalog.ts";
import { redactCommandArgs } from "../command-log.ts";

/** What this channel advertises and what it intercepts, from one list so they cannot diverge. */
const APP_COMMANDS = commandsFor("my-claw-app");
import { SessionFileStore, filePathFor, parseStoredName } from "./files.ts";import type {
  MyClawAppApprovalRequest,
  MyClawAppApprovalResponse,
  MyClawAppAttachmentMeta,
  MyClawAppChatHistory,
  MyClawAppChatMessage,
  MyClawAppChatSend,
  MyClawAppHistoryAttachment,
  MyClawAppChatStop,
  MyClawAppClientFrame,
  MyClawAppErrorScope,
  MyClawAppFileDelete,
  MyClawAppFilesList,
  MyClawAppDiagReport,
  MyClawAppDiagSnapshot,
  MyClawAppLogsTail,
  MyClawAppServerFrame,
  MyClawAppSessionArchive,
  MyClawAppSessionUnarchive,
  MyClawAppSessionDelete,
  MyClawAppSessionPin,
  MyClawAppSessionPinOrder,
  MyClawAppSessionHistory,
  MyClawAppSessionList,
  MyClawAppSessionRename,
  MyClawAppSessionWorkspaceSet,
  MyClawAppSessionInstructionsGet,
  MyClawAppSubAgentsList,
  MyClawAppSubAgentsKill,
  MyClawAppSubAgentsReset,
  MyClawAppNotificationsRegister,
  MyClawAppNotificationsState,
  MyClawAppLocationCapabilities,
  MyClawAppLocationPreview,
} from "./types.ts";
import { DEFAULT_THREAD } from "./types.ts";
import { MyClawAppStreamer } from "./stream.ts";
import type { MyClawAppSessionStore } from "./sessions.ts";
import { sanitizeThreadId } from "./sessions.ts";
import { applyAddressOverride, normalizeLocationInput, type MyClawAppLocationResolver } from "./location.ts";
import type {
  MyClawAppAgentsController,
  MyClawAppCommandHandler,
  MyClawAppConfigController,
  MyClawAppDiagnosticsProvider,
  MyClawAppInstructionsController,
  MyClawAppJobsController,
  MyClawAppMcpController,
  MyClawAppModelController,
  MyClawAppNotificationsController,
  MyClawAppProvidersController,
  MyClawAppSessionData,
  MyClawAppSessionInstructionsProvider,
  MyClawAppSkillsController,
  MyClawAppSubAgentsController,
  MyClawAppTagsController,
  MyClawAppToolsController,
  MyClawAppVoiceController,
  MyClawAppWorkspacesController,
} from "./controllers.ts";
import {
  handleAgentFileCreate,
  handleAgentFileDelete,
  handleAgentFileGet,
  handleAgentFileSet,
  handleAgentsConfigGet,
  handleAgentsContextCapSet,
  handleAgentsFallbackSet,
  handleAgentsIterationsSet,
  handleAgentsModelClear,
  handleAgentsModelSet,
  handleAgentsScopeSet,
  handleAgentsWorkspaceSet,
  handleConfigGet,
  handleConfigSet,
  handleInstructionsGet,
  handleInstructionsLayerSet,
  handleInstructionsList,
  handleInstructionsSet,
  handleJobDelete,
  handleJobSave,
  handleJobsList,
  handleJobsRuns,
  handleMcpAdd,
  handleMcpEnable,
  handleMcpList,
  handleMcpRemove,
  handleModel,
  handleModelContext,
  handleModelEffort,
  handleModelEndpoints,
  handleModelList,
  handleModelRefresh,
  handleProviderEnvList,
  handleProviderEnvRemove,
  handleProviderEnvRename,
  handleProviderEnvSet,
  handleProviderRemove,
  handleProviderRename,
  handleProviderUpsert,
  handleSkillsList,
  handleSkillsTransfer,
  handleStatusGet,
  handleTagsDelete,
  handleTagsList,
  handleTagsUpsert,
  handleToolsList,
  handleToolsToggle,
  handleUpdateRun,
  handleVoiceMode,
  handleWorkspacesAdd,
  handleWorkspacesList,
  handleWorkspacesRemove,
  handleWorkspacesRename,
  handleWorkspacesSetPath,
} from "./settings-handlers.ts";
import type { MyClawAppSettingsDeps } from "./settings-handlers.ts";
import {
  dropDisabledSockets,
  handleDeviceList,
  handleDeviceRevoke,
  handlePairApprove,
  handlePairLookup,
  ownerFor,
  type MyClawAppDeviceDeps,
} from "./device-handlers.ts";
import {
  handleUpload,
  registerMedia,
  serveMedia,
  serveSkill,
  type MediaEntry,
  type MyClawAppFilesDeps,
} from "./files-http.ts";

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
// Healthy connections are idle on data frames for long stretches (protocol-level pings keep
// TCP alive); only reclaim sockets that look dead for 10 minutes.
const STALE_SOCKET_MS = 10 * 60 * 1000;
/** A pairing code lives minutes, so a silent pairing socket is reaped far sooner than a device. */
const STALE_PAIR_SOCKET_MS = 2 * 60 * 1000;
/** Open, unauthenticated pairing sockets allowed at once. Well past one person pairing a device. */
const MAX_PAIR_SOCKETS = 32;
/** Per frame. The device queues reports while offline, and one crash loop must not flood the log. */
const MAX_DIAG_REPORTS = 20;
/** How long a command may take before the app is told it is still running. */
const COMMAND_PENDING_NOTICE_MS = 400;

/** Commands that end the conversation they run in: their journal goes with the history they cut. */
const CLEARING_COMMANDS = new Set(["new"]);
const SWEEP_INTERVAL_MS = 30_000;
/** The id `SessionManager` builds for a conversation of this channel, read back the other way. */
const APP_THREAD_SESSION = /^my-claw-app\/thread\/([^/]+)\/(.+)$/;
interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MyClawAppAdapter implements ChannelAdapter {
  readonly platform = "my-claw-app" as const;
  private server?: Server<MyClawAppSessionData>;
  private sockets = new Map<string, ServerWebSocket<MyClawAppSessionData>>();
  private media = new Map<string, MediaEntry>();
  private mediaOrder: string[] = [];
  /** The unauthenticated pairing surface, kept behind its own object and its own route. */
  private pairSockets = new PairingSockets(() => this.config);
  /** Every open pairing socket, so the sweeper can reach the ones that never authenticate. */
  private pairing = new Set<ServerWebSocket<PairSocketData>>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private messageHandler?: (msg: UnifiedMessage) => Promise<void>;
  private diagnostics?: MyClawAppDiagnosticsProvider;
  private voice?: MyClawAppVoiceController;
  private models?: MyClawAppModelController;
  private agents?: MyClawAppAgentsController;
  private tags?: MyClawAppTagsController;
  private providers?: MyClawAppProvidersController;
  private skills?: MyClawAppSkillsController;
  private mcp?: MyClawAppMcpController;
  private tools?: MyClawAppToolsController;
  private instructions?: MyClawAppInstructionsController;
  private sessionInstructions?: MyClawAppSessionInstructionsProvider;
  private jobs?: MyClawAppJobsController;
  private notifications?: MyClawAppNotificationsController;
  private configEditor?: MyClawAppConfigController;
  private workspacesCtrl?: MyClawAppWorkspacesController;
  private commandHandler?: MyClawAppCommandHandler;
  private subagents?: MyClawAppSubAgentsController;
  private locationResolver?: MyClawAppLocationResolver;
  private stopRun?: (sessionId: string) => boolean;
  private runActive?: (sessionId: string) => boolean;
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
        // The device keeps the socket alive with OkHttp's 20s ping, which is a control frame and
        // never reaches `message`. Without these the sweeper read an idle `lastSeen` and reaped
        // healthy sockets at STALE_SOCKET_MS, once every 10 minutes, forever.
        //
        // Both handlers, and `ping` is the one that matters: it is the device's own 20s interval,
        // which we set. `pong` only fires in reply to a ping Bun sent on its own schedule, which
        // is undocumented and not configurable -- liveness must not depend on it.
        ping: (ws) => {
          ws.data.lastSeen = Date.now();
        },
        pong: (ws) => {
          ws.data.lastSeen = Date.now();
        },
      },
    });
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
    // A session whose device is gone is refused at every request anyway; dropping it at boot is
    // what keeps the store from carrying credentials nobody can account for.
    const orphans = await pruneOrphanSessions(Object.keys(this.config.devices ?? {})).catch(() => 0);
    if (orphans > 0) await myClawAppLog("info", "dropped web sessions with no device", { orphans });
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
    dropDisabledSockets(this.deviceDeps());
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

    // Attachments land in the same session store as uploads: they survive restarts, count
    // toward the conversation's file size, and die with the session.
    const threadId = message.threadId ?? DEFAULT_THREAD;
    const attachments: MyClawAppAttachmentMeta[] = [];
    for (const ref of mediaRefs) {
      const meta = await this.mediaForPath(owner, threadId, ref.path, { type: mediaTypeForPath(ref.path), audioAsVoice: ref.audioAsVoice, durationMs: ref.durationMs });
      if (meta) attachments.push(meta);
    }
    for (const att of attachmentsToSend) {
      if (!att.path) {
        await myClawAppLog("debug", "attachment without local path skipped", { type: att.type });
        continue;
      }
      const meta = await this.mediaForPath(owner, threadId, att.path, { type: att.type, mimeType: att.mimeType, filename: att.filename, sizeBytes: att.sizeBytes, width: att.width, height: att.height, durationMs: att.durationMs, audioAsVoice: att.audioAsVoice });
      if (meta) attachments.push(meta);
    }

    const frame: MyClawAppChatMessage = {
      type: "chat.message",
      id: crypto.randomUUID(),
      text,
      threadId,
      attachments,
      replyToId: message.replyToId,
      ...(currentRunId() ? { run: currentRunId() } : {}),
      ...(message.notice ? { notice: true } : {}),
    };
    this.broadcast(owner, frame);
  }

  /**
   * Copies a file the agent generated into the session store, then registers it as media.
   * A missing or unreadable source drops just that attachment: the message still goes out.
   */
  private async mediaForPath(owner: string, threadId: string, path: string, meta: { type?: "image" | "audio" | "video" | "file"; mimeType?: string; filename?: string; sizeBytes?: number; width?: number; height?: number; durationMs?: number; audioAsVoice?: boolean }): Promise<MyClawAppAttachmentMeta | undefined> {
    try {
      const file = await this.files.saveFromPath(owner, threadId, path, meta.filename);
      if (file.sizeBytes > this.files.warnSizeBytes) {
        await myClawAppLog("warn", "large attachment from agent", { owner, threadId, filename: file.filename, size: file.sizeBytes, threshold: this.files.warnSizeBytes });
      }
      return registerMedia(this.filesDeps(), filePathFor(owner, threadId, file.storedName), {
        // The bytes are in the store: its type is what the device must render, not a claim made
        // before the copy (the extension table decides, whatever the caller guessed).
        type: file.type !== "file" ? file.type : (meta.type ?? "file"),
        mimeType: file.mimeType,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        width: meta.width,
        height: meta.height,
        durationMs: meta.durationMs,
        audioAsVoice: meta.audioAsVoice,
      }, file.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "cannot read";
      await myClawAppLog("warn", "attachment skipped: not copied", { owner, threadId, path, reason });
      return undefined;
    }
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

  onAgentsController(controller: MyClawAppAgentsController): void {
    this.agents = controller;
  }

  onTagsController(controller: MyClawAppTagsController): void {
    this.tags = controller;
  }

  onProvidersController(controller: MyClawAppProvidersController): void {
    this.providers = controller;
  }

  onSkillsController(controller: MyClawAppSkillsController): void {
    this.skills = controller;
  }

  onMcpController(controller: MyClawAppMcpController): void {
    this.mcp = controller;
  }

  onToolsController(controller: MyClawAppToolsController): void {
    this.tools = controller;
  }

  onInstructionsController(controller: MyClawAppInstructionsController): void {
    this.instructions = controller;
  }

  onSessionInstructions(provider: MyClawAppSessionInstructionsProvider): void {
    this.sessionInstructions = provider;
  }

  onJobsController(controller: MyClawAppJobsController): void {
    this.jobs = controller;
  }

  onNotificationsController(controller: MyClawAppNotificationsController): void {
    this.notifications = controller;
  }

  onConfigController(controller: MyClawAppConfigController): void {
    this.configEditor = controller;
  }

  onWorkspacesController(controller: MyClawAppWorkspacesController): void {
    this.workspacesCtrl = controller;
  }

  /** Executes text slash commands; when absent, they fall through to the agent like any message. */
  onCommandHandler(handler: MyClawAppCommandHandler): void {
    this.commandHandler = handler;
  }

  /**
   * The sub-agents reachable from a session, and the two destructive actions on one. Injected like
   * everything else the adapter must not reach for: the visibility rule lives in the runner, so
   * every answer here is already filtered by it.
   */
  onSubAgentsController(controller: MyClawAppSubAgentsController): void {
    this.subagents = controller;
  }

  onLocationResolver(resolver: MyClawAppLocationResolver): void {
    this.locationResolver = resolver;
  }

  /** Stops the run of a session id (resolved here), so the adapter never reaches into core. */
  onStop(stop: (sessionId: string) => boolean): void {
    this.stopRun = stop;
  }

  /** Whether a session has a run in flight; injected because the adapter never reaches into core. */
  onRunActive(check: (sessionId: string) => boolean): void {
    this.runActive = check;
  }

  /**
   * Run lifecycle for one owner's sockets: the app pins its Stop button to these frames, not
   * to the stream bubbles, so the button survives tool calls and model turns.
   */
  /**
   * Pushes a thread's model state to the owner's devices, unasked. The header shows the share of
   * the context window this thread occupies, which moves at every turn of a run, and nothing
   * refreshed it between the opening of the thread and the end of the run: a long run displayed the
   * occupancy it had before starting. Same frame `model.get` answers, so the app applies it through
   * the path it already has.
   *
   * Never throws and never blocks the caller's turn: a header that failed to refresh must not fail
   * a run.
   */
  /**
   * The same push, addressed by the session id the agent hooks carry. Anything that is not one of
   * this channel's conversations is skipped: another channel's session, or a cron/sub-agent run the
   * app only displays, has no header of ours to refresh.
   */
  notifyModelStateForSession(sessionId: string): void {
    const match = APP_THREAD_SESSION.exec(sessionId);
    if (!match) return;
    void this.notifyModelState(match[1]!, match[2]!);
  }

  async notifyModelState(owner: string, threadId: string): Promise<void> {
    if (!this.models) return;
    try {
      const state = await this.models.current(owner, threadId);
      this.broadcast(owner, { type: "model.result", threadId, ...state });
    } catch (err) {
      await myClawAppLog("debug", "model state push failed", { threadId, error: String(err) });
    }
  }

  notifyRun(owner: string, threadId: string, active: boolean, reason?: "done" | "aborted" | "error"): void {
    if (active) {
      this.broadcast(owner, {
        type: "chat.run.start",
        threadId,
        ...(currentRunId() ? { run: currentRunId() } : {}),
      });
    } else {
      this.broadcast(owner, {
        type: "chat.run.end",
        threadId,
        reason: reason ?? "done",
        ...(currentRunId() ? { run: currentRunId() } : {}),
      });
    }
  }

  /**
   * Journals a run that died, so the error outlives the stream frame that showed it. Swallows its
   * own failure: this is called from a path that is already handling an error, and losing the
   * record of it must not replace the error the owner is being told about.
   */
  async recordFailure(owner: string, threadId: string, error: string): Promise<void> {
    try {
      await this.store.recordFailure(owner, threadId, error);
    } catch (err) {
      void myClawAppLog("error", "failure journal failed", { owner, threadId, error: String(err) });
    }
  }

  /**
   * The send is waiting for a compaction to finish before its run can start. Sent on its own
   * frame rather than as a notice bubble: it belongs to the message the owner already sees, and
   * the app lifts it when the stream finally arrives.
   */
  notifyQueued(owner: string, threadId: string, replyToId: string, reason: "compaction"): void {
    this.broadcast(owner, { type: "chat.send.queued", threadId, replyToId, reason });
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

  /** Rebuilt per frame: config is replaced wholesale on a hot reload, so a handler must read
   *  the one in force when the frame arrived. */
  private deviceDeps(): MyClawAppDeviceDeps {
    return {
      config: this.config,
      sockets: this.sockets,
      sendFrame: (ws, frame) => this.sendFrame(ws, frame),
    };
  }

  private socketsFor(owner: string): ServerWebSocket<MyClawAppSessionData>[] {
    return [...this.sockets.values()].filter((ws) => ws.data.owner === owner);
  }

  private broadcast(owner: string, frame: MyClawAppServerFrame): void {
    for (const ws of this.socketsFor(owner)) this.sendFrame(ws, frame);
  }

  /** The owner's other windows: for a frame the sender is the one surface that already has it. */
  private broadcastExcept(sender: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppServerFrame): void {
    for (const ws of this.socketsFor(sender.data.owner)) {
      if (ws !== sender) this.sendFrame(ws, frame);
    }
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

  /** Rebuilt per request: the caches are passed by reference, the controller by value, so a
   *  skills controller registered after boot is the one a request sees. */
  private filesDeps(): MyClawAppFilesDeps {
    return {
      skills: this.skills,
      files: this.files,
      media: this.media,
      mediaOrder: this.mediaOrder,
      thumbnails: this.thumbnails,
    };
  }

  private async handleFetch(req: Request, server: Server<MyClawAppSessionData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Every authenticated route resolves its device the same way: the query pair a native client
    // presents, or the session cookie a browser cannot avoid sending. One resolver, so a route
    // can never end up covering one of the two and not the other.
    if (url.pathname === "/media" && req.method === "POST") {
      const deviceId = this.authenticate(req, url);
      if (!deviceId) return new Response("Unauthorized", { status: 401 });
      return handleUpload(this.filesDeps(), ownerFor(this.config, deviceId), req);
    }

    if (url.pathname.startsWith("/media/")) {
      const id = url.pathname.slice("/media/".length);
      const deviceId = this.authenticate(req, url);
      if (!deviceId) return new Response("Unauthorized", { status: 401 });
      return serveMedia(this.filesDeps(), id, ownerFor(this.config, deviceId), url.searchParams.get("thumb") === "1");
    }

    if (url.pathname === "/skills") {
      if (!this.authenticate(req, url)) return new Response("Unauthorized", { status: 401 });
      return serveSkill(this.filesDeps(), 
        url.searchParams.get("source") ?? "",
        url.searchParams.get("name") ?? "",
        url.searchParams.get("workspace") ?? undefined,
      );
    }

    if (url.pathname === "/health") {
      if (!this.authenticate(req, url)) return new Response("Unauthorized", { status: 401 });
      return Response.json({ activeRun: runRegistry.hasAny() });
    }

    const secure = requestIsSecure(this.config, url, req.headers, server.requestIP(req)?.address);
    const host = requestHost(this.config, url, req.headers, server.requestIP(req)?.address);

    if (url.pathname === "/my-claw-app/pair") {
      if (!pairingEnabled(this.config)) return new Response("Not Found", { status: 404 });
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      const data: PairSocketData = {
        pairing: true,
        deviceId: "",
        owner: "",
        lastSeen: Date.now(),
        host,
        secure,
        origin: req.headers.get("origin") ?? undefined,
        ip: clientIp(this.config, req.headers, server.requestIP(req)?.address),
        userAgent: req.headers.get("user-agent") ?? undefined,
      };
      // Nothing here is authenticated, so the only defence is arithmetic: an upgrade costs a
      // socket and a file descriptor, and a client that never says `pair.hello` was under no
      // limit at all. The per-IP quota of the pairing store only starts at that first frame.
      if (this.pairSocketCount() >= MAX_PAIR_SOCKETS) {
        void myClawAppLog("warn", "pairing upgrade refused: too many open pairing sockets", {
          ip: data.ip, open: this.pairSocketCount(),
        });
        return new Response("Too Many Requests", { status: 429 });
      }
      if (server.upgrade(req, { data })) return undefined;
      return new Response("Upgrade Failed", { status: 500 });
    }

    if (url.pathname === "/my-claw-app/ticket" && req.method === "POST") {
      // `myclaw device add` mints the device by writing the config, then asks the running daemon
      // for a claim code: a ticket lives in memory, and the CLI is another process. The caller
      // authenticates with the credential it just created, so it can only ever ticket itself.
      const deviceId = url.searchParams.get("device") ?? "";
      if (!this.deviceFor(deviceId, url.searchParams.get("token") ?? "")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!pairingEnabled(this.config)) {
        return new Response("Pairing disabled", { status: 409 });
      }
      const device = this.config.devices?.[deviceId];
      if (!device) return new Response("Unauthorized", { status: 401 });
      const ticket = createTicket(this.config, {
        deviceId,
        owner: ownerFor(this.config, deviceId),
        name: device.name ?? deviceId,
        token: device.token,
      });
      return Response.json({ code: ticket.code, expiresAt: ticket.expiresAt, host });
    }

    if (url.pathname === "/my-claw-app/session" && req.method === "POST") {
      if (!pairingEnabled(this.config)) return new Response("Not Found", { status: 404 });
      return this.pairSockets.handleSessionPost(req, secure);
    }

    if (url.pathname === "/pair") {
      if (!pairingEnabled(this.config)) return new Response("Not Found", { status: 404 });
      // Already paired: the shell has nothing to offer, and showing a code would mint a second
      // device for a browser that already has one.
      if (this.cookieDevice(req)) {
        return new Response(null, { status: 302, headers: securityHeaders({ Location: "/" }) });
      }
      return pairPageResponse();
    }

    if (url.pathname === "/my-claw-app") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      const queryDevice = url.searchParams.get("device") ?? "";
      const byQuery = this.deviceFor(queryDevice, url.searchParams.get("token") ?? "");
      const cookieDevice = byQuery ? null : this.cookieDevice(req);
      if (cookieDevice && !this.originMatches(req, host)) {
        // A WebSocket handshake ignores the same-origin policy, so a cookie-authenticated socket
        // is reachable from any page unless the Origin is checked here.
        return new Response("Forbidden", { status: 403 });
      }
      const deviceId = byQuery ? queryDevice : cookieDevice;
      if (!deviceId) return new Response("Unauthorized", { status: 401 });
      if (server.upgrade(req, { data: { deviceId, owner: ownerFor(this.config, deviceId), lastSeen: Date.now() } })) {
        return undefined;
      }
      return new Response("Upgrade Failed", { status: 500 });
    }

    if (webEnabled(this.config)) {
      if (!this.cookieDevice(req)) {
        // A navigation is sent to the pairing shell; anything else gets a bare 401, so an
        // unauthenticated client cannot map what is installed by reading 404s.
        const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml && pairingEnabled(this.config)) {
          return new Response(null, {
            status: 302,
            headers: securityHeaders({ Location: pairRedirect(url.pathname) }),
          });
        }
        return new Response("Unauthorized", { status: 401, headers: securityHeaders() });
      }
      const served = await serveBundle(this.config, url.pathname);
      if (served) return served;
    }

    return new Response("Not Found", { status: 404 });
  }

  /** The device behind a request: query credentials for a native client, cookie for a browser. */
  private authenticate(req: Request, url: URL): string | null {
    const deviceId = url.searchParams.get("device") ?? "";
    if (deviceId && this.deviceFor(deviceId, url.searchParams.get("token") ?? "")) return deviceId;
    return this.cookieDevice(req);
  }

  /** The device a session cookie stands for, or null. Never trusts a cookie for a disabled device. */
  private cookieDevice(req: Request): string | null {
    const sessionId = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
    const deviceId = deviceOfSession(sessionId);
    if (!deviceId) return null;
    const device = this.config.devices?.[deviceId];
    if (!device || device.enabled === false) return null;
    return deviceId;
  }

  /** An Origin is compared with the host the browser used, not with a configured name: the
   *  instance is reached by tailnet name, LAN name and raw IP, and none of them is canonical. */
  private originMatches(req: Request, host: string): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  /** One extraction per video: an in-flight promise dedupes concurrent first requests, and the
   *  file on disk answers every later one. */
  private thumbnails = new Map<string, Promise<string | undefined>>();

  private handleOpen(ws: ServerWebSocket<MyClawAppSessionData>): void {
    if (ws.data.pairing) {
      this.pairing.add(ws as unknown as ServerWebSocket<PairSocketData>);
      void myClawAppLog("info", "pairing socket opened", { ip: ws.data.ip, origin: ws.data.origin });
      return;
    }
    void touchDevice(this.config, ws.data.deviceId);
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
    // The server names itself first: the settings page labels its "connected" state with it.
    void readAppVersion().then((version) => this.sendFrame(ws, { type: "hello", version }));
    const locationCapabilities: MyClawAppLocationCapabilities = {
      type: "location.capabilities",
      ...(this.locationResolver?.capabilities() ?? { enabled: false, address: false, provider: "geoapify" as const }),
    };
    this.sendFrame(ws, locationCapabilities);
    // The device needs the VAPID public key before it can register with its distributor;
    // sent at connect so the app can register on startup without another round-trip.
    void this.notifications?.info().then((vapidPublicKey) => {
      if (vapidPublicKey) this.sendFrame(ws, { type: "notifications.info", vapidPublicKey });
    });
  }

  private handleClose(ws: ServerWebSocket<MyClawAppSessionData>): void {
    if (ws.data.pairing) {
      this.pairing.delete(ws as unknown as ServerWebSocket<PairSocketData>);
      this.pairSockets.close(ws as unknown as ServerWebSocket<PairSocketData>);
      return;
    }
    if (this.sockets.get(ws.data.deviceId) === ws) {
      this.sockets.delete(ws.data.deviceId);
    }
    void myClawAppLog("info", "device disconnected", { deviceId: ws.data.deviceId });
  }

  /**
   * Nothing a device sends may reach the process-level crash handlers. A frame is typed on the
   * wire and nowhere else: one missing field used to throw straight out of this callback (or out
   * of the promise a handler returned) and take the whole daemon, every channel with it, down.
   */
  private handleMessage(ws: ServerWebSocket<MyClawAppSessionData>, message: string | Buffer): void {
    try {
      this.routeFrame(ws, message);
    } catch (err) {
      void myClawAppLog("error", "frame dispatch threw", {
        deviceId: ws.data.deviceId, error: String(err),
      });
    }
  }

  /** Same contract as `handleMessage`, for a handler that answers after its callback returned. */
  private detach(work: Promise<unknown>, handler: string): void {
    void work.catch((err) => {
      void myClawAppLog("error", "frame handler failed", { handler, error: String(err) });
    });
  }

  /**
   * The adapter state a settings handler runs against, read at dispatch: a controller is
   * registered after the constructor, so this is the same lookup the methods used to do.
   */
  private settingsDeps(): MyClawAppSettingsDeps {
    return {
      voice: this.voice,
      models: this.models,
      agents: this.agents,
      tags: this.tags,
      providers: this.providers,
      skills: this.skills,
      mcp: this.mcp,
      tools: this.tools,
      instructions: this.instructions,
      jobs: this.jobs,
      configEditor: this.configEditor,
      workspacesCtrl: this.workspacesCtrl,
      commandHandler: this.commandHandler,
      sendFrame: (ws, frame) => this.sendFrame(ws, frame),
      broadcastFrame: (owner, frame) => this.broadcast(owner, frame),
      refuse: (ws, scope, message, data) => this.refuse(ws, scope, message, data),
      sessionIdOf: (ws, threadId) => this.sessionIdOf(ws, threadId),
    };
  }

  private routeFrame(ws: ServerWebSocket<MyClawAppSessionData>, message: string | Buffer): void {
    ws.data.lastSeen = Date.now();
    const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");

    // A pairing socket never reaches a chat handler: it is unauthenticated, and its four frames
    // are the only thing this port accepts without a credential.
    if (ws.data.pairing) {
      this.pairSockets.message(ws as unknown as ServerWebSocket<PairSocketData>, raw);
      return;
    }

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
      this.detach(this.emitChatSend(ws, { type: "chat.send", id: crypto.randomUUID(), text: raw }), "emitChatSend");
      return;
    }

    switch (frame.type) {
      case "chat.send":
        this.detach(this.emitChatSend(ws, frame), "emitChatSend");
        break;
      case "location.preview":
        this.detach(this.handleLocationPreview(ws, frame), "handleLocationPreview");
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
        this.detach(this.handleSessionList(ws, frame), "handleSessionList");
        break;
      case "diag.snapshot":
        this.detach(this.handleDiagSnapshot(ws, ws.data.owner, frame), "handleDiagSnapshot");
        break;
      case "diag.report":
        this.detach(this.handleDiagReport(ws, frame), "handleDiagReport");
        break;
      case "logs.tail":
        this.detach(this.handleLogsTail(ws, frame), "handleLogsTail");
        break;
      case "commands.list":
        void ws.send(JSON.stringify({
          type: "commands.list.result",
          commands: APP_COMMANDS.map(({ command, description }) => ({ name: command, description })),
        }));
        break;
      case "files.list":
        this.detach(this.handleFilesList(ws, frame), "handleFilesList");
        break;
      case "session.rename":
        this.detach(this.handleSessionRename(ws, frame), "handleSessionRename");
        break;
      case "session.workspace.set":
        this.detach(this.handleSessionWorkspaceSet(ws, frame), "handleSessionWorkspaceSet");
        break;
      case "voice.mode.get":
        this.detach(handleVoiceMode(this.settingsDeps(), ws, undefined), "handleVoiceMode");
        break;
      case "voice.mode.set":
        this.detach(handleVoiceMode(this.settingsDeps(), ws, frame.mode), "handleVoiceMode");
        break;
      case "update.run":
        this.detach(handleUpdateRun(this.settingsDeps(), ws), "handleUpdateRun");
        break;
      case "model.refresh":
        this.detach(handleModelRefresh(this.settingsDeps(), ws), "handleModelRefresh");
        break;
      case "model.list":
        this.detach(handleModelList(this.settingsDeps(), ws), "handleModelList");
        break;
      case "model.endpoints":
        this.detach(handleModelEndpoints(this.settingsDeps(), ws, frame.model), "handleModelEndpoints");
        break;
      case "skills.copy":
      case "skills.move":
        this.detach(handleSkillsTransfer(this.settingsDeps(), ws, frame), "handleSkillsTransfer");
        break;
      case "skills.list":
        this.detach(handleSkillsList(this.settingsDeps(), ws), "handleSkillsList");
        break;
      case "workspaces.list":
        this.detach(handleWorkspacesList(this.settingsDeps(), ws), "handleWorkspacesList");
        break;
      case "workspaces.add":
        this.detach(handleWorkspacesAdd(this.settingsDeps(), ws, frame), "handleWorkspacesAdd");
        break;
      case "workspaces.remove":
        this.detach(handleWorkspacesRemove(this.settingsDeps(), ws, frame), "handleWorkspacesRemove");
        break;
      case "workspaces.rename":
        this.detach(handleWorkspacesRename(this.settingsDeps(), ws, frame), "handleWorkspacesRename");
        break;
      case "workspaces.path.set":
        this.detach(handleWorkspacesSetPath(this.settingsDeps(), ws, frame), "handleWorkspacesSetPath");
        break;
      case "mcp.list":
        this.detach(handleMcpList(this.settingsDeps(), ws), "handleMcpList");
        break;
      case "tools.list":
        this.detach(handleToolsList(this.settingsDeps(), ws), "handleToolsList");
        break;
      case "instructions.list":
        this.detach(handleInstructionsList(this.settingsDeps(), ws), "handleInstructionsList");
        break;
      case "instructions.get":
        this.detach(handleInstructionsGet(this.settingsDeps(), ws, frame), "handleInstructionsGet");
        break;
      case "instructions.set":
        this.detach(handleInstructionsSet(this.settingsDeps(), ws, frame), "handleInstructionsSet");
        break;
      case "instructions.layer.set":
        this.detach(handleInstructionsLayerSet(this.settingsDeps(), ws, frame), "handleInstructionsLayerSet");
        break;
      case "model.get":
        this.detach(handleModel(this.settingsDeps(), ws, frame.threadId, undefined), "handleModel");
        break;
      case "model.set":
        this.detach(handleModel(this.settingsDeps(), ws, frame.threadId, frame.model), "handleModel");
        break;
      case "model.effort.set":
        this.detach(handleModelEffort(this.settingsDeps(), ws, frame.threadId, frame.level), "handleModelEffort");
        break;
      case "model.context.set":
        this.detach(handleModelContext(this.settingsDeps(), ws, frame), "handleModelContext");
        break;
      case "agents.config.get":
        this.detach(handleAgentsConfigGet(this.settingsDeps(), ws, frame), "handleAgentsConfigGet");
        break;
      case "tags.list":
        this.detach(handleTagsList(this.settingsDeps(), ws), "handleTagsList");
        break;
      case "tags.upsert":
        this.detach(handleTagsUpsert(this.settingsDeps(), ws, frame), "handleTagsUpsert");
        break;
      case "tags.delete":
        this.detach(handleTagsDelete(this.settingsDeps(), ws, frame), "handleTagsDelete");
        break;
      case "providers.upsert":
        this.detach(handleProviderUpsert(this.settingsDeps(), ws, frame), "handleProviderUpsert");
        break;
      case "providers.remove":
        this.detach(handleProviderRemove(this.settingsDeps(), ws, frame), "handleProviderRemove");
        break;
      case "providers.rename":
        this.detach(handleProviderRename(this.settingsDeps(), ws, frame), "handleProviderRename");
        break;
      case "providers.env.set":
        this.detach(handleProviderEnvSet(this.settingsDeps(), ws, frame), "handleProviderEnvSet");
        break;
      case "providers.env.rename":
        this.detach(handleProviderEnvRename(this.settingsDeps(), ws, frame), "handleProviderEnvRename");
        break;
      case "providers.env.list":
        this.detach(handleProviderEnvList(this.settingsDeps(), ws), "handleProviderEnvList");
        break;
      case "providers.env.remove":
        this.detach(handleProviderEnvRemove(this.settingsDeps(), ws, frame), "handleProviderEnvRemove");
        break;
      case "agents.model.set":
        this.detach(handleAgentsModelSet(this.settingsDeps(), ws, frame), "handleAgentsModelSet");
        break;
      case "agents.model.clear":
        this.detach(handleAgentsModelClear(this.settingsDeps(), ws, frame), "handleAgentsModelClear");
        break;
      case "agents.fallback.set":
        this.detach(handleAgentsFallbackSet(this.settingsDeps(), ws, frame), "handleAgentsFallbackSet");
        break;
      case "agents.scope.set":
        this.detach(handleAgentsScopeSet(this.settingsDeps(), ws, frame), "handleAgentsScopeSet");
        break;
      case "agents.workspace.set":
        this.detach(handleAgentsWorkspaceSet(this.settingsDeps(), ws, frame), "handleAgentsWorkspaceSet");
        break;
      case "agents.iterations.set":
        this.detach(handleAgentsIterationsSet(this.settingsDeps(), ws, frame), "handleAgentsIterationsSet");
        break;
      case "agents.contextcap.set":
        this.detach(handleAgentsContextCapSet(this.settingsDeps(), ws, frame), "handleAgentsContextCapSet");
        break;
      case "agents.file.get":
        this.detach(handleAgentFileGet(this.settingsDeps(), ws, frame), "handleAgentFileGet");
        break;
      case "agents.file.set":
        this.detach(handleAgentFileSet(this.settingsDeps(), ws, frame), "handleAgentFileSet");
        break;
      case "agents.file.create":
        this.detach(handleAgentFileCreate(this.settingsDeps(), ws, frame), "handleAgentFileCreate");
        break;
      case "agents.file.delete":
        this.detach(handleAgentFileDelete(this.settingsDeps(), ws, frame), "handleAgentFileDelete");
        break;
      case "tools.toggle":
        this.detach(handleToolsToggle(this.settingsDeps(), ws, frame), "handleToolsToggle");
        break;
      case "mcp.add":
        this.detach(handleMcpAdd(this.settingsDeps(), ws, frame), "handleMcpAdd");
        break;
      case "mcp.remove":
        this.detach(handleMcpRemove(this.settingsDeps(), ws, frame), "handleMcpRemove");
        break;
      case "mcp.enable":
        this.detach(handleMcpEnable(this.settingsDeps(), ws, frame), "handleMcpEnable");
        break;
      case "config.get":
        this.detach(handleConfigGet(this.settingsDeps(), ws, frame), "handleConfigGet");
        break;
      case "config.set":
        this.detach(handleConfigSet(this.settingsDeps(), ws, frame), "handleConfigSet");
        break;
      case "chat.stop":
        this.detach(this.handleChatStop(ws, frame), "handleChatStop");
        break;
      case "status.get":
        this.detach(handleStatusGet(this.settingsDeps(), ws, frame), "handleStatusGet");
        break;
      case "session.instructions.get":
        this.detach(this.handleSessionInstructionsGet(ws, frame), "handleSessionInstructionsGet");
        break;
      case "jobs.list":
        this.detach(handleJobsList(this.settingsDeps(), ws), "handleJobsList");
        break;
      case "jobs.runs":
        this.detach(handleJobsRuns(this.settingsDeps(), ws, frame), "handleJobsRuns");
        break;
      case "device.list":
        handleDeviceList(this.deviceDeps(), ws);
        break;
      case "device.revoke":
        this.detach(handleDeviceRevoke(this.deviceDeps(), ws, frame.deviceId), "handleDeviceRevoke");
        break;
      case "device.pair.lookup":
        handlePairLookup(this.deviceDeps(), ws, frame.code);
        break;
      case "device.pair.approve":
        this.detach(handlePairApprove(this.deviceDeps(), ws, frame.code, frame.name), "handlePairApprove");
        break;
      case "device.pair.deny":
        this.sendFrame(ws, {
          type: "device.pair.result",
          ok: deny(frame.code, ws.data.deviceId),
        });
        break;
      case "subagents.list":
        this.detach(this.handleSubAgentsList(ws, frame), "handleSubAgentsList");
        break;
      case "subagents.kill":
      case "subagents.reset":
        this.detach(this.handleSubAgentAction(ws, frame), "handleSubAgentAction");
        break;
      case "jobs.save":
        this.detach(handleJobSave(this.settingsDeps(), ws, frame), "handleJobSave");
        break;
      case "jobs.delete":
        this.detach(handleJobDelete(this.settingsDeps(), ws, frame), "handleJobDelete");
        break;
      case "notifications.register":
        this.detach(this.handleNotificationsRegister(ws, frame), "handleNotificationsRegister");
        break;
      case "notifications.state":
        this.detach(this.handleNotificationsState(ws, frame), "handleNotificationsState");
        break;

      case "files.delete":
        this.detach(this.handleFileDelete(ws, frame), "handleFileDelete");
        break;
      case "session.history":
        this.detach(this.handleSessionHistory(ws, frame), "handleSessionHistory");
        break;
      case "session.archive":
      case "session.unarchive":
        this.detach(this.handleSessionArchive(ws, frame), "handleSessionArchive");
        break;
      case "session.delete":
        this.detach(this.handleSessionDelete(ws, frame), "handleSessionDelete");
        break;
      case "session.pin":
      case "session.pin.order":
        this.detach(this.handleSessionPin(ws, frame), "handleSessionPin");
        break;
    }
  }

  /**
   * Answers a composer preview: geocode the staged fix without persisting anything. The same
   * resolver (and cache) as chat.send, so the previewed address is the one the message gets.
   */
  private async handleLocationPreview(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppLocationPreview,
  ): Promise<void> {
    try {
      const input = normalizeLocationInput(frame.location);
      const location = this.locationResolver ? await this.locationResolver.resolve(input) : input;
      this.sendFrame(ws, { type: "location.preview.result", id: frame.id, location });
    } catch (err) {
      await this.refuse(ws, "location", err instanceof Error ? err.message : "invalid location");
    }
  }

  /**
   * Writes a command and its bubble into the conversation's journal. Three things are left out
   * on purpose: a command that emptied the conversation (`/new` starts a history, it is not part
   * of one), an answer the app draws as a page instead of a bubble (a structured `/status`, which
   * is a live snapshot), and the credentials `redactCommandArgs` masks.
   */
  private async journalCommand(
    owner: string,
    threadId: string,
    command: string,
    args: string,
    output: string,
    renderedAsPage: boolean,
    details: string | undefined,
    sourceId: string,
  ): Promise<void> {
    if (renderedAsPage || CLEARING_COMMANDS.has(command)) return;
    const redacted = redactCommandArgs(command, args);
    const input = redacted ? `/${command} ${redacted}` : `/${command}`;
    try {
      await this.store.recordCommand(owner, threadId, input, output, details, sourceId);
    } catch (err) {
      void myClawAppLog("error", "command journal failed", { owner, threadId, command, error: String(err) });
    }
  }

  private async emitChatSend(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppChatSend,
  ): Promise<void> {
    const owner = ws.data.owner;
    // The frame is only typed on the wire: an app one version off, or one bug in its serializer,
    // sends a `chat.send` with no text at all.
    const text = typeof frame.text === "string" ? frame.text.trim() : "";
    const refs = Array.isArray(frame.attachments) ? frame.attachments : [];
    const hasLocation = frame.location !== undefined;
    if (!text && refs.length === 0 && !hasLocation) return;

    const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;

    // Slash commands run on the server, exactly as they do on the other channels: a command
    // sent to the model as a plain question would be answered from nothing. The user's own
    // bubble is drawn by the app from its send; only the result is new here. Only the catalog
    // is intercepted: an unknown /word is a question like any other and must reach the agent.
    if (text && refs.length === 0 && !hasLocation && this.commandHandler) {
      const command = /^\/([a-z-]+)/i.exec(text)?.[1];
      if (command && APP_COMMANDS.some((c) => c.command === command)) {
        const args = text.slice(command.length + 1).trim();
        // A command is a prompt too: the other windows show what was typed, then its answer.
        this.echoUserMessage(ws, threadId, frame, text, []);
        // Most commands answer in a blink and a placeholder bubble would only flicker. The slow
        // ones (a `/compact` on a full session runs for minutes) would otherwise leave the chat
        // silent with nothing to show for it, so the notice is sent on a delay: whichever comes
        // first wins, and the result replaces the notice when both were sent.
        const pending = setTimeout(() => {
          this.broadcast(owner, {
            type: "chat.command.pending",
            threadId,
            replyToId: frame.id,
            text: `Running /${command}...`,
          });
        }, COMMAND_PENDING_NOTICE_MS);
        try {
          const output = await this.commandHandler(owner, threadId, command, args);
          clearTimeout(pending);
          // /new emptied the conversation server-side; the device must drop its screen copy
          // too, or it shows a chat that no longer exists on disk.
          if (command === "new") {
            this.broadcast(owner, { type: "chat.cleared", threadId });
          }
          if (output) {
            const text = typeof output === "string" ? output : output.text;
            const status = typeof output === "string" ? undefined : output.status;
            const details = typeof output === "string" ? undefined : output.details;
            this.broadcast(owner, {
              type: "chat.command.result",
              threadId,
              replyToId: frame.id,
              text,
              ...(status ? { status } : {}),
              ...(details ? { details } : {}),
            });
            await this.journalCommand(owner, threadId, command, args, text, status !== undefined, details, frame.id);
          }
          return;
        } catch (err) {
          clearTimeout(pending);
          void myClawAppLog("error", "command failed", { owner, threadId, command, error: String(err) });
          const failure = `error: ${err instanceof Error ? err.message : String(err)}`;
          this.broadcast(owner, { type: "chat.command.result", threadId, replyToId: frame.id, text: failure });
          await this.journalCommand(owner, threadId, command, args, failure, false, undefined, frame.id);
          return;
        }
      }
    }

    if (!this.messageHandler) return;

    let location: ChatLocation | undefined;
    if (hasLocation) {
      try {
        const input = normalizeLocationInput(frame.location);
        const resolved = this.locationResolver ? await this.locationResolver.resolve(input) : input;
        const override = (frame.location as { addressOverride?: unknown } | undefined)?.addressOverride;
        if (override !== undefined) {
          if (!override || typeof override !== "object" || typeof (override as { formatted?: unknown }).formatted !== "string") {
            throw new Error("addressOverride.formatted must be a string");
          }
          location = applyAddressOverride(resolved, (override as { formatted: string }).formatted);
        } else {
          location = resolved;
        }
      } catch (err) {
        await this.refuse(ws, "location", err instanceof Error ? err.message : "invalid location");
        return;
      }
      this.broadcast(owner, {
        type: "chat.location",
        threadId,
        replyToId: frame.id,
        location,
      });
    }

    const attachments: Attachment[] = [];
    const echoed: MyClawAppHistoryAttachment[] = [];
    for (const ref of refs) {
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
      // The other windows hold no local copy of the file: they name it by its stored id and
      // fetch it over the media route, exactly as a replayed turn does.
      echoed.push({
        id: stored.id,
        type: stored.type,
        mimeType: stored.mimeType,
        filename: stored.filename,
        sizeBytes: stored.sizeBytes,
        ...(voice ? { audioAsVoice: true } : {}),
        ...(stored.type === "audio" && typeof ref.durationMs === "number" ? { durationMs: ref.durationMs } : {}),
      });
    }

    // Before the run, so the answer that follows finds the question it replies to already on
    // screen: a stream whose parent is missing draws its bubble at the end of the thread.
    this.echoUserMessage(ws, threadId, frame, text, echoed, location);

    void this.messageHandler({
      id: frame.id,
      platform: "my-claw-app",
      userId: owner,
      chatId: owner,
      chatType: "dm",
      text,
      timestamp: frame.ts,
      attachments,
      ...(location ? { location } : {}),
      isForwarded: false,
      threadId,
      sessionScope: "per-user",
      raw: frame,
    }).catch((err) => {
      void myClawAppLog("error", "message handling failed", { owner, error: String(err) });
    });
  }

  /**
   * Mirrors a prompt to the owner's *other* windows. The sender drew this bubble the moment it
   * hit send and owns the id, so echoing it back would be a frame whose only job is to be
   * ignored. The app still drops an echo whose id it already holds, as a reconnect can put two
   * sockets of one window in the list for a moment.
   */
  private echoUserMessage(
    ws: ServerWebSocket<MyClawAppSessionData>,
    threadId: string,
    frame: MyClawAppChatSend,
    text: string,
    attachments: MyClawAppHistoryAttachment[],
    location?: ChatLocation,
  ): void {
    this.broadcastExcept(ws, {
      type: "chat.user",
      threadId,
      id: frame.id,
      text,
      ...(frame.ts ? { ts: frame.ts } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(location ? { location } : {}),
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

  private async handleSessionWorkspaceSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionWorkspaceSet,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    if (!frame.workspace) {
      await this.refuse(ws, "session", "workspace is required", { threadId });
      return;
    }
    try {
      await this.store.setWorkspace(ws.data.owner, threadId, frame.workspace);
      this.sendFrame(ws, { type: "session.workspace.set.result", threadId, workspace: frame.workspace });
    } catch (err) {
      await this.refuse(ws, "session", "workspace.set failed", { threadId, workspace: frame.workspace, error: String(err) });
    }
  }

  private async handleSubAgentsList(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSubAgentsList,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "subagents", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    if (!this.subagents) {
      await this.refuse(ws, "subagents", "sub-agents unavailable");
      return;
    }
    try {
      const agents = await this.subagents.list(this.store.resolveSessionId(ws.data.owner, threadId));
      this.sendFrame(ws, { type: "subagents.list.result", threadId, agents });
    } catch (err) {
      await this.refuse(ws, "subagents", "subagents.list failed", { threadId, error: String(err) });
    }
  }

  /**
   * One handler for both destructive actions: they differ only in which runner method runs, and
   * both answer with the parent's roster so the app never has to guess what survived.
   */
  private async handleSubAgentAction(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSubAgentsKill | MyClawAppSubAgentsReset,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    const parentThreadId = sanitizeThreadId(frame.parentThreadId);
    if (!threadId || !parentThreadId) {
      await this.refuse(ws, "subagents", "invalid threadId", { threadId: frame.threadId, parentThreadId: frame.parentThreadId });
      return;
    }
    if (!this.subagents) {
      await this.refuse(ws, "subagents", "sub-agents unavailable");
      return;
    }
    const caller = this.store.resolveSessionId(ws.data.owner, parentThreadId);
    try {
      const outcome = frame.type === "subagents.kill"
        ? await this.subagents.kill(threadId, caller)
        : await this.subagents.reset(threadId, caller);
      // The runner reports a refusal as text rather than throwing, and an unreachable sub-agent is
      // indistinguishable from a missing one on purpose (docs/subagent-visibility.md).
      if (outcome.startsWith("Error:")) {
        await this.refuse(ws, "subagents", outcome, { threadId });
        return;
      }
      const agents = await this.subagents.list(caller);
      this.sendFrame(ws, { type: "subagents.list.result", threadId: parentThreadId, agents });
    } catch (err) {
      await this.refuse(ws, "subagents", `${frame.type} failed`, { threadId, error: String(err) });
    }
  }

  private async handleNotificationsRegister(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppNotificationsRegister,
  ): Promise<void> {
    if (!this.notifications) {
      await this.refuse(ws, "notifications", "notifications unavailable");
      return;
    }
    try {
      if (frame.endpoint) {
        await this.notifications.register(ws.data.deviceId, frame);
      } else {
        await this.notifications.unregister(ws.data.deviceId);
      }
    } catch (err) {
      await this.refuse(ws, "notifications", "notifications.register failed", { error: String(err) });
    }
  }

  private async handleNotificationsState(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppNotificationsState,
  ): Promise<void> {
    if (!this.notifications) return;
    await this.notifications.setForeground(ws.data.deviceId, {
      foreground: Boolean(frame.foreground),
      threadId: frame.threadId || undefined,
    });
  }

  /** The session a frame names, as a spreadable field: an unusable threadId yields nothing at
   *  all, so an absolute nested path arrives with no session to authorise it. */
  private sessionIdOf(ws: ServerWebSocket<MyClawAppSessionData>, threadId: string | undefined): { sessionId?: string } {
    const clean = threadId ? sanitizeThreadId(threadId) : null;
    return clean ? { sessionId: this.store.resolveSessionId(ws.data.owner, clean) } : {};
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

  /**
   * What this conversation is loaded with, composed on demand: the report is a snapshot of the
   * next run's prompt, not of the last one's, because that is the one the owner can still change.
   */
  private async handleSessionInstructionsGet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionInstructionsGet,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "instructions", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    if (!this.sessionInstructions) {
      await this.refuse(ws, "instructions", "session instructions unavailable");
      return;
    }
    try {
      const instructions = await this.sessionInstructions(this.store.resolveSessionId(ws.data.owner, threadId));
      this.sendFrame(ws, { type: "session.instructions.result", threadId, instructions });
    } catch (err) {
      await this.refuse(ws, "instructions", "session.instructions.get failed", { error: String(err) });
    }
  }

  /**
   * Single exit for every refusal: it reaches the device tagged with the screen that asked,
   * and it is always logged. A refusal that appeared nowhere turned a server-side bug into a
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
      const withRuns = this.runActive
        ? sessions.map((session) => ({ ...session, activeRun: this.runActive!(this.store.resolveSessionId(ws.data.owner, session.threadId)) }))
        : sessions;
      this.sendFrame(ws, { type: "session.list.result", sessions: withRuns });
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
      const page = await this.store.history(ws.data.owner, threadId, frame.limit, frame.before);
      const result: MyClawAppChatHistory = {
        type: "chat.history",
        threadId,
        messages: page.entries,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        // Echoed so the app can tell an older page, which it prepends, from the newest one,
        // which replaces the thread. The two arrive on the same frame type.
        ...(frame.before ? { before: frame.before } : {}),
      };
      this.sendFrame(ws, result);
    } catch (err) {
      await this.refuse(ws, "session", "history failed", { threadId, error: String(err) });
    }
  }

  /**
   * Archiving keeps everything: messages, uploads and title all stay put, and the reply is the
   * refreshed listing so the thread moves between the two lists in one round-trip.
   */
  private async handleSessionArchive(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionArchive | MyClawAppSessionUnarchive,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    const archiving = frame.type === "session.archive";
    try {
      if (archiving) await this.store.archive(ws.data.owner, threadId);
      else await this.store.unarchive(ws.data.owner, threadId);
      const sessions = await this.store.list(ws.data.owner);
      this.sendFrame(ws, { type: "session.list.result", sessions });
    } catch (err) {
      const action = archiving ? "archive" : "unarchive";
      await this.refuse(ws, "session", `${action} failed`, { threadId, error: String(err) });
    }
  }

  /**
   * A pin belongs to the owner, not to the device that set it: the refreshed listing goes to
   * every socket of that owner, so a second client open on the drawer moves with the first
   * instead of showing an order nobody chose anymore.
   */
  private async handleSessionPin(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionPin | MyClawAppSessionPinOrder,
  ): Promise<void> {
    const owner = ws.data.owner;
    try {
      if (frame.type === "session.pin") {
        const threadId = sanitizeThreadId(frame.threadId);
        if (!threadId) {
          await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
          return;
        }
        await this.store.setPinned(owner, threadId, frame.pinned);
      } else {
        await this.store.setPinOrder(owner, frame.threadIds);
      }
      const sessions = await this.store.list(owner);
      this.broadcast(owner, { type: "session.list.result", sessions });
    } catch (err) {
      await this.refuse(ws, "session", "pin failed", { error: String(err) });
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

  /**
   * Post-mortems, so they describe a process that is already gone: logged at error level and
   * acknowledged, and only then does the device drop them from its own store. An unacknowledged
   * report is kept and resent, because losing the trace of the crash that killed the app is the
   * one failure mode this whole path exists to prevent.
   */
  private async handleDiagReport(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppDiagReport,
  ): Promise<void> {
    const reports = Array.isArray(frame.reports) ? frame.reports.slice(0, MAX_DIAG_REPORTS) : [];
    for (const report of reports) {
      await myClawAppLog("error", "device diagnostic", {
        deviceId: ws.data.deviceId,
        kind: report.kind,
        at: new Date(typeof report.at === "number" ? report.at : Date.now()).toISOString(),
        message: String(report.message ?? "").slice(0, 2000),
        ...(report.reason ? { reason: report.reason } : {}),
        ...(report.appVersion ? { appVersion: report.appVersion } : {}),
        ...(typeof report.stack === "string" ? { stack: report.stack.slice(0, 8000) } : {}),
      });
    }
    ws.send(JSON.stringify({ type: "diag.report.result", accepted: reports.length }));
  }

  /**
   * Keeps a quiet socket alive, and finds out early when it is not.
   *
   * The Android app pings every 20s from OkHttp, which is what kept `lastSeen` fresh. A browser
   * cannot: JavaScript has no way to send a WebSocket ping frame. A web client that sat there
   * reading was therefore reaped as stale, and any socket the OS had already dropped stayed in
   * the map until the next sweep. Pinging from here covers both: the browser's own stack answers
   * with a pong (the `pong` handler refreshes `lastSeen`), and a dead socket surfaces at once.
   */
  private keepAlive(): void {
    for (const ws of this.sockets.values()) {
      try {
        ws.ping();
      } catch {
        // A socket that cannot be pinged is gone; the sweep below takes it out.
      }
    }
  }

  private sweep(): void {
    this.keepAlive();
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
    // A pairing socket is unauthenticated and short-lived by nature: a code expires in minutes,
    // so one still silent long after that is not a browser waiting, it is a socket held open.
    for (const ws of this.pairing) {
      if (now - ws.data.lastSeen <= STALE_PAIR_SOCKET_MS) continue;
      try {
        ws.close(1001, "stale");
      } catch {
        // already closed
      }
      this.pairing.delete(ws);
    }
  }

  private pairSocketCount(): number {
    return this.pairing.size;
  }
}
