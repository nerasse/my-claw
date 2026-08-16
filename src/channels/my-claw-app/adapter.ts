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
  ChatLocation,
} from "../types.ts";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { readAppVersion } from "../../core/diagnostics.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { PairingSockets, type PairSocketData } from "./pair-socket.ts";
import { approve, createTicket, deny, lookup, pairingEnabled } from "./pairing.ts";
import { listDevices, revokeDevice, touchDevice } from "./devices.ts";
import { pairPageResponse } from "./pair-page.ts";
import { deviceOfSession, readCookie, revokeSessionsOfDevice, SESSION_COOKIE } from "./web-session.ts";
import { clientIp, requestHost, requestIsSecure, securityHeaders, serveBundle, webEnabled } from "./web.ts";
import { currentRunId } from "../../utils/run-context.ts";
import { extractMediaRefs, stripMediaRefs, mediaTypeForPath } from "../../utils/media.ts";
import { commandsFor } from "../commands-catalog.ts";
import { redactCommandArgs } from "../command-log.ts";

/** What this channel advertises and what it intercepts, from one list so they cannot diverge. */
const APP_COMMANDS = commandsFor("my-claw-app");
import { MIME_BY_EXTENSION, SessionFileStore, filePathFor, parseStoredName } from "./files.ts";import type {
  MyClawAppAgentsConfigGet,
  MyClawAppAgentsConfigResult,
  MyClawAppAgentFileResult,
  MyClawAppAgentsModelClear,
  MyClawAppAgentsModelSet,
  MyClawAppAgentsFallbackSet,
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
  MyClawAppDiagReport,
  MyClawAppDiagSnapshot,
  MyClawAppInstructionsFile,
  MyClawAppInstructionsGet,
  MyClawAppInstructionsListResult,
  MyClawAppInstructionsSet,
  MyClawAppInstructionsLayerSet,
  MyClawAppLogsTail,
  MyClawAppMcpEntry,
  MyClawAppServerFrame,
  MyClawAppSessionArchive,
  MyClawAppSessionUnarchive,
  MyClawAppSessionDelete,
  MyClawAppSessionHistory,
  MyClawAppSessionList,
  MyClawAppSessionRename,
  MyClawAppSessionWorkspaceSet,
  MyClawAppToolEntry,
  MyClawAppAgentsScopeSet,
  MyClawAppAgentsWorkspaceSet,
  MyClawAppAgentsIterationsSet,
  MyClawAppAgentsContextCapSet,
  MyClawAppAgentFileGet,
  MyClawAppAgentFileSet,
  MyClawAppAgentFileCreate,
  MyClawAppAgentFileDelete,
  MyClawAppToolsToggle,
  MyClawAppSkillEntry,
  MyClawAppSkillsTransfer,
  MyClawAppMcpAdd,
  MyClawAppMcpRemove,
  MyClawAppMcpEnable,
  MyClawAppConfigGet,
  MyClawAppConfigSet,
  MyClawAppWorkspacesAdd,
  MyClawAppWorkspacesListResult,
  MyClawAppWorkspacesRemove,
  MyClawAppWorkspacesRename,
  MyClawAppWorkspacesSetPath,
  MyClawAppStatusGet,
  MyClawAppSessionInstructions,
  MyClawAppSessionInstructionsGet,
  MyClawAppStatusPayload,
  MyClawAppJobDelete,
  MyClawAppJobSave,
  MyClawAppJobsRunEntry,
  MyClawAppJobsRuns,
  MyClawAppSubAgentsList,
  MyClawAppSubAgentsKill,
  MyClawAppSubAgentsReset,
  MyClawAppSubAgentEntry,
  MyClawAppJobEntry,
  MyClawAppNotificationsRegister,
  MyClawAppNotificationsState,
  MyClawAppModelContextSet,
  MyClawAppModelState,
  MyClawAppTagsDelete,
  MyClawAppTagsResult,
  MyClawAppTagsUpsert,
  MyClawAppProviderEnvList,
  MyClawAppProviderEnvRemove,
  MyClawAppProviderEnvRename,
  MyClawAppProviderEnvSet,
  MyClawAppProviderEnvResult,
  MyClawAppProviderRemove,
  MyClawAppProviderRename,
  MyClawAppProviderUpsert,
  MyClawAppLocationCapabilities,
  MyClawAppLocationPreview,
} from "./types.ts";
import { DEFAULT_THREAD } from "./types.ts";
import { MyClawAppStreamer } from "./stream.ts";
import type { MyClawAppSessionStore } from "./sessions.ts";
import { sanitizeThreadId } from "./sessions.ts";
import { thumbPathFor } from "./files.ts";
import { extractVideoThumbnail } from "../../media/video.ts";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { applyAddressOverride, normalizeLocationInput, type MyClawAppLocationResolver } from "./location.ts";

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
// Healthy connections are idle on data frames for long stretches (protocol-level pings keep
// TCP alive); only reclaim sockets that look dead for 10 minutes.
const STALE_SOCKET_MS = 10 * 60 * 1000;
/** Per frame. The device queues reports while offline, and one crash loop must not flood the log. */
const MAX_DIAG_REPORTS = 20;
/** How long a command may take before the app is told it is still running. */
const COMMAND_PENDING_NOTICE_MS = 400;

/** Commands that end the conversation they run in: their journal goes with the history they cut. */
const CLEARING_COMMANDS = new Set(["new"]);
const SWEEP_INTERVAL_MS = 30_000;
// A look-aside cache of recently served media; the bytes themselves live in the session store
// (uploads) or were copied there on send, so evicting an entry here only drops the fast path.
const MAX_MEDIA_ENTRIES = 1000;

interface MyClawAppSessionData {
  deviceId: string;
  /** Conversation namespace of the device (config `owner`, else the device id). */
  owner: string;
  lastSeen: number;
  /**
   * Set on a socket opened at /my-claw-app/pair. It is unauthenticated and speaks a protocol of
   * its own, so every chat handler refuses it before reading anything else -- docs/web-pairing.md.
   */
  pairing?: true;
  code?: string;
  origin?: string;
  ip?: string;
  userAgent?: string;
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
  list(): { models: Array<{ id: string; label: string; group?: string; effortLevels?: string[]; context?: number }>; defaultModel: string };
  /** What runs on this thread now: override or configured default, plus effort and context state. */
  current(owner: string, threadId: string): Promise<MyClawAppModelState>;
  /** Persists the override (or clears it, back to the default) and reports what was stored. */
  set(owner: string, threadId: string, modelId: string): Promise<MyClawAppModelState>;
  setEffort(owner: string, threadId: string, level: string): Promise<MyClawAppModelState>;
  /** Persists this conversation's context ceiling ("full" for the model's own window). */
  setContext(owner: string, threadId: string, choice: number | "full"): Promise<MyClawAppModelState>;
}

/**
 * Agent defaults (model, effort) and the read-only provider table, injected for the same reason
 * as the model controller: the adapter must not reach into config.json or the model picker itself.
 * Every mutation answers with the whole config snapshot, never an optimistic echo.
 */
export interface MyClawAppAgentsController {
  get(): MyClawAppAgentsConfigResult;
  /**
   * Pins `agents.<agent>.llm.defaultModel`, or `llm.defaultModel` for agent "global". The effort
   * rides in the same pass: `""` removes the pin, undefined leaves the target's own value.
   */
  setModel(agent: string, modelId: string, effort?: string): Promise<MyClawAppAgentsConfigResult>;
  /** Unpins an agent so it inherits again. Refuses "global". */
  clearModel(agent: string): Promise<MyClawAppAgentsConfigResult>;
  /** Pins the vision fallback model (`llm.visionFallback`); "" removes the pin. */
  setFallback(model: string): Promise<MyClawAppAgentsConfigResult>;
  /** Writes the `agents.<agent>.skills|mcp` override. */
  setScope(agent: string, field: "skills" | "mcp", mode: "inherit" | "all" | "list", names: string[]): Promise<MyClawAppAgentsConfigResult>;
  /** Pins `agents.<agent>.workspace`; null removes the pin. */
  setWorkspace(agent: string, workspace: string | null): Promise<MyClawAppAgentsConfigResult>;
  /** Writes `agents.<agent>.maxIterations`; null removes it. */
  setMaxIterations(agent: string, value: number | null): Promise<MyClawAppAgentsConfigResult>;
  /** Writes `agents.<agent>.context.cap`; null removes it. */
  setContextCap(agent: string, value: number | null): Promise<MyClawAppAgentsConfigResult>;
  /** The structured file of a file-defined agent, or null for a reserved role. */
  fileGet(agent: string): Promise<MyClawAppAgentFileResult | null>;
  /** Writes the agent file back; throws on conflict or a file the loader would reject. */
  fileSet(agent: string, fields: MyClawAppAgentFileSet): Promise<MyClawAppAgentFileResult>;
  /** Creates a custom-tier agent file. */
  fileCreate(name: string, description: string): Promise<MyClawAppAgentFileResult>;
  /** Deletes a file-defined agent (custom/workspace tiers only). */
  fileDelete(agent: string): Promise<void>;
}

/** Tag CRUD (docs/tags.md): named aliases for a model/effort/context combo. The virtual
 *  `Default` tag is synthesized into the listing by the entry point. Every mutation answers
 *  with the fresh listing, never an optimistic echo. */
export interface MyClawAppTagsController {
  list(): MyClawAppTagsResult;
  upsert(fields: { name: string; model: string; effort?: string; contextCap?: number }): Promise<MyClawAppTagsResult>;
  delete(name: string): Promise<MyClawAppTagsResult>;
}

/** Provider CRUD and its env key, injected so the adapter never reads config.json or .env
 *  itself. Every provider mutation answers with the fresh agents snapshot, like tags. */
export interface MyClawAppProvidersController {
  /** Creates or edits one entry under llm.providers. */
  upsert(patch: MyClawAppProviderUpsert): Promise<MyClawAppAgentsConfigResult>;
  /** Removes one entry; refused while anything still references it. */
  remove(key: string): Promise<MyClawAppAgentsConfigResult>;
  /** Renames the entry key, rewriting references in the same file. */
  rename(from: string, to: string): Promise<MyClawAppAgentsConfigResult>;
  /** Writes one `NAME=value` line in .env. The one operation that carries a secret value. */
  envSet(name: string, value: string): Promise<void>;
  /** Renames a line in .env and repoints the providers that read the old name. */
  envRename(from: string, to: string): Promise<void>;
  /** Drops a line from .env. */
  envRemove(name: string): Promise<void>;
  /** The names in .env and which provider reads each. Never the values. */
  envList(): Promise<MyClawAppProviderEnvResult>;
}

/** Skill catalog, injected for the same reason as the model controller: the adapter must not
 *  reach into the skill registry or the filesystem itself. */
export interface MyClawAppSkillsController {
  list(): { skills: MyClawAppSkillEntry[] };
  /** Raw SKILL.md text of one skill, or null when it does not exist. */
  read(source: string, name: string, workspace?: string): Promise<string | null>;
  /** The named workspaces plus the default one, for display only. */
  workspaces(): Array<{ key: string; path: string; default: boolean }>;
  /** Moves or copies a skill directory between tiers, then answers with the fresh catalog. */
  transfer(input: MyClawAppSkillTransfer): Promise<{ skills: MyClawAppSkillEntry[] }>;
}

/** What the adapter hands the host once a transfer frame passed its format checks. */
export interface MyClawAppSkillTransfer {
  mode: "copy" | "move";
  source: "built-in" | "custom" | "workspace";
  name: string;
  workspace?: string;
  target: { source: "custom" | "workspace"; workspace?: string };
  overwrite?: boolean;
}

/** Declared MCP servers and their live state, injected so the adapter never touches the manager. */
export interface MyClawAppMcpController {
  list(): MyClawAppMcpEntry[];
  /** Declares a new server; returns the fresh listing. */
  add(spec: MyClawAppMcpAdd): Promise<MyClawAppMcpEntry[]>;
  /** Removes a declared server; returns the fresh listing. */
  remove(name: string): Promise<MyClawAppMcpEntry[]>;
  /** Enables/disables a declared server; returns the fresh listing. */
  setEnabled(name: string, enabled: boolean): Promise<MyClawAppMcpEntry[]>;
}

/** Tool catalog (built-in + plugins + MCP), injected so the adapter never reaches into the registry. */
export interface MyClawAppToolsController {
  list(): { tools: MyClawAppToolEntry[]; missing: string[] };
  /** Toggles the global tools.disabled denylist; returns the fresh catalog. */
  toggle(name: string, disabled: boolean): Promise<{ tools: MyClawAppToolEntry[]; missing: string[] }>;
}

/** The raw config.json, for the one surface with no structured editor. */
export interface MyClawAppConfigController {
  get(): Promise<{ content: string; sha: string; maxBytes: number }>;
  /** Validates through the config parser before writing; returns what the hot reload applied. */
  set(sha: string, content: string): Promise<{
    ok: boolean;
    sha: string;
    conflict: boolean;
    changed: string[];
    rebootRequired: string[];
    error?: string;
  }>;
}

/** Workspace CRUD, injected so the adapter never touches config.json or the filesystem itself.
 *  Every mutation answers with the fresh listing, never an optimistic echo. */
export interface MyClawAppWorkspacesController {
  list(): MyClawAppWorkspacesListResult["workspaces"];
  /** Declares a key -> path pair; the directory is created so the tiers can open under it. */
  add(key: string, path: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
  /** Removes a named workspace; agent pins pointing at it stay and are flagged red. */
  remove(key: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
  /** Renames a key; agents pinned to the old key are rewritten with it. */
  rename(from: string, to: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
  /** Repoints a key at a new absolute path. */
  setPath(key: string, path: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
}

/** The prompt files the app may read and edit. See docs/instructions-page.md. */
export interface MyClawAppInstructionsController {
  list(): Promise<Omit<MyClawAppInstructionsListResult, "type">>;
  read(req: InstructionsTarget): Promise<Omit<MyClawAppInstructionsFile, "type"> | null>;
  write(
    req: InstructionsTarget & { content: string; sha: string | undefined },
  ): Promise<{ ok: boolean; sha: string; conflict: boolean; error?: string }>;
  /** Sets the per-file prompt policy; answers with the fresh listing, never an optimistic echo. */
  setPolicy(
    workspace: string,
    file: string,
    inherit: string | undefined,
    off: boolean | undefined,
  ): Promise<Omit<MyClawAppInstructionsListResult, "type">>;
}

/**
 * What one instructions read or write addresses. `nested` may be absolute, and then it is only
 * accepted against `sessionId`: the controller checks the file is one that session actually read,
 * so no path typed by a device ever reaches the disk on its own word.
 */
export interface InstructionsTarget {
  workspace: string;
  file?: string;
  nested?: string;
  /** Resolved by the adapter from the frame's threadId, so no owner mapping leaves this file. */
  sessionId?: string;
}

/**
 * Scheduled jobs CRUD, injected so the adapter never reaches into the cron store or the live
 * catalogs itself. Every mutation answers with the fresh listing, never an optimistic echo.
 * Model and scope names are never validated at save: the job is the truth, and the listing
 * carries the unknown flags that paint a stale name red instead of refusing it.
 */
export interface MyClawAppJobsController {
  list(): Promise<MyClawAppJobEntry[]>;
  /** Creates (no id) or updates a job. Refused when the schedule does not parse. */
  save(fields: MyClawAppJobSave): Promise<MyClawAppJobEntry[]>;
  /** Removes a job. Refused when no job carries that id. */
  remove(id: string): Promise<MyClawAppJobEntry[]>;
  /** The run sessions of one job, newest first. Refused when the job does not exist. */
  runs(jobId: string): Promise<MyClawAppJobsRunEntry[]>;
}

/**
 * The live sub-agents of a conversation (docs/subagent-navigation.md). Every method takes the
 * caller session, because reachability is decided against it: an unreachable sub-agent answers
 * exactly like a missing one, so neither the adapter nor the app can tell them apart.
 */
export interface MyClawAppSubAgentsController {
  list(callerSessionId: string): Promise<MyClawAppSubAgentEntry[]>;
  /** Deletes the session. The transcript does not survive. Returns the runner's own report. */
  kill(threadId: string, callerSessionId: string): Promise<string>;
  /** Archives the transcript and starts the sub-agent over, identity and workspace kept. */
  reset(threadId: string, callerSessionId: string): Promise<string>;
}

/**
 * Push endpoints and foreground state for the device notifications (docs/notifications.md).
 * Injected so the adapter never writes the push store itself.
 */
export interface MyClawAppNotificationsController {
  /** The VAPID public key the device hands its distributor at registration, if push is on. */
  info(): Promise<string | undefined>;
  register(deviceId: string, frame: MyClawAppNotificationsRegister): Promise<void>;
  unregister(deviceId: string): Promise<void>;
  setForeground(deviceId: string, state: { foreground: boolean; threadId?: string }): Promise<void>;
}

/**
 * A command handler can answer plain text, or -- for /status -- the text plus the structured
 * payload the app draws as a fullscreen page.
 */
export type MyClawAppCommandOutput = {
  text: string;
  status?: MyClawAppStatusPayload;
  /** A long aside the app folds away (a compaction summary), never part of the outcome line. */
  details?: string;
};

/** Text slash commands, executed server-side like on the other channels. */
/** The instructions report of one conversation, built by the host from the live registries. */
export type MyClawAppSessionInstructionsProvider = (sessionId: string) => Promise<MyClawAppSessionInstructions>;

export type MyClawAppCommandHandler = (
  owner: string,
  threadId: string,
  command: string,
  args: string,
) => Promise<string | MyClawAppCommandOutput | undefined>;

export class MyClawAppAdapter implements ChannelAdapter {
  readonly platform = "my-claw-app" as const;
  private server?: Server<MyClawAppSessionData>;
  private sockets = new Map<string, ServerWebSocket<MyClawAppSessionData>>();
  private media = new Map<string, MediaEntry>();
  private mediaOrder: string[] = [];
  /** The unauthenticated pairing surface, kept behind its own object and its own route. */
  private pairSockets = new PairingSockets(() => this.config);
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
      return this.registerMedia(filePathFor(owner, threadId, file.storedName), {
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

  /** Conversation namespace of a device: its configured owner, else the device id itself. */
  private ownerFor(deviceId: string): string {
    return this.config.devices?.[deviceId]?.owner?.trim() || deviceId;
  }

  /**
   * Revoking a device closes its sockets and drops its browser sessions in the same breath:
   * waiting for the next connect would leave a revoked laptop reading the conversation.
   */
  private async handleDeviceRevoke(ws: ServerWebSocket<MyClawAppSessionData>, deviceId: string): Promise<void> {
    if (deviceId === ws.data.deviceId) {
      this.sendFrame(ws, {
        type: "device.revoke.result",
        ok: false,
        deviceId,
        error: "a device cannot revoke itself",
      });
      return;
    }
    const revoked = await revokeDevice(deviceId, this.config);
    if (revoked.ok) {
      await revokeSessionsOfDevice(deviceId);
      const live = this.sockets.get(deviceId);
      if (live) {
        try {
          live.close(1008, "revoked");
        } catch {
          // already gone
        }
        this.sockets.delete(deviceId);
      }
    }
    this.sendFrame(ws, {
      type: "device.revoke.result",
      ok: revoked.ok,
      deviceId,
      ...(revoked.error ? { error: revoked.error } : {}),
    });
  }

  private handlePairLookup(ws: ServerWebSocket<MyClawAppSessionData>, code: string): void {
    const found = lookup(code, ws.data.deviceId);
    if (!found.ok) {
      this.sendFrame(ws, { type: "device.pair.result", ok: false, error: found.reason });
      return;
    }
    // Everything the owner needs to recognise the browser in front of them, and no credential.
    this.sendFrame(ws, {
      type: "device.pair.info",
      code: found.session.code,
      verification: found.session.verification,
      expiresAt: found.session.expiresAt,
      ...(found.session.origin ? { origin: found.session.origin } : {}),
      ...(found.session.ip ? { ip: found.session.ip } : {}),
      ...(found.session.userAgent ? { userAgent: found.session.userAgent } : {}),
    });
  }

  private async handlePairApprove(
    ws: ServerWebSocket<MyClawAppSessionData>,
    code: string,
    name: string,
  ): Promise<void> {
    // The new device joins the approver's owner: a browser paired from a phone lands on the
    // same threads, which is the whole point of the shared namespace.
    const approved = await approve(this.config, code, {
      name: name.trim() || "browser",
      owner: ws.data.owner,
      approver: ws.data.deviceId,
    });
    this.sendFrame(ws, {
      type: "device.pair.result",
      ok: approved.ok,
      ...(approved.ok ? { deviceId: approved.deviceId } : { error: approved.error }),
    });
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

    // Every authenticated route resolves its device the same way: the query pair a native client
    // presents, or the session cookie a browser cannot avoid sending. One resolver, so a route
    // can never end up covering one of the two and not the other.
    if (url.pathname === "/media" && req.method === "POST") {
      const deviceId = this.authenticate(req, url);
      if (!deviceId) return new Response("Unauthorized", { status: 401 });
      return this.handleUpload(this.ownerFor(deviceId), req);
    }

    if (url.pathname.startsWith("/media/")) {
      const id = url.pathname.slice("/media/".length);
      const deviceId = this.authenticate(req, url);
      if (!deviceId) return new Response("Unauthorized", { status: 401 });
      return this.serveMedia(id, this.ownerFor(deviceId), url.searchParams.get("thumb") === "1");
    }

    if (url.pathname === "/skills") {
      if (!this.authenticate(req, url)) return new Response("Unauthorized", { status: 401 });
      return this.serveSkill(
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
        owner: this.ownerFor(deviceId),
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
      if (server.upgrade(req, { data: { deviceId, owner: this.ownerFor(deviceId), lastSeen: Date.now() } })) {
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
          return new Response(null, { status: 302, headers: securityHeaders({ Location: "/pair" }) });
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

  private async serveSkill(source: string, name: string, workspace?: string): Promise<Response> {
    if (!this.skills) return new Response("Skill catalog unavailable", { status: 503 });
    if (source !== "built-in" && source !== "custom" && source !== "workspace") {
      return new Response("Bad Request", { status: 400 });
    }
    // First fence: the name only ever feeds the controller, and the controller re-checks the
    // resolved path against the tier root, but a name that could smuggle path segments has no
    // legitimate use and is refused before anything touches the filesystem. The workspace key
    // is a config key, never a path, and is held to the same charset.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return new Response("Bad Request", { status: 400 });
    }
    if (workspace !== undefined && !/^[A-Za-z0-9._-]+$/.test(workspace)) {
      return new Response("Bad Request", { status: 400 });
    }
    const content = await this.skills.read(source, name, workspace);
    if (content === null) return new Response("Not Found", { status: 404 });
    return new Response(content, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  }

  private async serveMedia(id: string, owner: string | undefined, thumb: boolean): Promise<Response> {
    let path: string | undefined;
    let mimeType = "application/octet-stream";
    let filename: string | undefined;
    const entry = this.media.get(id);
    if (entry) {
      path = entry.path;
      mimeType = entry.mimeType ?? mimeTypeForPath(path) ?? "application/octet-stream";
      filename = entry.filename;
    } else if (owner) {
      const found = await this.files.readById(owner, id);
      if (found) {
        path = found.path;
        mimeType = found.file.mimeType;
        filename = found.file.filename;
      }
    }
    if (!path) return new Response("Not Found", { status: 404 });

    if (thumb) {
      if (!mimeType.startsWith("video/")) return new Response("Not Found", { status: 404 });
      const generated = await this.thumbnailFor(owner ?? "", id, path);
      if (!generated) {
        await myClawAppLog("warn", "video thumbnail unavailable", { owner, id });
        return new Response("Not Found", { status: 404 });
      }
      path = generated;
      mimeType = "image/jpeg";
      filename = undefined;
    }

    const headers: Record<string, string> = {
      "Content-Type": mimeType,
    };
    if (filename) {
      headers["Content-Disposition"] = `attachment; filename="${filename.replace(/["\\]/g, "")}"`;
    }
    return new Response(Bun.file(path), { headers });
  }

  /** One extraction per video: an in-flight promise dedupes concurrent first requests, and the
   *  file on disk answers every later one. */
  private thumbnails = new Map<string, Promise<string | undefined>>();

  private thumbnailFor(owner: string, id: string, videoPath: string): Promise<string | undefined> {
    const target = thumbPathFor(owner, id);
    const inflight = this.thumbnails.get(target);
    if (inflight) return inflight;
    const pending = (async (): Promise<string | undefined> => {
      try {
        await stat(target);
        return target;
      } catch {
        // not cached yet: generate
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await extractVideoThumbnail(videoPath, target);
        return target;
      } catch {
        return undefined;
      }
    })();
    this.thumbnails.set(target, pending);
    void pending.then(() => this.thumbnails.delete(target));
    return pending;
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
    // No size cap on this channel: uploads and agent attachments are streamed/copied to disk
    // as-is. A payload past the warning threshold is logged and stored anyway.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > this.files.warnSizeBytes) {
      await myClawAppLog("warn", "large upload", { owner, threadId: safeThread, declared, threshold: this.files.warnSizeBytes });
    }
    try {
      const file = await this.files.saveStream(owner, safeThread, filename, req.body);
      await myClawAppLog("info", "file uploaded", { owner, threadId: safeThread, id: file.id, size: file.sizeBytes, type });
      return Response.json({ id: file.id, type: type || file.type, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Upload failed";
      await myClawAppLog("warn", "upload failed", { owner, threadId: safeThread, filename, reason });
      return new Response(reason, { status: 400 });
    }
  }

  /**
   * Registers media for serving. `id` is the session-store file id when the bytes were copied
   * into the store (agent attachments), so the look-aside cache and the persistent file agree:
   * an evicted cache entry still resolves through the store, and files.delete matches.
   */
  private registerMedia(path: string, meta: { type: "image" | "audio" | "video" | "file" } & Omit<MediaEntry, "path" | "type">, id: string = crypto.randomUUID()): MyClawAppAttachmentMeta | undefined {
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
    if (ws.data.pairing) {
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
      this.pairSockets.close(ws as unknown as ServerWebSocket<PairSocketData>);
      return;
    }
    if (this.sockets.get(ws.data.deviceId) === ws) {
      this.sockets.delete(ws.data.deviceId);
    }
    void myClawAppLog("info", "device disconnected", { deviceId: ws.data.deviceId });
  }

  private handleMessage(ws: ServerWebSocket<MyClawAppSessionData>, message: string | Buffer): void {
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
      void this.emitChatSend(ws, { type: "chat.send", id: crypto.randomUUID(), text: raw });
      return;
    }

    switch (frame.type) {
      case "chat.send":
        void this.emitChatSend(ws, frame);
        break;
      case "location.preview":
        void this.handleLocationPreview(ws, frame);
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
      case "diag.report":
        void this.handleDiagReport(ws, frame);
        break;
      case "logs.tail":
        void this.handleLogsTail(ws, frame);
        break;
      case "commands.list":
        void ws.send(JSON.stringify({
          type: "commands.list.result",
          commands: APP_COMMANDS.map(({ command, description }) => ({ name: command, description })),
        }));
        break;
      case "files.list":
        void this.handleFilesList(ws, frame);
        break;
      case "session.rename":
        void this.handleSessionRename(ws, frame);
        break;
      case "session.workspace.set":
        void this.handleSessionWorkspaceSet(ws, frame);
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
      case "skills.copy":
      case "skills.move":
        void this.handleSkillsTransfer(ws, frame);
        break;
      case "skills.list":
        void this.handleSkillsList(ws);
        break;
      case "workspaces.list":
        void this.handleWorkspacesList(ws);
        break;
      case "workspaces.add":
        void this.handleWorkspacesAdd(ws, frame);
        break;
      case "workspaces.remove":
        void this.handleWorkspacesRemove(ws, frame);
        break;
      case "workspaces.rename":
        void this.handleWorkspacesRename(ws, frame);
        break;
      case "workspaces.path.set":
        void this.handleWorkspacesSetPath(ws, frame);
        break;
      case "mcp.list":
        void this.handleMcpList(ws);
        break;
      case "tools.list":
        void this.handleToolsList(ws);
        break;
      case "instructions.list":
        void this.handleInstructionsList(ws);
        break;
      case "instructions.get":
        void this.handleInstructionsGet(ws, frame);
        break;
      case "instructions.set":
        void this.handleInstructionsSet(ws, frame);
        break;
      case "instructions.layer.set":
        void this.handleInstructionsLayerSet(ws, frame);
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
      case "model.context.set":
        void this.handleModelContext(ws, frame);
        break;
      case "agents.config.get":
        void this.handleAgentsConfigGet(ws, frame);
        break;
      case "tags.list":
        void this.handleTagsList(ws);
        break;
      case "tags.upsert":
        void this.handleTagsUpsert(ws, frame);
        break;
      case "tags.delete":
        void this.handleTagsDelete(ws, frame);
        break;
      case "providers.upsert":
        void this.handleProviderUpsert(ws, frame);
        break;
      case "providers.remove":
        void this.handleProviderRemove(ws, frame);
        break;
      case "providers.rename":
        void this.handleProviderRename(ws, frame);
        break;
      case "providers.env.set":
        void this.handleProviderEnvSet(ws, frame);
        break;
      case "providers.env.rename":
        void this.handleProviderEnvRename(ws, frame);
        break;
      case "providers.env.list":
        void this.handleProviderEnvList(ws);
        break;
      case "providers.env.remove":
        void this.handleProviderEnvRemove(ws, frame);
        break;
      case "agents.model.set":
        void this.handleAgentsModelSet(ws, frame);
        break;
      case "agents.model.clear":
        void this.handleAgentsModelClear(ws, frame);
        break;
      case "agents.fallback.set":
        void this.handleAgentsFallbackSet(ws, frame);
        break;
      case "agents.scope.set":
        void this.handleAgentsScopeSet(ws, frame);
        break;
      case "agents.workspace.set":
        void this.handleAgentsWorkspaceSet(ws, frame);
        break;
      case "agents.iterations.set":
        void this.handleAgentsIterationsSet(ws, frame);
        break;
      case "agents.contextcap.set":
        void this.handleAgentsContextCapSet(ws, frame);
        break;
      case "agents.file.get":
        void this.handleAgentFileGet(ws, frame);
        break;
      case "agents.file.set":
        void this.handleAgentFileSet(ws, frame);
        break;
      case "agents.file.create":
        void this.handleAgentFileCreate(ws, frame);
        break;
      case "agents.file.delete":
        void this.handleAgentFileDelete(ws, frame);
        break;
      case "tools.toggle":
        void this.handleToolsToggle(ws, frame);
        break;
      case "mcp.add":
        void this.handleMcpAdd(ws, frame);
        break;
      case "mcp.remove":
        void this.handleMcpRemove(ws, frame);
        break;
      case "mcp.enable":
        void this.handleMcpEnable(ws, frame);
        break;
      case "config.get":
        void this.handleConfigGet(ws, frame);
        break;
      case "config.set":
        void this.handleConfigSet(ws, frame);
        break;
      case "chat.stop":
        void this.handleChatStop(ws, frame);
        break;
      case "status.get":
        void this.handleStatusGet(ws, frame);
        break;
      case "session.instructions.get":
        void this.handleSessionInstructionsGet(ws, frame);
        break;
      case "jobs.list":
        void this.handleJobsList(ws);
        break;
      case "jobs.runs":
        void this.handleJobsRuns(ws, frame);
        break;
      case "device.list":
        this.sendFrame(ws, {
          type: "device.list.result",
          devices: listDevices(this.config).map((device) => ({
            ...device,
            self: device.deviceId === ws.data.deviceId,
          })),
        });
        break;
      case "device.revoke":
        void this.handleDeviceRevoke(ws, frame.deviceId);
        break;
      case "device.pair.lookup":
        this.handlePairLookup(ws, frame.code);
        break;
      case "device.pair.approve":
        void this.handlePairApprove(ws, frame.code, frame.name);
        break;
      case "device.pair.deny":
        this.sendFrame(ws, {
          type: "device.pair.result",
          ok: deny(frame.code, ws.data.deviceId),
        });
        break;
      case "subagents.list":
        void this.handleSubAgentsList(ws, frame);
        break;
      case "subagents.kill":
      case "subagents.reset":
        void this.handleSubAgentAction(ws, frame);
        break;
      case "jobs.save":
        void this.handleJobSave(ws, frame);
        break;
      case "jobs.delete":
        void this.handleJobDelete(ws, frame);
        break;
      case "notifications.register":
        void this.handleNotificationsRegister(ws, frame);
        break;
      case "notifications.state":
        void this.handleNotificationsState(ws, frame);
        break;

      case "files.delete":
        void this.handleFileDelete(ws, frame);
        break;
      case "session.history":
        this.handleSessionHistory(ws, frame);
        break;
      case "session.archive":
      case "session.unarchive":
        void this.handleSessionArchive(ws, frame);
        break;
      case "session.delete":
        void this.handleSessionDelete(ws, frame);
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
    details?: string,
  ): Promise<void> {
    if (renderedAsPage || CLEARING_COMMANDS.has(command)) return;
    const redacted = redactCommandArgs(command, args);
    const input = redacted ? `/${command} ${redacted}` : `/${command}`;
    try {
      await this.store.recordCommand(owner, threadId, input, output, details);
    } catch (err) {
      void myClawAppLog("error", "command journal failed", { owner, threadId, command, error: String(err) });
    }
  }

  private async emitChatSend(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppChatSend,
  ): Promise<void> {
    const owner = ws.data.owner;
    const text = frame.text.trim();
    const hasLocation = frame.location !== undefined;
    if (!text && !frame.attachments?.length && !hasLocation) return;

    const threadId = sanitizeThreadId(frame.threadId ?? "") ?? DEFAULT_THREAD;

    // Slash commands run on the server, exactly as they do on the other channels: a command
    // sent to the model as a plain question would be answered from nothing. The user's own
    // bubble is drawn by the app from its send; only the result is new here. Only the catalog
    // is intercepted: an unknown /word is a question like any other and must reach the agent.
    if (text && !frame.attachments?.length && !hasLocation && this.commandHandler) {
      const command = /^\/([a-z-]+)/i.exec(text)?.[1];
      if (command && APP_COMMANDS.some((c) => c.command === command)) {
        const args = text.slice(command.length + 1).trim();
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
            await this.journalCommand(owner, threadId, command, args, text, status !== undefined, details);
          }
          return;
        } catch (err) {
          clearTimeout(pending);
          void myClawAppLog("error", "command failed", { owner, threadId, command, error: String(err) });
          const failure = `error: ${err instanceof Error ? err.message : String(err)}`;
          this.broadcast(owner, { type: "chat.command.result", threadId, replyToId: frame.id, text: failure });
          await this.journalCommand(owner, threadId, command, args, failure, false);
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
      ...(location ? { location } : {}),
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

  private async handleAgentsConfigGet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    _frame: MyClawAppAgentsConfigGet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    try {
      this.sendFrame(ws, this.agents.get());
    } catch (err) {
      await this.refuse(ws, "agents", "agents.config.get failed", { error: String(err) });
    }
  }

  private async handleTagsList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.tags) {
      await this.refuse(ws, "tags", "tags unavailable");
      return;
    }
    try {
      this.sendFrame(ws, this.tags.list());
    } catch (err) {
      await this.refuse(ws, "tags", "tags.list failed", { error: String(err) });
    }
  }

  private async handleTagsUpsert(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppTagsUpsert,
  ): Promise<void> {
    if (!this.tags) {
      await this.refuse(ws, "tags", "tags unavailable");
      return;
    }
    if (!frame.name || !frame.model) {
      await this.refuse(ws, "tags", "invalid tag name or model", { name: frame.name, model: frame.model });
      return;
    }
    try {
      this.sendFrame(ws, await this.tags.upsert(frame));
    } catch (err) {
      await this.refuse(ws, "tags", "tags.upsert failed", { name: frame.name, model: frame.model, error: String(err) });
    }
  }

  private async handleTagsDelete(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppTagsDelete,
  ): Promise<void> {
    if (!this.tags) {
      await this.refuse(ws, "tags", "tags unavailable");
      return;
    }
    if (!frame.name) {
      await this.refuse(ws, "tags", "invalid tag name");
      return;
    }
    try {
      this.sendFrame(ws, await this.tags.delete(frame.name));
    } catch (err) {
      await this.refuse(ws, "tags", "tags.delete failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleProviderUpsert(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppProviderUpsert,
  ): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    if (!frame.key) {
      await this.refuse(ws, "providers", "invalid provider key");
      return;
    }
    try {
      this.sendFrame(ws, await this.providers.upsert(frame));
    } catch (err) {
      await this.refuse(ws, "providers", "providers.upsert failed", { key: frame.key, error: String(err) });
    }
  }

  private async handleProviderRemove(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppProviderRemove,
  ): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    if (!frame.key) {
      await this.refuse(ws, "providers", "invalid provider key");
      return;
    }
    try {
      this.sendFrame(ws, await this.providers.remove(frame.key));
    } catch (err) {
      await this.refuse(ws, "providers", "providers.remove failed", { key: frame.key, error: String(err) });
    }
  }

  private async handleProviderRename(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppProviderRename,
  ): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    if (!frame.from || !frame.to) {
      await this.refuse(ws, "providers", "invalid provider rename", { from: frame.from, to: frame.to });
      return;
    }
    try {
      this.sendFrame(ws, await this.providers.rename(frame.from, frame.to));
    } catch (err) {
      await this.refuse(ws, "providers", "providers.rename failed", { from: frame.from, to: frame.to, error: String(err) });
    }
  }

  /** The value is a secret: it never appears in a refusal's data or a log line. */
  private async handleProviderEnvSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppProviderEnvSet,
  ): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    if (!frame.name || !frame.value) {
      await this.refuse(ws, "providers", "invalid env name or value", { name: frame.name });
      return;
    }
    try {
      await this.providers.envSet(frame.name, frame.value);
      await this.sendFrame(ws, await this.providers.envList());
    } catch (err) {
      await this.refuse(ws, "providers", "providers.env.set failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleProviderEnvRename(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppProviderEnvRename,
  ): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    if (!frame.from || !frame.to) {
      await this.refuse(ws, "providers", "invalid env rename", { from: frame.from, to: frame.to });
      return;
    }
    try {
      await this.providers.envRename(frame.from, frame.to);
      await this.sendFrame(ws, await this.providers.envList());
    } catch (err) {
      await this.refuse(ws, "providers", "providers.env.rename failed", { from: frame.from, to: frame.to, error: String(err) });
    }
  }

  private async handleProviderEnvList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    try {
      await this.sendFrame(ws, await this.providers.envList());
    } catch (err) {
      await this.refuse(ws, "providers", "providers.env.list failed", { error: String(err) });
    }
  }

  private async handleProviderEnvRemove(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppProviderEnvRemove,
  ): Promise<void> {
    if (!this.providers) {
      await this.refuse(ws, "providers", "provider config unavailable");
      return;
    }
    if (!frame.name) {
      await this.refuse(ws, "providers", "invalid env name");
      return;
    }
    try {
      await this.providers.envRemove(frame.name);
      await this.sendFrame(ws, await this.providers.envList());
    } catch (err) {
      await this.refuse(ws, "providers", "providers.env.remove failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleAgentsModelSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsModelSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.model || !frame.agent) {
      await this.refuse(ws, "agents", "invalid agent or model", { agent: frame.agent, model: frame.model });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.setModel(frame.agent, frame.model, frame.effort));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.model.set failed", { agent: frame.agent, model: frame.model, effort: frame.effort, error: String(err) });
    }
  }

  private async handleAgentsModelClear(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsModelClear,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.clearModel(frame.agent));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.model.clear failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentsFallbackSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsFallbackSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (typeof frame.model !== "string") {
      await this.refuse(ws, "agents", "invalid fallback model", { model: frame.model });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.setFallback(frame.model));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.fallback.set failed", { model: frame.model, error: String(err) });
    }
  }

  private async handleAgentsScopeSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsScopeSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent || (frame.field !== "skills" && frame.field !== "mcp") || !["inherit", "all", "list"].includes(frame.mode)) {
      await this.refuse(ws, "agents", "invalid scope request", { agent: frame.agent, field: frame.field, mode: frame.mode });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.setScope(frame.agent, frame.field, frame.mode, frame.names ?? []));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.scope.set failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentsWorkspaceSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsWorkspaceSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.setWorkspace(frame.agent, frame.workspace));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.workspace.set failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentsIterationsSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsIterationsSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.setMaxIterations(frame.agent, frame.value));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.iterations.set failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentsContextCapSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentsContextCapSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.setContextCap(frame.agent, frame.value));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.contextcap.set failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentFileGet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentFileGet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      const file = await this.agents.fileGet(frame.agent);
      if (!file) {
        await this.refuse(ws, "agents", "not a file-defined agent", { agent: frame.agent });
        return;
      }
      this.sendFrame(ws, file);
    } catch (err) {
      await this.refuse(ws, "agents", "agents.file.get failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentFileSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentFileSet,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.fileSet(frame.agent, frame));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.file.set failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleAgentFileCreate(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentFileCreate,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.name || !frame.description) {
      await this.refuse(ws, "agents", "name and description are required", { name: frame.name });
      return;
    }
    try {
      this.sendFrame(ws, await this.agents.fileCreate(frame.name, frame.description));
    } catch (err) {
      await this.refuse(ws, "agents", "agents.file.create failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleAgentFileDelete(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppAgentFileDelete,
  ): Promise<void> {
    if (!this.agents) {
      await this.refuse(ws, "agents", "agent defaults unavailable");
      return;
    }
    if (!frame.agent) {
      await this.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
      return;
    }
    try {
      await this.agents.fileDelete(frame.agent);
      this.sendFrame(ws, { type: "agents.file.saved", name: frame.agent, ok: true, sha: "", conflict: false });
    } catch (err) {
      await this.refuse(ws, "agents", "agents.file.delete failed", { agent: frame.agent, error: String(err) });
    }
  }

  private async handleToolsToggle(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppToolsToggle,
  ): Promise<void> {
    if (!this.tools) {
      await this.refuse(ws, "tools", "tool catalog unavailable");
      return;
    }
    if (!frame.name) {
      await this.refuse(ws, "tools", "invalid tool", { name: frame.name });
      return;
    }
    try {
      this.sendFrame(ws, { type: "tools.list.result", ...(await this.tools.toggle(frame.name, frame.disabled)) });
    } catch (err) {
      await this.refuse(ws, "tools", "tools.toggle failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleMcpAdd(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppMcpAdd,
  ): Promise<void> {
    if (!this.mcp) {
      await this.refuse(ws, "mcp", "MCP status unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "mcp.list.result", servers: await this.mcp.add(frame) });
    } catch (err) {
      await this.refuse(ws, "mcp", "mcp.add failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleMcpRemove(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppMcpRemove,
  ): Promise<void> {
    if (!this.mcp) {
      await this.refuse(ws, "mcp", "MCP status unavailable");
      return;
    }
    if (!frame.name) {
      await this.refuse(ws, "mcp", "invalid MCP server", { name: frame.name });
      return;
    }
    try {
      this.sendFrame(ws, { type: "mcp.list.result", servers: await this.mcp.remove(frame.name) });
    } catch (err) {
      await this.refuse(ws, "mcp", "mcp.remove failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleMcpEnable(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppMcpEnable,
  ): Promise<void> {
    if (!this.mcp) {
      await this.refuse(ws, "mcp", "MCP status unavailable");
      return;
    }
    if (!frame.name) {
      await this.refuse(ws, "mcp", "invalid MCP server", { name: frame.name });
      return;
    }
    try {
      this.sendFrame(ws, { type: "mcp.list.result", servers: await this.mcp.setEnabled(frame.name, frame.enabled) });
    } catch (err) {
      await this.refuse(ws, "mcp", "mcp.enable failed", { name: frame.name, error: String(err) });
    }
  }

  private async handleConfigGet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    _frame: MyClawAppConfigGet,
  ): Promise<void> {
    if (!this.configEditor) {
      await this.refuse(ws, "config", "config editor unavailable");
      return;
    }
    try {
      const file = await this.configEditor.get();
      this.sendFrame(ws, { type: "config.result", ...file });
    } catch (err) {
      await this.refuse(ws, "config", "config.get failed", { error: String(err) });
    }
  }

  private async handleConfigSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppConfigSet,
  ): Promise<void> {
    if (!this.configEditor) {
      await this.refuse(ws, "config", "config editor unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "config.saved", ...(await this.configEditor.set(frame.sha, frame.content)) });
    } catch (err) {
      await this.refuse(ws, "config", "config.set failed", { error: String(err) });
    }
  }

  private async handleSkillsList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.skills) {
      await this.refuse(ws, "skills", "skill catalog unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "skills.list.result", ...this.skills.list() });
    } catch (err) {
      await this.refuse(ws, "skills", "skills.list failed", { error: String(err) });
    }
  }

  /** The charset of a skill name and of a workspace key on this channel: no separator can reach
   *  the filesystem, which is the first of the two fences (the controller re-resolves the path
   *  against the tier root). Same rule as GET /skills. */
  private static readonly SKILL_TOKEN = /^[A-Za-z0-9._-]+$/;

  private async handleSkillsTransfer(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppSkillsTransfer,
  ): Promise<void> {
    if (!this.skills) {
      await this.refuse(ws, "skills", "skill catalog unavailable");
      return;
    }
    const detail = { name: frame.name, source: frame.source, target: frame.target?.source };
    if (frame.source !== "built-in" && frame.source !== "custom" && frame.source !== "workspace") {
      await this.refuse(ws, "skills", "unknown skill tier", detail);
      return;
    }
    if (frame.target?.source !== "custom" && frame.target?.source !== "workspace") {
      await this.refuse(ws, "skills", "a skill can only be written to custom or a workspace", detail);
      return;
    }
    const keys = [frame.name, frame.workspace, frame.target.workspace];
    if (keys.some((key) => key !== undefined && !MyClawAppAdapter.SKILL_TOKEN.test(key))) {
      await this.refuse(ws, "skills", "invalid skill name or workspace key", detail);
      return;
    }
    try {
      const result = await this.skills.transfer({
        mode: frame.type === "skills.move" ? "move" : "copy",
        source: frame.source,
        name: frame.name,
        ...(frame.workspace ? { workspace: frame.workspace } : {}),
        target: {
          source: frame.target.source,
          ...(frame.target.workspace ? { workspace: frame.target.workspace } : {}),
        },
        ...(frame.overwrite ? { overwrite: true } : {}),
      });
      this.sendFrame(ws, { type: "skills.list.result", ...result });
    } catch (err) {
      await this.refuse(ws, "skills", `${frame.type} failed`, { ...detail, error: String(err) });
    }
  }

  private async handleWorkspacesList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.workspacesCtrl) {
      await this.refuse(ws, "workspaces", "workspace list unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "workspaces.list.result", workspaces: this.workspacesCtrl.list() });
    } catch (err) {
      await this.refuse(ws, "workspaces", "workspaces.list failed", { error: String(err) });
    }
  }

  private async handleWorkspacesAdd(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppWorkspacesAdd,
  ): Promise<void> {
    if (!this.workspacesCtrl) {
      await this.refuse(ws, "workspaces", "workspace list unavailable");
      return;
    }
    if (!frame.key || !frame.path) {
      await this.refuse(ws, "workspaces", "key and path are required", { key: frame.key, path: frame.path });
      return;
    }
    try {
      this.sendFrame(ws, { type: "workspaces.list.result", workspaces: await this.workspacesCtrl.add(frame.key, frame.path) });
    } catch (err) {
      await this.refuse(ws, "workspaces", "workspaces.add failed", { key: frame.key, error: String(err) });
    }
  }

  private async handleWorkspacesRemove(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppWorkspacesRemove,
  ): Promise<void> {
    if (!this.workspacesCtrl) {
      await this.refuse(ws, "workspaces", "workspace list unavailable");
      return;
    }
    if (!frame.key) {
      await this.refuse(ws, "workspaces", "invalid workspace", { key: frame.key });
      return;
    }
    try {
      this.sendFrame(ws, { type: "workspaces.list.result", workspaces: await this.workspacesCtrl.remove(frame.key) });
    } catch (err) {
      await this.refuse(ws, "workspaces", "workspaces.remove failed", { key: frame.key, error: String(err) });
    }
  }

  private async handleWorkspacesRename(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppWorkspacesRename,
  ): Promise<void> {
    if (!this.workspacesCtrl) {
      await this.refuse(ws, "workspaces", "workspace list unavailable");
      return;
    }
    if (!frame.from || !frame.to) {
      await this.refuse(ws, "workspaces", "from and to are required", { from: frame.from, to: frame.to });
      return;
    }
    try {
      this.sendFrame(ws, { type: "workspaces.list.result", workspaces: await this.workspacesCtrl.rename(frame.from, frame.to) });
    } catch (err) {
      await this.refuse(ws, "workspaces", "workspaces.rename failed", { from: frame.from, error: String(err) });
    }
  }

  private async handleWorkspacesSetPath(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppWorkspacesSetPath,
  ): Promise<void> {
    if (!this.workspacesCtrl) {
      await this.refuse(ws, "workspaces", "workspace list unavailable");
      return;
    }
    if (!frame.key || !frame.path) {
      await this.refuse(ws, "workspaces", "key and path are required", { key: frame.key, path: frame.path });
      return;
    }
    try {
      this.sendFrame(ws, { type: "workspaces.list.result", workspaces: await this.workspacesCtrl.setPath(frame.key, frame.path) });
    } catch (err) {
      await this.refuse(ws, "workspaces", "workspaces.path.set failed", { key: frame.key, error: String(err) });
    }
  }

  private async handleMcpList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.mcp) {
      await this.refuse(ws, "mcp", "MCP status unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "mcp.list.result", servers: this.mcp.list() });
    } catch (err) {
      await this.refuse(ws, "mcp", "mcp.list failed", { error: String(err) });
    }
  }

  private async handleToolsList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.tools) {
      await this.refuse(ws, "tools", "tool catalog unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "tools.list.result", ...this.tools.list() });
    } catch (err) {
      await this.refuse(ws, "tools", "tools.list failed", { error: String(err) });
    }
  }

  private async handleJobsList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.jobs) {
      await this.refuse(ws, "jobs", "job store unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "jobs.list.result", jobs: await this.jobs.list() });
    } catch (err) {
      await this.refuse(ws, "jobs", "jobs.list failed", { error: String(err) });
    }
  }

  private async handleJobsRuns(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppJobsRuns,
  ): Promise<void> {
    if (!this.jobs) {
      await this.refuse(ws, "jobs", "job store unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "jobs.runs.result", jobId: frame.jobId, runs: await this.jobs.runs(frame.jobId) });
    } catch (err) {
      await this.refuse(ws, "jobs", "jobs.runs failed", { jobId: frame.jobId, error: String(err) });
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

  private async handleJobSave(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppJobSave,
  ): Promise<void> {
    if (!this.jobs) {
      await this.refuse(ws, "jobs", "job store unavailable");
      return;
    }
    if (!frame.prompt.trim() || !frame.schedule.trim()) {
      await this.refuse(ws, "jobs", "prompt and schedule are required", {
        name: frame.name,
        hasPrompt: Boolean(frame.prompt.trim()),
        hasSchedule: Boolean(frame.schedule.trim()),
      });
      return;
    }
    try {
      this.sendFrame(ws, { type: "jobs.list.result", jobs: await this.jobs.save(frame) });
    } catch (err) {
      await this.refuse(ws, "jobs", "jobs.save failed", { name: frame.name, id: frame.id, error: String(err) });
    }
  }

  private async handleJobDelete(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppJobDelete,
  ): Promise<void> {
    if (!this.jobs) {
      await this.refuse(ws, "jobs", "job store unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "jobs.list.result", jobs: await this.jobs.remove(frame.id) });
    } catch (err) {
      await this.refuse(ws, "jobs", "jobs.delete failed", { id: frame.id, error: String(err) });
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

  private async handleInstructionsList(ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
    if (!this.instructions) {
      await this.refuse(ws, "instructions", "instructions unavailable");
      return;
    }
    try {
      this.sendFrame(ws, { type: "instructions.list.result", ...(await this.instructions.list()) });
    } catch (err) {
      await this.refuse(ws, "instructions", "instructions.list failed", { error: String(err) });
    }
  }

  private async handleInstructionsGet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppInstructionsGet,
  ): Promise<void> {
    if (!this.instructions) {
      await this.refuse(ws, "instructions", "instructions unavailable");
      return;
    }
    try {
      const read = await this.instructions.read({
        workspace: frame.workspace,
        ...(frame.file ? { file: frame.file } : {}),
        ...(frame.nested ? { nested: frame.nested } : {}),
        ...(this.sessionIdOf(ws, frame.threadId)),
      });
      if (!read) {
        await this.refuse(ws, "instructions", "unknown instruction file", {
          workspace: frame.workspace,
          file: frame.file ?? frame.nested ?? "",
        });
        return;
      }
      this.sendFrame(ws, { type: "instructions.file", ...read });
    } catch (err) {
      await this.refuse(ws, "instructions", "instructions.get failed", { error: String(err) });
    }
  }

  private async handleInstructionsSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppInstructionsSet,
  ): Promise<void> {
    if (!this.instructions) {
      await this.refuse(ws, "instructions", "instructions unavailable");
      return;
    }
    if (typeof frame.content !== "string") {
      await this.refuse(ws, "instructions", "instructions.set without content");
      return;
    }
    try {
      const res = await this.instructions.write({
        workspace: frame.workspace,
        ...(frame.file ? { file: frame.file } : {}),
        ...(frame.nested ? { nested: frame.nested } : {}),
        ...(this.sessionIdOf(ws, frame.threadId)),
        content: frame.content,
        sha: frame.sha,
      });
      // A refused write answers on its own frame rather than through the error scope: the editor
      // has to tell a conflict apart from a failure, and only one of them means "reload first".
      this.sendFrame(ws, {
        type: "instructions.saved",
        workspace: frame.workspace,
        file: frame.nested ?? frame.file,
        ok: res.ok,
        sha: res.sha,
        conflict: res.conflict,
        ...(res.error ? { error: res.error } : {}),
      });
      if (!res.ok) {
        await myClawAppLog("warn", "instructions.set refused", {
          deviceId: ws.data.deviceId,
          workspace: frame.workspace,
          file: frame.file,
          error: res.error ?? "",
        });
      }
    } catch (err) {
      await this.refuse(ws, "instructions", "instructions.set failed", { error: String(err) });
    }
  }

  private async handleInstructionsLayerSet(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppInstructionsLayerSet,
  ): Promise<void> {
    if (!this.instructions) {
      await this.refuse(ws, "instructions", "instructions unavailable");
      return;
    }
    if (typeof frame.file !== "string" || !frame.file) {
      await this.refuse(ws, "instructions", "instructions.layer.set without file");
      return;
    }
    try {
      // A policy mutation answers with the fresh listing, like every other mutation: the layer
      // screen redraws from what the server stored, never from what it hoped to store.
      const list = await this.instructions.setPolicy(frame.workspace, frame.file, frame.inherit, frame.off);
      this.sendFrame(ws, { type: "instructions.list.result", ...list });
    } catch (err) {
      await this.refuse(ws, "instructions", "instructions.layer.set failed", {
        workspace: frame.workspace,
        file: frame.file,
        error: String(err),
      });
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

  private async handleModelContext(
    ws: ServerWebSocket<MyClawAppSessionData>,
    frame: MyClawAppModelContextSet,
  ): Promise<void> {
    const safeThread = sanitizeThreadId(frame.threadId);
    if (!safeThread) {
      await this.refuse(ws, "model", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    if (!this.models) {
      await this.refuse(ws, "model", "model control unavailable");
      return;
    }
    const choice = frame.choice;
    if (choice !== "full" && (typeof choice !== "number" || !Number.isFinite(choice) || choice <= 0)) {
      await this.refuse(ws, "model", "invalid context choice", { threadId: safeThread, choice: String(choice) });
      return;
    }
    try {
      const state = await this.models.setContext(ws.data.owner, safeThread, choice);
      this.sendFrame(ws, { type: "model.result", threadId: safeThread, ...state });
    } catch (err) {
      await this.refuse(ws, "model", "model.context.set failed", { threadId: safeThread, error: String(err) });
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

  /**
   * The fullscreen status page asks directly, without typing a command: same server-side report,
   * delivered as a dedicated frame so the app does not have to fake a chat.send to get it.
   */
  private async handleStatusGet(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppStatusGet): Promise<void> {
    const threadId = sanitizeThreadId(frame.threadId);
    if (!threadId) {
      await this.refuse(ws, "status", "invalid threadId", { threadId: frame.threadId });
      return;
    }
    if (!this.commandHandler) {
      await this.refuse(ws, "status", "status unavailable");
      return;
    }
    const output = await this.commandHandler(ws.data.owner, threadId, "status", "");
    if (!output) {
      await this.refuse(ws, "status", "status unavailable");
      return;
    }
    const text = typeof output === "string" ? output : output.text;
    const status = typeof output === "string" ? undefined : output.status;
    if (!status) {
      await this.refuse(ws, "status", "status unavailable");
      return;
    }
    this.sendFrame(ws, { type: "status.result", threadId, text, status });
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
