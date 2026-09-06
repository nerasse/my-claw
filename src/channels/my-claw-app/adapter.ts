import type { Server, ServerWebSocket } from "bun";
import { basename } from "node:path";
import { handleBrowserInfo } from "./browser-handlers.ts";
import type { BrowserConfig } from "../../core/config.ts";
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
import { ALWAYS_PER_INVOCATION } from "../../agent/approvals.ts";
import { approvalStats, listApprovals, recordApproval, serializeArgs, type ApprovalOutcome } from "../../approvals/store.ts";
import { PairingSockets, type PairSocketData } from "./pair-socket.ts";
import { questionManager, type PendingQuestion } from "../../questions/manager.ts";
import { undoManager } from "./undo.ts";
import { latestAppUpdate, streamAppApk } from "./updates.ts";
import { SocketRegistry } from "./socket-registry.ts";
import { LiveTurnJournal } from "./live-turn.ts";
import { LruMap } from "../../utils/lru-map.ts";
import { questionAskFrame, questionPendingFrame } from "./questions.ts";
import { newEntryId } from "../../sessions/log.ts";
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
  MyClawAppApprovalHistory,
  MyClawAppQuestionReply,
  MyClawAppUndoChoose,
  MyClawAppUndoCancel,
  MyClawAppAttachmentMeta,
  MyClawAppChatCompacting,
  MyClawAppChatHistory,
  MyClawAppChatMessage,
  MyClawAppChatSend,
  MyClawAppHistoryAttachment,
  MyClawAppChatStop,
  MyClawAppClientFrame,
  MyClawAppErrorScope,
  MyClawAppFileDelete,
  MyClawAppFilesList,
  MyClawAppFilesListResult,
  MyClawAppDiagReport,
  MyClawAppDiagSnapshot,
  MyClawAppLogsTail,
  MyClawAppServerFrame,
  MyClawAppSessionArchive,
  MyClawAppSessionUnarchive,
  MyClawAppDraftSet,
  MyClawAppSessionDelete,
  MyClawAppSessionPin,
  MyClawAppSessionPinOrder,
  MyClawAppSessionHistory,
  MyClawAppSessionSync,
  MyClawAppSessionSyncResult,
  MyClawAppToolFull,
  MyClawAppSessionRunItems,
  MyClawAppSessionList,
  MyClawAppSessionListResult,
  MyClawAppSessionRename,
  MyClawAppSessionWorkspaceSet,
  MyClawAppSessionInstructionsGet,
  MyClawAppSessionInstructionsSet,
  MyClawAppSubAgentsList,
  MyClawAppSubAgentsKill,
  MyClawAppSubAgentsCallers,
  MyClawAppSubAgentsHandoff,
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
  MyClawAppUiPrefsController,
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
  handleModelUpsert,
  handleModelRemove,
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
  handleUiPrefs,
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
import { sessionLogOf } from "../../sessions/log-access.ts";

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

const SWEEP_INTERVAL_MS = 30_000;
/** The id `SessionManager` builds for a conversation of this channel, read back the other way. */
const APP_THREAD_SESSION = /^my-claw-app\/thread\/([^/]+)\/(.+)$/;
interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * The sheet as it was broadcast. Kept here rather than only in the live turn journal because
   * that journal is per thread and only exists while its run does, so a window opening on another
   * thread had no way to learn a tool was waiting on it.
   */
  frame: MyClawAppApprovalRequest;
  /** Everything the journal needs once the answer lands, captured when the prompt was sent. */
  audit: {
    owner: string;
    threadId: string;
    sessionId: string;
    toolName: string;
    args: string;
    requestedAt: number;
  };
}

export class MyClawAppAdapter implements ChannelAdapter {
  readonly platform = "my-claw-app" as const;
  private server?: Server<MyClawAppSessionData>;
  private sockets = new SocketRegistry();
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
  private uiPrefs?: MyClawAppUiPrefsController;
  private sessionInstructions?: MyClawAppSessionInstructionsProvider;
  private jobs?: MyClawAppJobsController;
  private notifications?: MyClawAppNotificationsController;
  private configEditor?: MyClawAppConfigController;
  private browser?: BrowserConfig;
  private workspacesCtrl?: MyClawAppWorkspacesController;
  private commandHandler?: MyClawAppCommandHandler;
  /** Set by the host: broadcasts `undo.prompt` and waits for the owner's `undo.choose`. */
  private subagents?: MyClawAppSubAgentsController;
  /** Serializes roster snapshots per parent so a slower lifecycle read cannot publish stale state. */
  private rosterPushes = new Map<string, Promise<void>>();
  private locationResolver?: MyClawAppLocationResolver;
  private stopRun?: (sessionId: string) => boolean;
  private runActive?: (sessionId: string) => boolean;
  private sweeper?: ReturnType<typeof setInterval>;
  /** The turn in flight, per thread, so a reload mid-run is not a hole -- docs/live-turn-replay.md. */
  private live = new LiveTurnJournal();
  /**
   * The send being admitted on each conversation, keyed by owner/thread.
   *
   * The head of a send awaits the disk (the duplicate check opens the session log, attachments
   * are looked up by id), and every frame is handled on its own: two frames a few milliseconds
   * apart reached the router in whichever order the disk answered, so a fresh thread's first
   * message could land after its second. Sends of one conversation take a turn, held until the
   * message is handed to the router or the command handler starts, and released before the
   * command runs: a `/compact` holds a session for minutes and the `/stop` typed after it must
   * not wait behind it.
   */
  private sendTurns = new Map<string, Promise<void>>();
  /**
   * The last sends, as the `chat.user` frame their other windows received. A send that gets parked
   * is only known to be parked once the router says so, and by then the frame is what the journal
   * has to hold for a reloading window; small, since a send is parked or routed within seconds.
   */
  private recentSends = new LruMap<string, MyClawAppServerFrame>(64);

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
    // The manager's broadcast path is this adapter: a run that asks without a channel would wait
    // forever, so the tool checks hasSurface() and the handler is set before the server opens.
    questionManager.setHandler((question) => {
      const frame = questionAskFrame(question);
      this.live.recordQuestion(question.owner, question.threadId, question.id, frame);
      this.broadcast(question.owner, frame);
    });
    // The undo sheet: a `/undo` without an argument asks the owner which mode. Same shape as the
    // question flow (broadcast the prompt, await the owner's choose) but deliberately without the
    // live-journal treatment: the sheet is short-lived -- the command itself awaits the choice,
    // whereas a question can wait on a run for minutes.
    undoManager.setHandler((undo) => {
      this.broadcast(undo.owner, {
        type: "undo.prompt",
        id: undo.id,
        threadId: undo.threadId,
        turnPreview: undo.turnPreview,
        diff: undo.diff,
        ts: new Date(undo.requestedAt).toISOString(),
      });
    });
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
    for (const ws of this.sockets.all()) {
      try {
        ws.close(1001, "server shutdown");
      } catch {
        // socket already gone
      }
    }
    this.sockets.clear();
    this.media.clear();
    this.mediaOrder = [];
    for (const [id, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      // A shutdown is not a refusal by the owner: journal it as such, or a restart during a
      // prompt reads afterwards as "he said no".
      this.journalApproval(id, pending, "cancelled");
      pending.resolve("deny");
    }
    this.pendingApprovals.clear();
    // A shutdown cancels every pending question: the run is going away anyway, and a card with
    // no run behind it is a button that answers nothing.
    for (const question of questionManager.list()) {
      questionManager.cancel(question.id);
      this.broadcast(question.owner, {
        type: "question.resolved",
        id: question.id,
        threadId: question.threadId,
        reason: "canceled",
      });
    }
    questionManager.setHandler(undefined);
    this.server?.stop(true);
    this.server = undefined;
    // Before the exit and after the sockets are gone, so nothing can append behind the write. The
    // `app:shutdown` hook would not do: emission is fire and forget, this is awaited.
    await this.store.flushDrafts().catch(() => undefined);
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
    // The agent's explicit MEDIA: refs are trusted over programmatic attachments.
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
    const threadId = request.threadId ?? DEFAULT_THREAD;
    const frame: MyClawAppApprovalRequest = {
      type: "approval.request",
      id,
      threadId,
      toolName: request.toolName,
      args: request.args,
      replyToId: request.messageId,
      expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
      allowSessionOffered: !ALWAYS_PER_INVOCATION.has(request.toolName),
    };
    const audit = {
      owner: request.chatId,
      threadId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      args: serializeArgs(request.args),
      requestedAt: Date.now(),
    };
    // Asked on every window of the owner; the first answer wins and clears the pending entry.
    // Journalled too: a sheet broadcast once is lost by a window that reloads, and the tool then
    // waits out the timeout and is denied without the owner ever seeing the question.
    this.live.recordApproval(request.chatId, threadId, id, frame);
    this.broadcast(request.chatId, frame);

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingApprovals.get(id);
        this.pendingApprovals.delete(id);
        this.live.resolveApproval(request.chatId, threadId, id);
        if (pending) this.journalApproval(id, pending, "expired");
        // The other windows are still showing a sheet nobody can answer any more.
        this.broadcast(audit.owner, { type: "approval.resolved", id, threadId, reason: "expired" });
        resolve("deny");
      }, CONFIRM_TIMEOUT_MS);
      this.pendingApprovals.set(id, { resolve, timer, audit, frame });
    });
  }

  /**
   * Writes one decision to the journal. Never throws into the approval path: losing the audit
   * line is bad, refusing a tool the owner just allowed because SQLite hiccuped is worse.
   */
  private journalApproval(id: string, pending: PendingApproval, outcome: ApprovalOutcome): void {
    const { audit } = pending;
    try {
      recordApproval({
        id,
        owner: audit.owner,
        threadId: audit.threadId,
        sessionId: audit.sessionId,
        toolName: audit.toolName,
        args: audit.args,
        outcome,
        requestedAt: new Date(audit.requestedAt).toISOString(),
        decidedAt: new Date().toISOString(),
        durationMs: Date.now() - audit.requestedAt,
        auto: false,
      });
    } catch (err) {
      void myClawAppLog("error", "approval journal write failed", { id, outcome, error: String(err) });
    }
  }

  createStreamer(message: UnifiedMessage): MyClawAppStreamer {
    const owner = message.chatId;
    return new MyClawAppStreamer({
      // An entry id, not a uuid of its own: the phase written for this bubble is appended under it
      // -- docs/bubble-identity.md.
      id: newEntryId(),
      replyToId: message.id,
      threadId: message.threadId ?? DEFAULT_THREAD,
      minCharsBeforeDelta: this.config.streaming?.minChars,
      // Resolved per frame, not captured: a window that joins mid-answer still gets the rest.
      // The journal is fed from here because this is the single door every frame of a turn goes
      // through, and a window that joins mid-answer needs the part it missed too --
      // docs/live-turn-replay.md.
      send: (frame) => {
        this.live.record(owner, message.threadId ?? DEFAULT_THREAD, frame);
        this.broadcast(owner, frame);
      },
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

  onUiPrefsController(controller: MyClawAppUiPrefsController): void {
    this.uiPrefs = controller;
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

  /** The browser page reads config the channel never receives (sidecar, noVNC, units), so the
   *  section is handed over at boot rather than rediscovered here. */
  onBrowserConfig(browser: BrowserConfig): void {
    this.browser = browser;
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

  /** The run drained a queued injection at a turn boundary: lift the "queued" mark on the
   *  bubble that carried it, so the owner sees the message enter the run. */
  notifyAcked(owner: string, threadId: string, replyToId: string): void {
    this.broadcast(owner, { type: "chat.send.acked", threadId, replyToId });
    this.live.releaseQueued(owner, threadId, replyToId);
  }

  /**
   * Pushes the current model catalogue to every device of an owner, unasked. A login or logout
   * re-runs discovery, which only re-projects the in-memory picker: the app keeps the catalogue
   * it already holds until something asks again, so the ChatGPT models appear as "refresh needed"
   * instead of showing up with their efforts. Same frame `model.list` answers, so the app applies
   * it through the path it already has. Never throws: a push that cannot reach a device must not
   * fail the auth change.
   */
  pushModelList(owner: string): void {
    if (!this.models) return;
    try {
      this.broadcast(owner, { type: "model.list.result", ...this.models.list() });
    } catch (err) {
      void myClawAppLog("debug", "model list push failed", { owner, error: String(err) });
    }
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

  /**
   * A compaction started on this session, or settled. Broadcast for the windows that are watching
   * and held for the ones that are not: the journal replays it to whoever opens or reloads the
   * thread while it runs, which is the whole point -- the operation is minutes of silence, and
   * before this the only surface that showed it was the device that typed `/compact`.
   */
  notifyCompacting(sessionId: string, since: number | undefined): void {
    const match = APP_THREAD_SESSION.exec(sessionId);
    if (!match) return;
    const owner = match[1]!;
    const threadId = match[2]!;
    const frame: MyClawAppChatCompacting = {
      type: "chat.compacting",
      threadId,
      ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    };
    if (since === undefined) this.live.clearCompacting(owner, threadId);
    else this.live.markCompacting(owner, threadId, frame);
    this.broadcast(owner, frame);
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

  notifyRun(owner: string, threadId: string, active: boolean, reason?: "done" | "aborted" | "error", triggerId?: string): void {
    // The run's own lifecycle owns the journal: opened here, dropped at the end, because past the
    // end the session holds the same turn and two writers for one state is one too many. The
    // frames follow the journal's transitions and nothing else: a run announced twice (the same
    // run reached from two callers) is one run, one start and one end on the wire, and the
    // journal of the run in flight is never replaced under it -- docs/live-turn-replay.md.
    if (active) {
      // The send that opens this run was parked while a compaction rewrote the history: the run
      // is what drains it, so the mark it wears lifts here, as it does for an injected one.
      if (triggerId && this.live.isQueued(owner, threadId, triggerId)) {
        this.broadcast(owner, { type: "chat.send.acked", threadId, replyToId: triggerId });
      }
      if (!this.live.open(owner, threadId)) return;
      this.broadcast(owner, {
        type: "chat.run.start",
        threadId,
        ...(currentRunId() ? { run: currentRunId() } : {}),
      });
      return;
    }
    if (!this.live.close(owner, threadId)) return;
    this.broadcast(owner, {
      type: "chat.run.end",
      threadId,
      reason: reason ?? "done",
      ...(currentRunId() ? { run: currentRunId() } : {}),
    });
  }

  /**
   * A sub-agent lifecycle event (spawn/complete/kill/reset) changed a conversation's roster. The
   * roster is pull-only by default; this rebuilds it from the caller session and pushes the same
   * `subagents.list.result` frame the app already knows, so every window of the owner updates
   * live instead of waiting for the next `subagents.list` request.
   *
   * Best-effort and never throws: a roster push that failed must not break the run that triggered
   * it. The caller session is the parent chat session the hook carries.
   */
  async notifyRoster(parentSessionId: string): Promise<void> {
    if (!this.subagents) return;
    const match = APP_THREAD_SESSION.exec(parentSessionId);
    if (!match) return;
    const previous = this.rosterPushes.get(parentSessionId) ?? Promise.resolve();
    const push = previous.catch(() => {}).then(async () => {
      const owner = match[1]!;
      const threadId = match[2]!;
      try {
        const agents = await this.subagents!.list(parentSessionId);
        this.broadcast(owner, { type: "subagents.list.result", threadId, agents });
      } catch (err) {
        await myClawAppLog("debug", "roster push failed", { threadId, error: String(err) });
      }
    });
    const tracked = push.finally(() => {
      if (this.rosterPushes.get(parentSessionId) === tracked) this.rosterPushes.delete(parentSessionId);
    });
    this.rosterPushes.set(parentSessionId, tracked);
    await tracked;
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
  notifyQueued(owner: string, threadId: string, replyToId: string, reason: "compaction" | "injection"): void {
    const queued: MyClawAppServerFrame = { type: "chat.send.queued", threadId, replyToId, reason };
    this.broadcast(owner, queued);
    // Until a run consumes it, the message exists nowhere a reload could read it back from: the
    // journal replays the bubble and its mark to a window that opens or reloads meanwhile --
    // docs/live-turn-replay.md.
    const bubble = this.recentSends.get(`${owner}\u0000${threadId}\u0000${replyToId}`);
    if (bubble) this.live.holdQueued(owner, threadId, replyToId, [bubble, queued]);
  }

  /**
   * A compaction boundary, drawn while the owner is watching the run that caused it.
   *
   * Broadcast, like any frame addressed to a conversation, and carrying the entry id so the
   * device that already has it from a history load does not draw it twice. No notification and no
   * ring ride along: an automatic compaction is not an event the owner has to be told about.
   */
  notifyCompaction(sessionId: string, boundary: { id: string; summary: string; count: number }): void {
    const match = APP_THREAD_SESSION.exec(sessionId);
    if (!match) return;
    const owner = match[1]!;
    const threadId = match[2]!;
    this.broadcast(owner, {
      type: "chat.compaction",
      threadId,
      id: boundary.id,
      summary: boundary.summary,
      count: boundary.count,
      ts: new Date().toISOString(),
    });
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
    return this.sockets.forOwner(owner);
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

    if (url.pathname === "/app-update") {
      if (!this.authenticate(req, url)) return new Response("Unauthorized", { status: 401 });
      return Response.json(await latestAppUpdate());
    }

    if (url.pathname === "/app-update/apk" && req.method === "GET") {
      if (!this.authenticate(req, url)) return new Response("Unauthorized", { status: 401 });
      const info = await latestAppUpdate();
      if (!info.ok) return new Response(info.error, { status: 404 });
      return streamAppApk(info);
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
    // Several surfaces of one device are welcome. Closing the previous one used to make two tabs
    // of a browser fight over a device id that belongs to the profile, not to the tab -- see
    // SocketRegistry.
    this.sockets.add(ws);
    void myClawAppLog("info", "device connected", {
      deviceId: ws.data.deviceId,
      surfaces: this.sockets.countFor(ws.data.deviceId),
    });
    // The server names itself first: the settings page labels its "connected" state with it.
    void readAppVersion().then((version) => this.sendFrame(ws, { type: "hello", version, receipts: true }));
    const locationCapabilities: MyClawAppLocationCapabilities = {
      type: "location.capabilities",
      ...(this.locationResolver?.capabilities() ?? { enabled: false, address: false, provider: "geoapify" as const }),
    };
    this.sendFrame(ws, locationCapabilities);
    // A pending question outlives the socket it was asked on: nothing pushed while a device was
    // down is replayed, and the run is still blocked on the answer. The whole list is sent, and
    // an empty one is just as meaningful -- it is what clears a card left over by a server that
    // died holding a question.
    this.sendFrame(
      ws,
      questionPendingFrame(questionManager.list().filter((question) => question.owner === ws.data.owner)),
    );
    // Approvals, for the same reason and with the same contract. The sheet is broadcast once, and
    // the live turn journal only replays it to a `session.sync` of the thread it belongs to: an
    // approval raised on another thread, or while this device was asleep, was never asked again,
    // and the tool sat out its two minutes and was denied without the owner seeing anything. The
    // empty list is meaningful too, it clears a sheet left over by a restart.
    this.sendFrame(ws, {
      type: "approval.pending",
      entries: [...this.pendingApprovals.values()]
        .filter((pending) => pending.audit.owner === ws.data.owner)
        .map(({ frame }) => {
          const { type: _type, ...entry } = frame;
          return entry;
        }),
    });
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
    this.sockets.remove(ws);
    void myClawAppLog("info", "device disconnected", {
      deviceId: ws.data.deviceId,
      surfaces: this.sockets.countFor(ws.data.deviceId),
    });
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
      uiPrefs: this.uiPrefs,
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
      case "question.reply":
        this.resolveQuestion(frame);
        break;
      case "undo.choose":
        this.resolveUndo(frame);
        break;
      case "undo.cancel":
        this.cancelUndo(frame);
        break;
      case "approval.history":
        this.handleApprovalHistory(ws, frame);
        break;
      case "ping":
        // Answered, because the browser client has no transport-level ping of its own and its
        // fallback (watching bufferedAmount) cannot see a dead peer: fifteen bytes reach the
        // kernel buffer of a socket whose other end is long gone. This reply is the only proof
        // the link is still two-way.
        this.sendFrame(ws, { type: "pong" });
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
      case "uiPrefs.get":
        this.detach(handleUiPrefs(this.settingsDeps(), ws, undefined), "handleUiPrefs");
        break;
      case "uiPrefs.set":
        this.detach(handleUiPrefs(this.settingsDeps(), ws, frame.prefs), "handleUiPrefs");
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
        this.detach(handleModelEndpoints(this.settingsDeps(), ws, frame.model, frame.sort), "handleModelEndpoints");
        break;
      case "models.upsert":
        this.detach(handleModelUpsert(this.settingsDeps(), ws, frame), "handleModelUpsert");
        break;
      case "models.remove":
        this.detach(handleModelRemove(this.settingsDeps(), ws, frame), "handleModelRemove");
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
      case "session.instructions.set":
        this.detach(this.handleSessionInstructionsSet(ws, frame), "handleSessionInstructionsSet");
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
      case "browser.info":
        this.detach(handleBrowserInfo({
          browser: this.browser,
          sendFrame: (target, f) => this.sendFrame(target, f),
          refuse: (target, scope, message, data) => this.refuse(target, scope, message, data),
        }, ws), "handleBrowserInfo");
        break;
      case "subagents.list":
        this.detach(this.handleSubAgentsList(ws, frame), "handleSubAgentsList");
        break;
      case "subagents.kill":
      case "subagents.reset":
        this.detach(this.handleSubAgentAction(ws, frame), "handleSubAgentAction");
        break;
      case "subagents.callers":
        this.detach(this.handleSubAgentCallers(ws, frame), "handleSubAgentCallers");
        break;
      case "subagents.handoff":
        this.detach(this.handleSubAgentHandoff(ws, frame), "handleSubAgentHandoff");
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
      case "session.sync":
        this.detach(this.handleSessionSync(ws, frame), "handleSessionSync");
        break;
      case "session.run.items":
        this.detach(this.handleRunItems(ws, frame), "handleRunItems");
        break;
      case "chat.tool.full":
        this.detach(this.handleToolFull(ws, frame), "handleToolFull");
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
      case "draft.set":
        this.detach(this.handleDraftSet(ws, frame), "handleDraftSet");
        break;
    }
  }

  /**
   * A draft typed on one device, mirrored to the owner's others -- docs/draft-sync.md. Nothing is
   * refused out loud: a draft is not an action, and an error frame about one would interrupt the
   * owner over text they have not even sent yet.
   */
  private async handleDraftSet(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppDraftSet): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId ?? "");
    if (!threadId) return;
    const text = typeof frame.text === "string" ? frame.text : "";
    try {
      const write = await this.store.setDraft(ws.data.owner, threadId, text);
      // Unchanged text is not news: a device that reconnects and re-sends its draft costs nothing.
      if (!write.changed) return;
      this.broadcastExcept(ws, { type: "draft.changed", threadId, text, ts: write.ts });
    } catch (err) {
      await myClawAppLog("warn", "draft store failed", { chars: text.length, error: String(err) });
    }
  }

  /**
   * The composer that sent this has emptied itself, so the owner's other windows must too: they
   * were mirroring a message that has now been sent.
   */
  private async dropDraft(ws: ServerWebSocket<MyClawAppSessionData>, threadId: string): Promise<void> {
    try {
      if (!(await this.store.clearDraft(ws.data.owner, threadId))) return;
      this.broadcastExcept(ws, { type: "draft.changed", threadId, text: "", ts: Date.now() });
    } catch (err) {
      await myClawAppLog("warn", "draft clear failed", { error: String(err) });
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
   * Writes a command and its bubble into the conversation's journal. Two things are left out on
   * purpose: an answer the app draws as a page instead of a bubble (a structured `/status`, which
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
    quiet = false,
  ): Promise<void> {
    if (renderedAsPage) return;
    const redacted = redactCommandArgs(command, args);
    const input = redacted ? `/${command} ${redacted}` : `/${command}`;
    try {
      // The entry has its own log identity. The source id is the chat.send id the app already
      // used for the command and its answer, so replay can replace both live bubbles.
      await this.store.recordCommand(owner, threadId, input, output, details, sourceId, quiet);
    } catch (err) {
      void myClawAppLog("error", "command journal failed", { owner, threadId, command, error: String(err) });
    }
  }

  /** The session id behind this socket's thread, or undefined when it cannot resolve. */
  private sessionOf(ws: ServerWebSocket<MyClawAppSessionData>, threadId: string): string {
    return this.store.resolveSessionId(ws.data.owner, threadId);
  }

  /** The open question of this socket's thread, if any; throws when the session is unknown. */
  private questionOf(ws: ServerWebSocket<MyClawAppSessionData>, threadId: string): PendingQuestion | undefined {
    const sessionId = this.sessionOf(ws, threadId);
    if (!sessionId) return undefined;
    return questionManager.ofSession(sessionId);
  }

  /** Whether a send with this id already reached the conversation: on its branch, or in its run's mailbox. */
  private async alreadyHeld(owner: string, threadId: string, id: string): Promise<boolean> {
    if (this.live.isQueued(owner, threadId, id)) return true;
    try {
      const log = await sessionLogOf(this.store.resolveSessionId(owner, threadId));
      return log.get(id) !== undefined;
    } catch (err) {
      await myClawAppLog("debug", "duplicate check skipped", { threadId, error: String(err) });
      return false;
    }
  }

  private async emitChatSend(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppChatSend,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;
    const pass = await this.takeSendTurn(`${ws.data.owner}/${threadId}`);
    try {
      await this.admitChatSend(ws, frame, threadId, pass);
    } finally {
      pass();
    }
  }

  /** Waits for the sends before this one on the conversation; the returned function passes the turn on, once. */
  private async takeSendTurn(key: string): Promise<() => void> {
    const previous = this.sendTurns.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => mine);
    this.sendTurns.set(key, chained);
    await previous;
    let passed = false;
    return () => {
      if (passed) return;
      passed = true;
      release();
      if (this.sendTurns.get(key) === chained) this.sendTurns.delete(key);
    };
  }

  private async admitChatSend(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppChatSend,
    threadId: string,
    pass: () => void,
  ): Promise<void> {
    const owner = ws.data.owner;
    // The frame is only typed on the wire: an app one version off, or one bug in its serializer,
    // sends a `chat.send` with no text at all.
    const text = typeof frame.text === "string" ? frame.text.trim() : "";
    const refs = Array.isArray(frame.attachments) ? frame.attachments : [];
    const hasLocation = frame.location !== undefined;
    if (!text && refs.length === 0 && !hasLocation) return;

    // The receipt goes first, to this socket only: the app has a bubble waiting on it, whatever the
    // socket claimed about itself. A send it never gets a receipt for is offered again, so the same
    // id arriving twice is taken once: on the branch already, or parked in the run's mailbox, it is
    // receipted and goes no further.
    if (typeof frame.id === "string" && frame.id) {
      this.sendFrame(ws, { type: "chat.send.received", threadId, id: frame.id });
      if (await this.alreadyHeld(owner, threadId, frame.id)) return;
    }

    // Typing instead of answering cancels the question: the message is the answer, and it
    // reaches the run as the next user turn through the normal mailbox. The card is dropped
    // everywhere; the tool reports the cancel and the run proceeds with the typed message in
    // context -- which is the exact steering the owner meant when he jumped the question.
    const pendingQuestion = (() => {
      try {
        return this.questionOf(ws, threadId);
      } catch {
        return undefined;
      }
    })();
    if (pendingQuestion && !text.startsWith("/")) {
      const canceled = questionManager.cancel(pendingQuestion.id);
      if (canceled) {
        this.live.resolveQuestion(pendingQuestion.owner, pendingQuestion.threadId, pendingQuestion.id);
        this.broadcast(pendingQuestion.owner, {
          type: "question.resolved",
          id: pendingQuestion.id,
          threadId: pendingQuestion.threadId,
          reason: "canceled",
        });
      }
    }

    // Awaited, and before the mirrored bubble: the other window would otherwise draw the message
    // while its own composer still held the same text, showing it twice for a frame. Memory work
    // only, the disk write is on its own timer.
    await this.dropDraft(ws, threadId);

    // Slash commands run on the server, exactly as they do on the other channels: a command
    // sent to the model as a plain question would be answered from nothing. The user's own
    // bubble is drawn by the app from its send; only the result is new here. Only the catalog
    // is intercepted: an unknown /word is a question like any other and must reach the agent.
    if (text && refs.length === 0 && !hasLocation && this.commandHandler) {
      const command = /^\/([a-z-]+)/i.exec(text)?.[1];
      const commandInfo = command ? APP_COMMANDS.find((c) => c.command === command) : undefined;
      if (command && commandInfo) {
        const args = text.slice(command.length + 1).trim();
        // A command is a prompt too: the other windows show what was typed, then its answer.
        // A quiet command (undo, retry, branches) is the opposite: the input is navigation
        // noise, only the result bubble is worth showing, live and on every refresh.
        const quiet = commandInfo.quiet === true;
        if (!quiet) this.echoUserMessage(ws, threadId, frame, text, []);
        // Most commands answer in a blink and a placeholder bubble would only flicker. The slow
        // ones (a `/compact` on a full session runs for minutes) would otherwise leave the chat
        // silent with nothing to show for it, so the notice is sent on a delay: whichever comes
        // first wins, and the result replaces the notice when both were sent.
        const pending = quiet
          ? undefined
          : setTimeout(() => {
              this.broadcast(owner, {
                type: "chat.command.pending",
                threadId,
                replyToId: frame.id,
                text: `Running /${command}...`,
              });
            }, COMMAND_PENDING_NOTICE_MS);
        try {
          // The order of arrival is settled; what follows can take minutes.
          pass();
          const output = await this.commandHandler(owner, threadId, command, args);
          clearTimeout(pending);
          if (output) {
            const text = typeof output === "string" ? output : output.text;
            const status = typeof output === "string" ? undefined : output.status;
            const details = typeof output === "string" ? undefined : output.details;
            const reset = typeof output === "string" ? undefined : output.reset;
            const compose = typeof output === "string" ? undefined : output.compose;
            const newThreadId = typeof output === "string" ? undefined : output.newThreadId;
            this.broadcast(owner, {
              type: "chat.command.result",
              threadId,
              replyToId: frame.id,
              text,
              ...(status ? { status } : {}),
              ...(details ? { details } : {}),
              ...(reset ? { reset } : {}),
              ...(compose !== undefined ? { compose } : {}),
              ...(newThreadId ? { newThreadId } : {}),
              ...(quiet ? { dropInput: true } : {}),
            });
            await this.journalCommand(owner, threadId, command, args, text, status !== undefined, details, frame.id, quiet);
          }
          return;
        } catch (err) {
          clearTimeout(pending);
          void myClawAppLog("error", "command failed", { owner, threadId, command, error: String(err) });
          const failure = `error: ${err instanceof Error ? err.message : String(err)}`;
          this.broadcast(owner, {
            type: "chat.command.result",
            threadId,
            replyToId: frame.id,
            text: failure,
            ...(quiet ? { dropInput: true } : {}),
          });
          await this.journalCommand(owner, threadId, command, args, failure, false, undefined, frame.id, quiet);
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
   * Delivers a turn into one of the owner's conversations without a device having typed it.
   *
   * The whole `chat.send` pipeline is reused on purpose: the bubble is mirrored to every window
   * first, then the message goes through `messageHandler`, so a target with a run in flight parks
   * it in that run's mailbox and a target at rest opens a fresh one. Anything narrower would be a
   * second delivery path with its own idea of what a queued message is.
   *
   * Used by the sub-agent hand-back: a sub-agent's answer reaches its parent only because a tool
   * call is awaiting it, and when the owner is the one chatting nothing is
   * -- docs/subagent-navigation.md, "Constraint 3".
   */
  async deliverOwnerTurn(owner: string, threadId: string, text: string): Promise<boolean> {
    const safe = sanitizeThreadId(threadId);
    if (!safe || !this.messageHandler || !text.trim()) return false;
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    // Every window, sender included: no device drew this one, so there is no bubble to avoid
    // duplicating -- the opposite of `echoUserMessage`.
    this.broadcast(owner, { type: "chat.user", threadId: safe, id, text, ts });
    void this.messageHandler({
      id,
      platform: "my-claw-app",
      userId: owner,
      chatId: owner,
      chatType: "dm",
      text,
      timestamp: ts,
      attachments: [],
      isForwarded: false,
      threadId: safe,
      sessionScope: "per-user",
      raw: { type: "chat.send", id, threadId: safe },
    }).catch((err) => {
      void myClawAppLog("error", "delivered turn failed", { owner, threadId: safe, error: String(err) });
    });
    return true;
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
    const bubble: MyClawAppServerFrame = {
      type: "chat.user",
      threadId,
      id: frame.id,
      text,
      ...(frame.ts ? { ts: frame.ts } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(location ? { location } : {}),
    };
    this.recentSends.set(`${ws.data.owner}\u0000${threadId}\u0000${frame.id}`, bubble);
    this.broadcastExcept(ws, bubble);
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
      this.broadcast(ws.data.owner, await this.sessionListFrame(ws.data.owner));
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
      this.broadcast(ws.data.owner, { type: "session.workspace.set.result", threadId, workspace: frame.workspace });
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
      this.broadcast(ws.data.owner, { type: "subagents.list.result", threadId: parentThreadId, agents });
    } catch (err) {
      await this.refuse(ws, "subagents", `${frame.type} failed`, { threadId, error: String(err) });
    }
  }

  /**
   * Which conversations a sub-agent has worked for, so the owner can pick who its answer goes back
   * to. Answered to the asking socket alone: it is a menu being opened, not a state change every
   * window needs.
   */
  private async handleSubAgentCallers(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSubAgentsCallers,
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
      const callers = await this.subagents.callers(threadId, caller);
      // Unreachable and missing answer the same way, on purpose (docs/subagent-visibility.md).
      if (!callers) {
        await this.refuse(ws, "subagents", `Error: sub-agent ${threadId} not found.`, { threadId });
        return;
      }
      this.sendFrame(ws, { type: "subagents.callers.result", threadId, callers });
    } catch (err) {
      await this.refuse(ws, "subagents", "subagents.callers failed", { threadId, error: String(err) });
    }
  }

  /**
   * Hands one of the sub-agent's messages back to conversations that called it.
   *
   * Broadcast, unlike the list: this writes into other conversations, so every window of the owner
   * must learn what landed. The per-target outcome is reported rather than a single ok, since one
   * target being gone must not hide the ones that worked.
   */
  private async handleSubAgentHandoff(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSubAgentsHandoff,
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
    const targets = Array.isArray(frame.targets) ? frame.targets.filter((t: unknown): t is string => typeof t === "string" && t.length > 0) : [];
    if (targets.length === 0) {
      await this.refuse(ws, "subagents", "no target", { threadId });
      return;
    }
    const caller = this.store.resolveSessionId(ws.data.owner, parentThreadId);
    // Resolved here, not in the controller: the ids the owner tapped are the ids this replay view
    // minted, and deriving them a second time somewhere else is one drift away from handing back
    // the wrong turn -- or nothing at all.
    let body: string;
    try {
      const resolved = await this.resolveHandoffBody(ws.data.owner, threadId, frame.messageId);
      if (!resolved) {
        await this.refuse(ws, "subagents", "nothing to hand back", { threadId, messageId: frame.messageId });
        return;
      }
      body = resolved;
    } catch (err) {
      await this.refuse(ws, "subagents", "subagents.handoff failed", { threadId, error: String(err) });
      return;
    }
    try {
      const delivered = await this.subagents.handoff({
        threadId,
        callerSessionId: caller,
        targets,
        body,
        mode: frame.mode === "note" ? "note" : "ask",
        ...(typeof frame.note === "string" && frame.note ? { note: frame.note } : {}),
      });
      this.broadcast(ws.data.owner, { type: "subagents.handoff.result", threadId, delivered });
    } catch (err) {
      await this.refuse(ws, "subagents", "subagents.handoff failed", { threadId, error: String(err) });
    }
  }

  /**
   * The text behind the bubble the owner picked, or the sub-agent's last answer when none was.
   *
   * Only an assistant bubble is eligible: handing back the owner's own question tells the parent
   * nothing it does not already have, and a tool card is an implementation detail of the run.
   */
  private async resolveHandoffBody(owner: string, threadId: string, messageId?: string): Promise<string | undefined> {
    const { entries } = await this.store.history(owner, threadId);
    const answers = entries.filter((e) => e.role === "assistant" && e.text.trim().length > 0);
    if (typeof messageId === "string" && messageId) {
      const picked = answers.find((e) => e.id === messageId);
      return picked && picked.role === "assistant" ? picked.text : undefined;
    }
    const last = answers.at(-1);
    return last && last.role === "assistant" ? last.text : undefined;
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
    const sessionId = this.store.resolveSessionId(ws.data.owner, threadId);

    // A Stop while a question is pending cancels the question, not the run: the tool returns
    // "User canceled the questions" and the agent carries on with whatever it has. The second
    // Stop is a real stop. This is the one override the owner asked for -- a question is a run
    // waiting on a person, and killing the run because he pressed the button he uses to stop is
    // the one case where Stop would throw away the whole answer.
    const question = questionManager.ofSession(sessionId);
    if (question) {
      const canceled = questionManager.cancel(question.id);
      if (canceled) {
        this.live.resolveQuestion(question.owner, question.threadId, question.id);
        this.broadcast(question.owner, {
          type: "question.resolved",
          id: question.id,
          threadId: question.threadId,
          reason: "canceled",
        });
      }
      this.sendFrame(ws, {
        type: "chat.command.result",
        threadId,
        text: "Question canceled.",
      });
      return;
    }

    if (!this.stopRun) {
      await this.refuse(ws, "chat", "stop unavailable");
      return;
    }
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

  private async handleSessionInstructionsSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSessionInstructionsSet,
  ): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "instructions", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      if (!this.sessionInstructions) {
        await this.refuse(ws, "instructions", "session instructions unavailable");
        return;
      }
      await this.store.setInstructionPatch(ws.data.owner, threadId, frame.patch);
      const instructions = await this.sessionInstructions(this.store.resolveSessionId(ws.data.owner, threadId));
      this.sendFrame(ws, { type: "session.instructions.result", threadId, instructions });
    } catch (err) {
      await this.refuse(ws, "instructions", "session.instructions.set failed", { error: String(err) });
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

  /**
   * The listing as the server holds it now. Built apart from the handlers because the same frame
   * answers a read, where it goes to the asker, and every mutation of the list, where it goes to
   * every window of the owner: a conversation renamed, filed or deleted on the phone is not a
   * fact about the phone (docs/my-claw-app-channel.md).
   */
  private async sessionListFrame(owner: string): Promise<MyClawAppSessionListResult> {
    const sessions = await this.store.list(owner);
    const withRuns = this.runActive
      ? sessions.map((session) => ({ ...session, activeRun: this.runActive!(this.store.resolveSessionId(owner, session.threadId)) }))
      : sessions;
    return { type: "session.list.result", sessions: withRuns };
  }

  private async handleSessionList(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionList): Promise<void> {
    try {
      this.sendFrame(ws, await this.sessionListFrame(ws.data.owner));
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
      const page = await this.store.history(ws.data.owner, threadId, frame.limit, frame.before, frame.beforeId, frame.fold);
      const result: MyClawAppChatHistory = {
        type: "chat.history",
        threadId,
        messages: page.entries,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        ...(page.draft ? { draft: page.draft } : {}),
        // Echoed so the app can tell an older page, which it prepends, from the newest one,
        // which replaces the thread. The two arrive on the same frame type.
        ...(frame.before ? { before: frame.before } : {}),
        // Same for the id cursor: the client only trusts a page its cursor was honoured for,
        // and an unknown cursor (compaction, a branch) returns an empty page to stop it.
        ...(frame.beforeId ? { beforeId: frame.beforeId } : {}),
        // Always sent, both ways: the app makes this page authoritative over its own run flag, so
        // an omitted false would leave a stale one standing after a run ended during a disconnect.
        ...(this.runActive ? { activeRun: this.runActive(this.store.resolveSessionId(ws.data.owner, threadId)) } : {}),
      };
      this.sendFrame(ws, result);
    } catch (err) {
      await this.refuse(ws, "session", "history failed", { threadId, error: String(err) });
    }
  }

  /**
   * Delta sync: returns entries since the client's cursor, with metadata about the current state.
   * Replaces full history reload on reconnect with an append-only delta.
   */
  private async handleSessionSync(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionSync): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "session", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      const page = await this.store.sync(ws.data.owner, threadId, frame.since, frame.leaf, frame.limit, frame.fold);
      const result: MyClawAppSessionSyncResult = {
        type: "session.sync.result",
        threadId,
        entries: page.entries,
        leaf: page.leaf,
        head: page.head,
        ...(page.reset ? { reset: page.reset } : {}),
        ...(page.truncated ? { truncated: page.truncated } : {}),
        ...(page.hasMore !== undefined && page.nextBefore !== undefined
          ? { hasMore: page.hasMore, nextBefore: page.nextBefore }
          : {}),
        ...(this.runActive ? { activeRun: this.runActive(this.store.resolveSessionId(ws.data.owner, threadId)) } : {}),
      };
      this.sendFrame(ws, result);
      // The delta ends where the store ends, which is the last settled call: everything the turn
      // in flight has already shown lives only in the journal. Replayed after the page, in the
      // order it was sent, so this window converges with the ones that never left --
      // docs/live-turn-replay.md.
      for (const live of this.live.replay(ws.data.owner, threadId)) this.sendFrame(ws, live);
    } catch (err) {
      await this.refuse(ws, "session", "sync failed", { threadId, error: String(err) });
    }
  }

  /**
   * Hands back one tool card's output in full, for a reader who opened the block the card only
   * ever showed clipped. A card the session no longer holds is answered `found: false` rather
   * than with an empty string: the app then keeps what it already has instead of blanking the
   * block under the reader's eyes.
   */
  /**
   * The items a folded run row stands for -- docs/run-hydration.md. The other half of the fold:
   * the page carried a header, and this is what the reader who opened the group pays for.
   */
  private async handleRunItems(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppSessionRunItems): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId || !frame.fromId || !frame.untilId) {
      await this.refuse(ws, "session", "invalid run range", {
        threadId: frame.threadId,
        fromId: frame.fromId,
        untilId: frame.untilId,
      });
      return;
    }
    try {
      const page = await this.store.runItems(ws.data.owner, threadId, frame.fromId, frame.untilId);
      this.sendFrame(ws, {
        type: "chat.run.items",
        threadId,
        // Echoed exactly as asked: that is the row the client has to replace, and it holds the
        // prefixed form.
        fromId: frame.fromId,
        messages: page.entries,
        found: page.found,
      });
    } catch (err) {
      await this.refuse(ws, "session", "run items failed", { threadId, fromId: frame.fromId, error: String(err) });
    }
  }

  private async handleToolFull(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppToolFull): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId || !frame.id) {
      await this.refuse(ws, "session", "invalid tool card", { threadId: frame.threadId, id: frame.id });
      return;
    }
    try {
      const output = await this.store.toolOutput(ws.data.owner, threadId, frame.id);
      this.sendFrame(ws, {
        type: "chat.tool.full.result",
        threadId,
        id: frame.id,
        output: output ?? "",
        found: output !== null,
      });
    } catch (err) {
      await this.refuse(ws, "session", "tool output failed", { threadId, id: frame.id, error: String(err) });
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
      this.broadcast(ws.data.owner, await this.sessionListFrame(ws.data.owner));
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
      this.broadcast(owner, await this.sessionListFrame(owner));
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
      // The conversation is gone from disk, so it must go from every screen: the other windows
      // drop its bubbles and its row instead of offering a thread that no longer exists.
      this.broadcastExcept(ws, { type: "chat.cleared", threadId });
      this.broadcast(ws.data.owner, await this.sessionListFrame(ws.data.owner));
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

  /** Same split as the session listing: a read answers the asker, a delete answers every window. */
  private async filesListFrame(owner: string, threadId: string): Promise<MyClawAppFilesListResult> {
    const [files, totalBytes] = await Promise.all([
      this.files.list(owner, threadId),
      this.files.sessionSizeBytes(owner, threadId),
    ]);
    return { type: "files.list.result", threadId, files, totalBytes };
  }

  private async handleFilesList(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppFilesList): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "files", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    try {
      this.sendFrame(ws, await this.filesListFrame(ws.data.owner, threadId));
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
        this.broadcast(ws.data.owner, await this.filesListFrame(ws.data.owner, threadId));
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
    this.live.resolveApproval(pending.audit.owner, pending.audit.threadId, frame.id);

    // The wire is not a place to trust. Anything that is not one of the three grants is a deny:
    // an old client that still sends `accepted` lands here, and a tool must never run because a
    // frame was unreadable.
    const claimed: ApprovalDecision =
      frame.decision === "allow-once" || frame.decision === "allow-session" || frame.decision === "deny"
        ? frame.decision
        : "deny";

    // A session grant is refused for the per-invocation tools even if a device asks for one:
    // the offer is not made for them.
    const decision: ApprovalDecision =
      claimed === "allow-session" && ALWAYS_PER_INVOCATION.has(pending.audit.toolName)
        ? "allow-once"
        : claimed;

    this.journalApproval(frame.id, pending, decision);
    // The owner's other windows are showing the same sheet: close it there too.
    this.broadcast(pending.audit.owner, {
      type: "approval.resolved",
      id: frame.id,
      threadId: pending.audit.threadId,
      reason: "answered-elsewhere",
    });
    pending.resolve(decision);
  }

  /** The owner answered a question card: one frame, all answers, resolved exactly once. */
  private resolveQuestion(frame: MyClawAppQuestionReply): void {
    const question = questionManager.reply(frame.id, frame.answers);
    if (!question) return;
    this.live.resolveQuestion(question.owner, question.threadId, frame.id);
    // The owner's other windows are showing the same card: drop it there too.
    this.broadcast(question.owner, {
      type: "question.resolved",
      id: frame.id,
      threadId: question.threadId,
      reason: "answered",
    });
  }

  /** The owner picked a mode in the undo sheet. */
  private resolveUndo(frame: MyClawAppUndoChoose): void {
    const undo = undoManager.choose(frame.id, frame.mode);
    if (!undo) return;
    // The owner's other windows are showing the same sheet: close it there too.
    this.broadcast(undo.owner, {
      type: "undo.resolved",
      id: frame.id,
      threadId: undo.threadId,
      reason: "chosen",
    });
  }

  /** The owner dismissed the sheet: the prompt resolves as canceled, nothing runs. */
  private cancelUndo(frame: MyClawAppUndoCancel): void {
    const undo = undoManager.cancel(frame.id);
    if (!undo) return;
    this.broadcast(undo.owner, {
      type: "undo.resolved",
      id: frame.id,
      threadId: undo.threadId,
      reason: "canceled",
    });
  }

  private handleApprovalHistory(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppApprovalHistory): void {
    const owner = ws.data.owner;
    try {
      const entries = listApprovals({
        owner,
        threadId: frame.threadId,
        limit: frame.limit,
        before: frame.before,
      });
      this.sendFrame(ws, {
        type: "approval.history.result",
        threadId: frame.threadId,
        entries: entries.map((entry) => ({
          id: entry.id,
          threadId: entry.threadId,
          toolName: entry.toolName,
          args: entry.args,
          outcome: entry.outcome,
          requestedAt: entry.requestedAt,
          decidedAt: entry.decidedAt,
          durationMs: entry.durationMs,
          auto: entry.auto,
        })),
        stats: approvalStats(owner),
      });
    } catch (err) {
      void myClawAppLog("error", "approval history read failed", { owner, error: String(err) });
      this.sendFrame(ws, {
        type: "approval.history.result",
        threadId: frame.threadId,
        entries: [],
        stats: { total: 0, allowed: 0, denied: 0, expired: 0 },
      });
    }
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
    for (const ws of this.sockets.all()) {
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
    for (const ws of this.sockets.all()) {
      if (now - ws.data.lastSeen > STALE_SOCKET_MS) {
        try {
          ws.close(1001, "stale");
        } catch {
          // already closed
        }
        this.sockets.remove(ws);
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
