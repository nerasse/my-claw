import { join, resolve } from "node:path";
import type { MyClawConfig } from "../core/config.ts";
import { resolveAgentWorkspace, resolveWorkspaceKey, workspaceKeyForDir } from "../core/config.ts";
import { resolveRunModel, type RunModel, type RunModelRequest } from "../llm/run-model.ts";
import type { EffortLevel } from "../core/config.ts";
import { availabilityWorld } from "../llm/world.ts";
import { announceModelFallback } from "../llm/fallback-notice.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { BrowserSession } from "../tools/browser/session.ts";
import { AgentBridge } from "../agent/bridge.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback, MediaStoreHook } from "../agent/backend.ts";

import type { ToolApprovalHandler, UnifiedMessage, Attachment } from "../channels/types.ts";
import type { SessionAttachment, SessionData } from "../sessions/store.ts";
import { loadSession, deleteStoredSession, archiveSession, recordSubAgentCaller, subagentSessionIdsSync } from "../sessions/store.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import { metaOf, readMeta, writeMeta } from "../sessions/meta.ts";
import type { SessionLog, UserEntry } from "../sessions/log.ts";
import { continuable, lastAnswer } from "../sessions/resume.ts";
import { pinModelOf, rootSessionOf } from "../sessions/siphon.ts";
import { pathOf, type Entry, type ToolEntry } from "../sessions/log.ts";
import { log } from "../utils/logger.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { hooks } from "../hooks/index.ts";
import { isAbort } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";
import { stopOutcomeOf, type StopOutcome } from "../core/stop.ts";
import { indexSessionEntries } from "../conversations/store.ts";
import type { SubAgentType, SubAgentMeta, SubAgentInfo, SubAgentCallerInfo, SubAgentDetail, SubAgentLifecycle } from "./types.ts";
import { sanitizeDisplayName } from "./registry.ts";
import { nodeOnline } from "../nodes/hub.ts";
import { nodeRecord } from "../nodes/store.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";
import { formatLocationForModel } from "../agent/preprocess.ts";
import { withChildRunContext } from "../utils/run-context.ts";
import { decideQuotaWait } from "../llm/quota/arm.ts";
import { quotaFor } from "../llm/quota/index.ts";

/**
 * The pins a caller asked for, on the session that is about to run.
 *
 * A sub-agent's session is a session: `effortOverride` and `contextOverride` are exactly the two
 * fields a chat's `/effort` and `/cap` write, and the resolver and the window reader already put
 * them above the tag and the scope. Writing them at creation is therefore the whole feature -- no
 * second precedence to keep in step, and a session-mode sub-agent keeps them across `send()` the
 * way a chat keeps its own.
 */
function applyPins(session: SessionData, pins?: { effort?: EffortLevel; contextCap?: number }): void {
  if (!pins) return;
  if (pins.effort) session.effortOverride = pins.effort;
  if (pins.contextCap !== undefined) session.contextOverride = pins.contextCap;
}

/**
 * Where a sub-agent's run reports itself while a human watches it. Absent for a parent-driven run:
 * `spawn` and the model's `send` stay non-streaming, so nothing about them changes.
 */
export interface SubAgentStream {
  onToken: TokenCallback;
  onToolUse?: ToolUseCallback;
  /** Called at the start of each tool execution so the card can render a spinner before the
   *  result lands. Same shape as the root path's onToolStart. */
  onToolStart?: ToolStartCallback;
  /** Called when the run absorbs a mid-run injection, so the output layer can seal the current
   *  bubble and open a fresh reply to the injected message -- same contract as the root path. */
  onTurnSwitch?: TurnSwitchCallback;
  reasoning?: ReasoningSink;
}

/**
 * The images of a send, in the shape the log stores and the prompt reads back.
 *
 * A sub-agent's turn used to name its attachments in prose and nowhere else, so a picture reached
 * the model as a filesystem path: `attachImages` rebuilds the image blocks from this field on
 * every request, and the `[Attachments]` block alone is text the model can only try to open with
 * a tool. Everything else stays listed rather than carried, which is the state of the sub-agent
 * media path -- docs/subagents.md.
 */
function imagesOf(attachments: Attachment[] | undefined): SessionAttachment[] {
  return (attachments ?? [])
    .filter((a) => a.type === "image" && a.path)
    .map((a) => ({ type: "image" as const, path: a.path!, ...(a.mimeType ? { mimeType: a.mimeType } : {}) }));
}

/**
 * Who a caller is, for the visibility rule. The workspace is the caller conversation's own key
 * (undefined = the default workspace), which is what a `workspace` agent is scoped to.
 */
export interface SubAgentCaller {
  sessionId: string;
  workspaceKey?: string;
  /** The folder the caller is filed in right now, stamped onto the agent's calls. docs/stats-page.md. */
  folderId?: string;
}

/**
 * Sub-agents are global on purpose: any chat can list and drive any of them, which is what makes
 * them useful as shared workers. Two narrower scopes exist:
 *
 * - `private`: the session that created it -- either because the owner asked, or because it is a
 *   one-shot with no name to share.
 * - `workspace`: any conversation of the workspace that created it. A shared worker inside one
 *   project, invisible to the others -- docs/subagent-visibility.md.
 */
function isReachableFrom(meta: SubAgentMeta, caller: SubAgentCaller): boolean {
  if (meta.visibility === "private") {
    // An unknown caller must not match an agent whose parent is also unknown.
    return caller.sessionId.length > 0 && meta.parentSessionId === caller.sessionId;
  }
  if (meta.visibility === "workspace") {
    // Compared as written, `undefined` included: an agent of the default workspace is reachable
    // from the default workspace alone, so the unkeyed case is a scope like any other and not a
    // wildcard. An unknown caller has no workspace, so it only ever matches the default one --
    // which is why the caller identity must be resolved, never guessed, at every entry point.
    return (meta.workspaceKey ?? undefined) === (caller.workspaceKey ?? undefined);
  }
  return true;
}

/**
 * The execution settings a caller may change as part of driving an existing sub-agent.
 *
 * They are applied under the same per-child queue as the run itself, so a configuration never
 * lands on a session mid-iteration: `send` either configures and runs, or does neither.
 * `scope` says how long it lasts -- this invocation, or the session's own settings from then on.
 *
 * docs/subagents.md, docs/provider-failures.md.
 */
export interface SubAgentExecution {
  /** A tag or a whole `provider/model` id, already judged by the caller's own door. */
  model?: string;
  effort?: EffortLevel;
  contextCap?: number;
  /** `forbid` runs the named model or stops: no other model may answer for it. */
  fallback?: "forbid";
  scope: "run" | "session";
}

/**
 * The session fields an execution touches, so a run-scoped one can put them back exactly.
 *
 * Restoring rather than recomputing: the run rewrites `modelOverride` with what it actually
 * resolved, and a stored `forbid` is a decision about this invocation, not about the agent.
 */
type ExecutionSnapshot = Pick<SessionData, "modelOverride" | "effortOverride" | "contextOverride" | "fallbackPolicy">;

function snapshotOf(session: SessionData): ExecutionSnapshot {
  return {
    modelOverride: session.modelOverride,
    effortOverride: session.effortOverride,
    contextOverride: session.contextOverride,
    fallbackPolicy: session.fallbackPolicy,
  };
}

function restoreExecution(session: SessionData, snapshot: ExecutionSnapshot): void {
  for (const [key, value] of Object.entries(snapshot) as Array<[keyof ExecutionSnapshot, unknown]>) {
    if (value === undefined) delete session[key];
    else (session as unknown as Record<string, unknown>)[key] = value;
  }
}

/**
 * Writes an execution onto the session the run is about to use.
 *
 * The fields are the ones a chat's `/model`, `/effort` and `/cap` already write, so the resolver
 * and the window reader apply them with no second precedence to keep in step. `fallback: forbid`
 * is the one new field, read by the bridge where the fallback is decided.
 */
function applyExecution(session: SessionData, execution: SubAgentExecution | undefined): void {
  if (!execution) return;
  if (execution.model) session.modelOverride = execution.model;
  if (execution.effort) session.effortOverride = execution.effort;
  if (execution.contextCap !== undefined) session.contextOverride = execution.contextCap;
  if (execution.fallback) session.fallbackPolicy = execution.fallback;
}

/**
 * How a sub-agent's last run ended, read from its own markers.
 *
 * `blocked` is a `failed` run the provider refused on a spent plan, which is the one failure that
 * clears itself with time rather than needing a decision. The class comes from the run's own
 * `run_end.failure` -- written by the bridge from `classifyProviderFailure` -- and never from the
 * owner's chat-level quota wait, which only ever exists for a conversation.
 */
function lifecycleOf(path: readonly Entry[], running: boolean): SubAgentLifecycle {
  let lastStart = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type === "run_start") {
      lastStart = i;
      break;
    }
  }
  if (lastStart < 0) return running ? "running" : "never-run";
  const end = path.slice(lastStart + 1).find((entry) => entry.type === "run_end");
  if (!end) return running ? "running" : "lost";
  if (end.type !== "run_end") return running ? "running" : "lost";
  if (end.reason === "done") return "complete";
  if (end.reason === "aborted") return "stopped";
  return end.failure === "quota_exhausted" ? "blocked" : "failed";
}

/** What a caller can do with an agent in this state, in the words of the tools that do it. */
function nextActionsOf(lifecycle: SubAgentLifecycle, running: boolean): string[] {
  if (running) return ["wait", "agents(action='inspect')"];
  switch (lifecycle) {
    case "never-run":
      return ["send(id, message)", "agents(action='kill')"];
    case "complete":
      return ["send(id, message)", "agents(action='reset')", "agents(action='kill')"];
    case "failed":
    case "lost":
    case "stopped":
      return ["send(id) to resume", "send(id, message)", "agents(action='reset')"];
    case "blocked":
      return ["wait for the quota", "send(id) to resume", "send(id, model=...) with fallback='forbid'"];
    default:
      return ["agents(action='inspect')"];
  }
}

interface ActiveSubAgentRun {
  controller: AbortController;
  done: Promise<void>;
}

export class SubAgentRunner {
  private activeRuns = new Map<string, Set<ActiveSubAgentRun>>();

  private sessionManager?: SessionManager;

  private mediaStore?: MediaStoreHook;

  private approvalHandler?: ToolApprovalHandler;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager: VoiceManager,
    private sttPipeline: SttPipeline,
    /** File-defined agents, handed to whichever backend runs the sub-agent. */
    private agentRegistry?: AgentRegistry,
    /**
     * The one browser. A `browser` agent's run drives the shared Chromium, so it takes the browser
     * queue and closes what it opened when it ends, whoever started it: a delegated task or the
     * owner continuing in the agent's own thread.
     */
    private browser?: BrowserSession,
  ) {}

  /** Pictures a run's tools produced (screenshots), read once by the caller that reports the run. */
  private producedAttachments = new Map<string, Attachment[]>();

  private takeAttachments(id: string): Attachment[] {
    const attachments = this.producedAttachments.get(id) ?? [];
    this.producedAttachments.delete(id);
    return attachments;
  }

  /**
   * Wires the shared cache so live sub-agent runs are reachable from the app channel
   * (history/peek) while in flight. Constructed before the SessionManager in index.ts,
   * hence the setter instead of a constructor argument.
   */
  /** Where a run's produced files are stored -- injected by the entry point, never owned here. */
  setMediaStore(store: MediaStoreHook | undefined): void {
    this.mediaStore = store;
  }

  /**
   * How a sub-agent's tool asks the owner, injected by the entry point like the media store.
   *
   * Without it an approval-required tool -- every tool of a node whose record says "ask first" --
   * was denied on sight: the manager answers deny when it has no handler, so the run reported
   * "denied by approval policy" and the owner was never shown anything. A sub-agent's request rides
   * the parent conversation's thread, which is the only screen that can answer it.
   */
  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  setSessionManager(manager: SessionManager): void {
    this.sessionManager = manager;
  }

  private async runTracked<T>(id: string, parentSignal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    let resolveDone!: () => void;
    const entry: ActiveSubAgentRun = { controller, done: new Promise<void>((resolve) => { resolveDone = resolve; }) };
    const runs = this.activeRuns.get(id) ?? new Set<ActiveSubAgentRun>();
    runs.add(entry);
    this.activeRuns.set(id, runs);
    try {
      // A run of its own: the frames the app channel sends for the child's thread, the marker the
      // recorder writes in its log and the lines the logger stamps all name this run, and two
      // sends to one child inside one parent run stay two runs (docs/run-grouping.md).
      return await withChildRunContext(() => task(controller.signal));
    } finally {
      parentSignal?.removeEventListener("abort", onParentAbort);
      runs.delete(entry);
      if (runs.size === 0) this.activeRuns.delete(id);
      resolveDone();
    }
  }

  private async stopTracked(id: string): Promise<void> {
    for (;;) {
      const runs = this.activeRuns.get(id);
      if (!runs || runs.size === 0) return;
      for (const run of runs) run.controller.abort();
      await Promise.allSettled([...runs].map((run) => run.done));
    }
  }

  /**
   * Whether a run of this sub-agent is in flight, whoever drives it. The run registry knows only
   * the roots it opened itself; a child the spawn tool started is tracked here and nowhere else.
   */
  isRunningSession(sessionId: string): boolean {
    return (this.activeRuns.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Stops the runs of this sub-agent, if any, and names what the stop found.
   *
   * The answer is derived from the runs themselves: a run of this sub-agent is active exactly
   * while its entry sits in `activeRuns`, and a stopped one carries an aborted controller until
   * it departs. A second stop during that wind-down therefore finds every controller already
   * aborted and answers "stopping" -- never a second "stopped" -- and a later run of the same
   * sub-agent gets a first stop of its own, because its controller is a new, un-aborted one.
   *
   * "stopped" is the claim that took the cycle, so the tracked sweep follows the work out:
   * `stopTracked` re-aborts in a loop, which is what catches a run added while the current ones
   * settle. A derivation run between two of its passes reads that new run honestly -- un-aborted
   * means there is still something to take.
   */
  stopSession(sessionId: string): StopOutcome {
    const runs = this.activeRuns.get(sessionId);
    const outcome = stopOutcomeOf([...(runs ?? [])].map((run) => run.controller));
    if (outcome === "stopped") void this.stopTracked(sessionId);
    return outcome;
  }

  /** Makes this conversation searchable from its log, which is where its turns actually are. */
  private async indexForSearch(id: string, session: SessionData): Promise<void> {
    indexSessionEntries(session, (await sessionLogOf(id)).entries());
  }

  /**
   * Writes the settings half. The manager owns it in production -- `index.ts` injects one before
   * anything can route a message -- and without it the settings still have to land where readers
   * look, which is the directory, not a flat file nothing reads any more.
   */
  private async persistSession(id: string, session: SessionData): Promise<void> {
    if (this.sessionManager) {
      this.sessionManager.adopt(session);
      await this.sessionManager.persist(id);
      return;
    }
    await writeMeta(id, metaOf(session, (await sessionLogOf(id)).leaf()));
  }

  /**
   * The caller's identity for the visibility rule, read from its own session rather than passed
   * in. Every entry point takes a session id and nothing else, so resolving here is what keeps a
   * caller from asserting a workspace it is not in -- and what makes a workspace switch apply to
   * reachability at once, since `session.workspace` is persisted on the switch.
   *
   * An unreadable or unknown session yields no workspace, which matches the default workspace: a
   * caller that cannot be placed sees the default scope, never every scope.
   */
  private async resolveCaller(callerSessionId: string): Promise<SubAgentCaller> {
    if (!callerSessionId) return { sessionId: "" };
    const session = await loadSession(callerSessionId);
    return {
      sessionId: callerSessionId,
      ...(session?.workspace ? { workspaceKey: session.workspace } : {}),
      ...(session?.folderId ? { folderId: session.folderId } : {}),
    };
  }

  /**
   * The level a sub-agent started by this caller would sit at: a run's own sub-agents are level 1.
   * Read off the sessions' own parent links, so no caller and no tool set has to count it.
   */
  private async depthUnder(parentSessionId: string): Promise<number> {
    let depth = 1;
    const seen = new Set<string>();
    for (let id: string | undefined = parentSessionId; id?.startsWith("subagent/") && !seen.has(id);) {
      seen.add(id);
      depth++;
      id = (await loadSession(id))?.meta?.parentSessionId;
    }
    return depth;
  }

  // An options object rather than positional arguments: this call already carried eleven of them,
  // and a caller or a test asserting on argument position silently binds to the wrong one as soon
  // as a parameter is inserted.
  async spawn(opts: {
    displayName: string;
    type: SubAgentType;
    mode: "run" | "session";
    task: string;
    workspaceDir?: string;
    /** Workspace of the run that asked for this spawn; inherited when the agent has none configured. */
    parentWorkspaceDir?: string;
    parentMessage: UnifiedMessage;
    existingIds: Set<string>;
    generateId: (name: string, existing: Set<string>) => string;
    parentSessionId: string;
    visibility: "global" | "workspace" | "private";
    signal?: AbortSignal;
    model?: string;
    /**
     * The reasoning and the context ceiling the caller asked for, over the agent's own pins. Set on
     * the sub-agent's session, which is a session like any other: `effortOverride` and
     * `contextOverride` are what a chat's `/effort` and `/cap` write, and they outrank the tag and
     * the scope exactly the same way (docs/subagents.md).
     */
    pins?: { effort?: EffortLevel; contextCap?: number };
    // Same per-agent queue as send(): without it, a send() issued while the spawn's first
    // run is still going races it on the session file (and the SDK session resume).
    enqueue?: <T>(id: string, task: () => Promise<T>) => Promise<T>;
    /** The `spawn` tool call that produced this, if any. Lets a live card target the tool-start card. */
    toolCallId?: string;
    /**
     * Called once the sub-agent session exists (id known) and before its run starts.
     * Lets the app channel open a stream on the sub-agent's own thread so a human
     * opening it mid-run sees tokens, not just the prompt. Absent for channels that
     * have no live view (cron, CLI).
     */
    streamProvider?: (id: string) => SubAgentStream | undefined;
  }): Promise<{ id: string; result: string; attachments: Attachment[] }> {
    const { type, mode, task, workspaceDir, parentWorkspaceDir, parentMessage, existingIds, generateId, parentSessionId, visibility, signal, model, pins, enqueue, toolCallId, streamProvider } = opts;
    // Sanitized here rather than only inside SubAgentRegistry.generateId: that function arrives as
    // a callback, so this is the one place every caller passes through, and it keeps the stored
    // displayName equal to the name inside the id.
    const displayName = sanitizeDisplayName(opts.displayName);

    // Both spawn and delegate_browser_task arrive here, so this is where nesting is bounded, whatever
    // tools a role happens to hold.
    const depth = await this.depthUnder(parentSessionId);
    if (depth > MAX_SUBAGENT_DEPTH) {
      void log("warn", "sub-agent refused: nested too deep", { parentSessionId, type, depth });
      return {
        id: "",
        result: `Error: this would start a level-${depth} sub-agent, and sub-agents nest at most ${MAX_SUBAGENT_DEPTH} deep. Do this step with your own tools, or return what you have to your caller and say what is left.`,
        attachments: [],
      };
    }

    const resolved = this.resolveWorkspace(type, workspaceDir, parentWorkspaceDir);
    if ("error" in resolved) return { id: "", result: `Error: ${resolved.error}`, attachments: [] };
    // A node agent whose machine is away answers here, before a session or a log entry exists:
    // the spawn itself says so. docs/remote-nodes.md.
    const offline = this.offlineNodeError(type, resolved.key);
    if (offline) return { id: "", result: offline, attachments: [] };

    if (mode === "run") {
      return this.runOneShot(displayName, type, task, resolved.dir, resolved.key, parentMessage, parentSessionId, signal, model, toolCallId, streamProvider, enqueue, pins);
    }

    const id = generateId(displayName, existingIds);
    // The scope of a workspace-visible agent is the conversation that spawned it, not the
    // workspace the agent was pinned to run in: `agents.<name>.workspace` moves the filesystem,
    // not the roster the orchestrator sees.
    const spawnedFrom = await this.resolveCaller(parentSessionId);
    const meta: SubAgentMeta = {
      displayName,
      type,
      workspaceDir: resolved.dir,
      parentSessionId,
      visibility,
      ...(visibility === "workspace" && spawnedFrom.workspaceKey ? { workspaceKey: spawnedFrom.workspaceKey } : {}),
      createdAt: new Date().toISOString(),
    };

    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, meta, resolved.key);
    applyPins(session, pins);
    session.invokedBy = parentSessionId;
    session.parentFolderId = spawnedFrom.folderId;
    recordSubAgentCaller(session, parentSessionId);
    // Write the user turn to the log before the run starts: a crash before the first bridge
    // turn must still show the question that was asked.
    const entryLog = await sessionLogOf(id);
    entryLog.append<UserEntry>({
      type: "user",
      prompt: true,
      text: task,
    });
    return this.runTracked(id, signal, async (trackedSignal) => {
      await entryLog.flush();
      await this.persistSession(id, session);
      await this.indexForSearch(id, session);

      hooks.emit("subagent:spawn", { id, displayName, type, mode, parentSessionId, action: "spawn", task, ...(toolCallId ? { toolCallId } : {}) });
      const stream = streamProvider?.(id);
      const run = () => this.executeRun(session, type, resolved.dir, parentMessage, trackedSignal, model, stream, task);
      let result: string;
      try {
        result = await (enqueue ? enqueue(id, run) : run());
      } catch (err) {
        // Kept, and named to the caller, like a one-shot: its work so far is the point. Discarding
        // it (the caller had no id to name it by) is how the veille of 2026-09-29 redid a volet from
        // nothing after its model timed out 24 tool calls in (docs/continue.md).
        throw withSubagentId(err, id);
      }
      hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId });
      return { id, result, attachments: this.takeAttachments(id) };
    });
  }

  /**
   * The refusal a `base: node` agent gets while its machine is not usable: no run starts, and the
   * message names the node and what to do. A disabled node says so; an offline one says when it
   * was last seen. An agent whose node record is gone entirely (revoked, file left behind) says
   * that instead, so the fix is the right one.
   */
  private offlineNodeError(type: SubAgentType, layer?: string): string | undefined {
    const meta = this.agentRegistry?.get(type, layer)?.meta;
    if (meta?.base !== "node" || !meta.node) return undefined;
    const record = nodeRecord(meta.node);
    if (!record) {
      return `Error: the node this agent belongs to (${meta.node}) is not paired any more. Remove the agent file, or pair the machine again.`;
    }
    if (record.disabled === true) {
      return `Error: node "${record.name}" is disabled. Turn it back on in Settings > Nodes to let its agent run.`;
    }
    if (nodeOnline(meta.node)) return undefined;
    const seen = record.lastSeenAt ? `, last seen ${record.lastSeenAt}` : ", never seen";
    return `Error: node "${record.name}" is offline${seen}. It reconnects on its own; try again once it is back.`;
  }

  /**
   * Where this sub-agent runs and which workspace it belongs to. The agent's configured
   * workspace wins over the parent's (that is what pinning an agent to a project means), and
   * an explicit `workspaceDir` may only narrow inside that base — it is written by the agent,
   * so letting it point anywhere would make the boundary decorative.
   * See docs/multi-workspace.md.
   */
  private resolveWorkspace(
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentWorkspaceDir: string | undefined,
  ): { dir: string | undefined; key: string | undefined } | { error: string } {
    const configuredKey = resolveAgentWorkspace(this.config, type);
    if (configuredKey && !this.config.workspaces?.[configuredKey]) {
      return { error: `agents.${type}.workspace points at "${configuredKey}", which is not in config.workspaces.` };
    }
    const base = configuredKey ? resolveWorkspaceKey(this.config, configuredKey) : parentWorkspaceDir;
    if (workspaceDir && base) {
      const target = resolve(workspaceDir);
      if (target !== base && !target.startsWith(base + "/")) {
        return { error: `workspaceDir "${workspaceDir}" must be within the agent's workspace (${base}).` };
      }
    }
    return {
      dir: workspaceDir ?? base,
      key: configuredKey ?? workspaceKeyForDir(this.config, parentWorkspaceDir),
    };
  }

  /**
   * Drives an existing sub-agent. `message` undefined resumes it instead: no turn is added, the run
   * picks up where its last one stopped (docs/continue.md), and one that had in fact finished
   * answers with what it said then, without running again.
   */
  async send(
    id: string,
    message: string | undefined,
    attachments: Attachment[] | undefined,
    parentMessage: UnifiedMessage,
    registry: { enqueue: <T>(id: string, task: () => Promise<T>) => Promise<T>; isRunning: (id: string) => boolean },
    callerSessionId: string,
    signal?: AbortSignal,
    // Appended last, like the reasoning sink on AgentBackend: a caller asserting on argument
    // position must not rebind when this grows. Present only when a human is watching (the app
    // opened the sub-agent as a chat); a parent-driven send passes none and stays non-streaming,
    // which is what keeps `spawn`'s contract unchanged.
    stream?: SubAgentStream,
    // The `send` tool call this run belongs to, when a model drove it. Present only on that path:
    // a human typing in the sub-agent's own thread has the child thread as its UI and no parent
    // card to annotate, so the lifecycle events below would target a card that does not exist.
    toolCallId?: string,
    streamProvider?: (id: string) => SubAgentStream | undefined,
    /**
     * Model, effort, ceiling and fallback policy to apply as part of this call -- docs/subagents.md.
     *
     * Applied under the same queue entry as the run itself, so nothing lands on a live iteration.
     * A `run`-scoped execution is put back in the finally, which is what keeps a one-off "stay on
     * this account" from becoming the agent's permanent setting.
     */
    execution?: SubAgentExecution,
  ): Promise<string> {
    id = await this.canonicalId(id, callerSessionId);
    return this.runTracked(id, signal, (trackedSignal) => registry.enqueue(id, async () => {
      const session = await loadSession(id);
      if (!session || !session.meta) {
        return `Error: sub-agent ${id} not found.`;
      }
      const caller = await this.resolveCaller(callerSessionId);
      if (!isReachableFrom(session.meta, caller)) {
        return `Error: sub-agent ${id} not found.`;
      }
      const entryLog = await sessionLogOf(id);
      const before = execution?.scope === "run" ? snapshotOf(session) : undefined;
      applyExecution(session, execution);
      if (message === undefined) {
        return this.resume(id, session, entryLog, parentMessage, callerSessionId, caller.folderId, trackedSignal, stream, toolCallId, streamProvider, before);
      }

      const userContent = this.buildUserContent(message, attachments, parentMessage.location);
      const images = imagesOf(attachments);
      // Write user turn to the log. A crash before the first bridge turn must still show the question.
      // A human app send owns the child-thread bubble, so its chat.send id must be reused by the
      // persisted entry. Test and non-app callers can reuse a message id, in which case the log
      // keeps its own identity rather than creating a duplicate id in the tree.
      const sourceId = toolCallId === undefined && !entryLog.get(parentMessage.id) ? parentMessage.id : undefined;
      entryLog.append<UserEntry>({
        type: "user",
        prompt: true,
        text: userContent,
        // The turn owns its pictures the same way a human's does: this is what the prompt reads
        // back on every request, so the image stays visible past the turn it arrived on.
        ...(images.length > 0 ? { attachments: images } : {}),
        ...(parentMessage.location ? { location: parentMessage.location } : {}),
        // When a model drives the send, record where it came from.
        ...(toolCallId ? { from: { sessionId: callerSessionId, label: "send" } } : {}),
      }, sourceId);
      await entryLog.flush();

      // A global agent can be driven from a chat other than its creator, so this run's tokens
      // belong to whoever sent this message, not to whoever spawned the agent.
      session.invokedBy = callerSessionId;
      session.parentFolderId = caller.folderId;
      // Who this agent is working for, which neither the creator nor the last driver answers: a
      // global agent serves several conversations and the owner needs the list to hand an answer
      // back to one of them.
      recordSubAgentCaller(session, callerSessionId);
      // Same lifecycle as `spawn`, so a `send` card gets the same statuses, the same persisted
      // state and the same roster pushes. `action` is the only difference on the wire.
      const tracked = toolCallId !== undefined;
      if (tracked) {
        hooks.emit("subagent:spawn", {
          id,
          displayName: session.meta.displayName || id.slice("subagent/".length),
          type: session.meta.type,
          mode: "session",
          parentSessionId: callerSessionId,
          toolCallId,
          action: "send",
          task: userContent,
        });
      }
      // Resolved after the event, not before: the app channel creates the sub-agent's streamer
      // while handling the spawn event, so asking any earlier always yields undefined.
      const runStream = stream ?? (tracked ? streamProvider?.(id) : undefined);
      try {
        const result = await this.executeRunWithSession(session, session.meta.type, session.meta.workspaceDir, parentMessage, trackedSignal, undefined, runStream, undefined, userContent, images);
        if (tracked) hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId: callerSessionId });
        return result;
      } catch (err) {
        // executeRunWithSession already reported this to the session's spawner; a send can come
        // from another conversation, and that one owns the card being watched here.
        if (tracked && callerSessionId !== (session.meta.parentSessionId ?? "")) {
          if (isAbort(err, trackedSignal)) hooks.emit("subagent:aborted", { id, parentSessionId: callerSessionId });
          else hooks.emit("subagent:error", { id, error: err, parentSessionId: callerSessionId });
        }
        // A spent plan on the child's provider arms the child's own wait, which the channel's one
        // tick will fire -- docs/quota-retry.md.
        if (!isAbort(err, trackedSignal)) await this.armQuotaWait(session, err);
        throw err;
      } finally {
        // In the finally, not after: a failed run used to lose the question too, and the thread
        // came back from disk with no trace that anything had been sent.
        if (before) restoreExecution(session, before);
        await this.persistSession(id, session);
        await this.indexForSearch(id, session);
      }
    }));
  }

  /**
   * Arms the child's own quota wait when its run died on a spent plan.
   *
   * The app adapter owns the tick, but it cannot know that a sub-agent failed: the error surfaces
   * here, in the queue entry that drove the run. So the runner writes the wait on the child's own
   * session, and the one tick finds it there -- docs/quota-retry.md. A child whose session never
   * turned the switch on arms nothing, exactly like a conversation.
   */
  private async armQuotaWait(session: SessionData, err: unknown): Promise<void> {
    // The switch is the conversation's, and a sub-agent is that conversation's work -- so the
    // child reads it at the root instead of looking for a toggle of its own that nothing ever
    // sets. Reading the child's own field made a whole delegated chain silently exempt from a
    // switch the owner had visibly turned on (2026-11-01).
    const root = await rootSessionOf(session, loadSession);
    const setting = root.id === session.id ? session : root;
    if (setting.quotaRetry?.enabled !== true) return;
    const decision = await decideQuotaWait({
      readQuota: (provider) => quotaFor(this.config, provider, { force: true }),
      err,
      switchOff: false,
      // Each session keeps its own count and its own wait: a child resuming is its own run, and the
      // eight-attempt ceiling has always been per session (docs/quota-retry.md).
      previousAttempts: session.quotaRetry?.pending?.attempts ?? 0,
    });
    if (!decision.wait) return;
    session.quotaRetry = { enabled: true, pending: decision.wait };
    await log("info", "sub-agent quota wait armed", {
      id: session.id,
      ...(root.id === session.id ? {} : { switchFrom: root.id }),
      at: decision.wait.at,
      attempts: decision.wait.attempts,
      windows: decision.wait.windows,
    });
  }

  /**
   * Resumes a sub-agent whose quota wait came due, whoever is ticking.
   *
   * No caller, no reachability check, and no new turn: the wait was armed by the run that died, on
   * the child's own session, and the only thing left is to pick the conversation back up
   * (docs/quota-retry.md). A finished child answers with what it already said instead of running
   * again -- `continuable` decides, exactly as it does behind the Continue button.
   */
  async resumeArmedWait(id: string, registry: { enqueue: <T>(id: string, task: () => Promise<T>) => Promise<T>; isRunning: (id: string) => boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.isRunningSession(id) || registry.isRunning(id)) return { ok: false, reason: "A run is already going here." };
    const session = await loadSession(id);
    if (!session?.meta) return { ok: false, reason: `Sub-agent ${id} not found.` };
    const entryLog = await sessionLogOf(id);
    if (!continuable(entryLog.entries(), entryLog.leaf()).ok) return { ok: false, reason: "Nothing to continue: the last run finished." };
    const resumed = this.resume(
      id, session, entryLog, this.waitMessage(session), "", session.parentFolderId, new AbortController().signal,
      undefined, undefined, undefined, undefined,
    );
    // Never awaited by the tick: a resumed run is minutes long, and a tick that blocked on it would
    // stop firing every other wait.
    void this.runTracked(id, undefined, async () => {
      try {
        await registry.enqueue(id, async () => { await resumed; });
      } catch (err) {
        void log("warn", "sub-agent quota retry failed", { id, error: String(err) });
      }
    });
    return { ok: true };
  }

  /** The message a headless resume carries: no text, no attachment, the session's own identity. */
  private waitMessage(session: SessionData): UnifiedMessage {
    return {
      id: `quota-wait-${crypto.randomUUID()}`,
      platform: session.platform as UnifiedMessage["platform"],
      chatType: session.chatType as UnifiedMessage["chatType"],
      chatId: session.invokedBy ?? session.id,
      userId: "",
      text: "",
      attachments: [],
      isForwarded: false,
      resume: true,
      raw: { type: "quota.retry" },
    };
  }

  /**
   * Undo a session spawn whose very first run died: the agent was never usable, and its id never
   * left the runner. Failing quietly here is deliberate, the caller is already carrying the run's
   * own error and a stuck file is the lesser fault to report.
   */
  async kill(id: string, callerSessionId: string): Promise<string> {
    // deleteSession takes any session id, so without this guard a kill could be pointed at
    // a chat session and delete a conversation.
    const session = await loadSession(id);
    if (!id.startsWith("subagent/") || !session?.meta || !isReachableFrom(session.meta, await this.resolveCaller(callerSessionId))) {
      return `Error: sub-agent ${id} not found.`;
    }
    await this.stopTracked(id);
    if (this.sessionManager) await this.sessionManager.deleteSession(id);
    else await deleteStoredSession(id);
    // Cache parity: the adopted session must not survive the kill. The manager delete also drains
    // queued writes before removing the directory, so a late autosave cannot resurrect the agent.
    const parentSessionId = session.meta.parentSessionId || callerSessionId;
    hooks.emit("subagent:killed", {
      id,
      parentSessionId,
      ...(parentSessionId !== callerSessionId ? { callerSessionId } : {}),
    });
    return `Sub-agent ${id} deleted.`;
  }

  async reset(id: string, callerSessionId: string): Promise<string> {
    const session = await loadSession(id);
    if (!session || !session.meta || !isReachableFrom(session.meta, await this.resolveCaller(callerSessionId))) {
      return `Error: sub-agent ${id} not found.`;
    }
    await this.stopTracked(id);
    const current = this.sessionManager ? await this.sessionManager.peek(id) ?? session : session;
    await this.persistSession(id, current);
    // Through the manager when there is one: it owns the open log, and a reset that leaves that log
    // cached hands the fresh conversation the old leaf and a handle to a file that has moved.
    if (this.sessionManager) await this.sessionManager.archiveConversation(id);
    else await archiveSession(id);
    // The workspace survives a reset like the rest of the identity: a sub-agent pinned to a
    // project must not silently come back in the default one.
    const fresh = this.createSession(id, current.platform, current.chatType, current.meta, current.workspace);
    await this.persistSession(id, fresh);
    // The cache must hold the fresh session, not the archived one.
    const parentSessionId = session.meta.parentSessionId || callerSessionId;
    hooks.emit("subagent:reset", {
      id,
      parentSessionId,
      ...(parentSessionId !== callerSessionId ? { callerSessionId } : {}),
    });
    return `Sub-agent ${id} session reset. Workspace preserved.`;
  }

  /**
   * The conversations this sub-agent has worked for, newest first, as seen by `callerSessionId`.
   *
   * A caller who cannot reach the agent gets nothing: the roster rule decides who may read it, the
   * same way it decides who may drive it. Each entry says whether it is still reachable rather than
   * being dropped when it is not -- a caller whose conversation was deleted, or which left the
   * workspace, is exactly the thing worth showing as unavailable instead of silently missing.
   */
  async callersOf(id: string, callerSessionId: string): Promise<SubAgentCallerInfo[] | undefined> {
    const session = await loadSession(id);
    if (!session?.meta) return undefined;
    const caller = await this.resolveCaller(callerSessionId);
    if (!isReachableFrom(session.meta, caller)) return undefined;
    const out: SubAgentCallerInfo[] = [];
    for (const entry of session.callers ?? []) {
      const target = await loadSession(entry.sessionId);
      out.push({
        sessionId: entry.sessionId,
        creator: entry.creator,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
        runs: entry.runs,
        ...(target ? {} : { unreachable: "gone" as const }),
        ...(target?.title ? { title: target.title } : {}),
      });
    }
    return out;
  }

  /**
   * The id a caller meant. Models copy ids loosely: told `subagent/wttj-4f2a`, deepseek-v4.1-flash
   * wrote `wttj-4f2a` and `wttj` as often as the real thing (2026-09-28). The prefix is added, and a
   * bare display name resolves when exactly one sub-agent this caller can reach carries it.
   */
  private async canonicalId(id: string, callerSessionId: string): Promise<string> {
    const trimmed = id.trim();
    if (trimmed.startsWith("subagent/")) return trimmed;
    const prefixed = `subagent/${trimmed}`;
    if (await loadSession(prefixed)) return prefixed;
    const named = (await this.list({ isRunning: () => false }, callerSessionId)).filter((a) => a.displayName === trimmed);
    return named.length === 1 ? named[0]!.id : prefixed;
  }

  /**
   * A sub-agent picks up where its last run stopped, adding no turn -- docs/continue.md. The same
   * lifecycle as a `send`, so the parent's card shows it working. One whose last run had in fact
   * finished is not run again: its answer is returned as it stands.
   */
  private async resume(
    id: string,
    session: SessionData,
    entryLog: SessionLog,
    parentMessage: UnifiedMessage,
    callerSessionId: string,
    folderId: string | undefined,
    signal: AbortSignal,
    stream: SubAgentStream | undefined,
    toolCallId: string | undefined,
    streamProvider: ((id: string) => SubAgentStream | undefined) | undefined,
    /** What the session's execution fields were before a `run`-scoped `send`, put back before the
     *  write: the run rewrites `modelOverride` with what it resolved, and persisting that would
     *  make a one-off account choice the agent's permanent one. */
    executionBefore?: ExecutionSnapshot,
  ): Promise<string> {
    session.invokedBy = callerSessionId;
    session.parentFolderId = folderId;
    recordSubAgentCaller(session, callerSessionId);
    const meta = session.meta!;
    const tracked = toolCallId !== undefined;
    const state = continuable(entryLog.entries(), entryLog.leaf());
    if (tracked) {
      hooks.emit("subagent:spawn", {
        id,
        displayName: meta.displayName || id.slice("subagent/".length),
        type: meta.type,
        mode: "session",
        parentSessionId: callerSessionId,
        toolCallId,
        action: "send",
        task: "Continue where you stopped.",
      });
    }
    if (!state.ok) {
      const answer = lastAnswer(entryLog.entries(), entryLog.leaf());
      const result = answer ?? `Error: sub-agent ${id} has nothing to resume. ${state.reason}`;
      if (tracked) {
        if (answer) hooks.emit("subagent:complete", { id, resultLength: answer.length, parentSessionId: callerSessionId });
        else hooks.emit("subagent:error", { id, error: new Error(result), parentSessionId: callerSessionId });
      }
      return result;
    }
    const runStream = stream ?? (tracked ? streamProvider?.(id) : undefined);
    try {
      const result = await this.executeRunWithSession(session, meta.type, meta.workspaceDir, parentMessage, signal, undefined, runStream, undefined, state.lastUserText, undefined, true);
      if (tracked) hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId: callerSessionId });
      return result;
    } catch (err) {
      if (tracked && callerSessionId !== (meta.parentSessionId ?? "")) {
        if (isAbort(err, signal)) hooks.emit("subagent:aborted", { id, parentSessionId: callerSessionId });
        else hooks.emit("subagent:error", { id, error: err, parentSessionId: callerSessionId });
      }
      if (!isAbort(err, signal)) await this.armQuotaWait(session, err);
      throw err;
    } finally {
      if (executionBefore) restoreExecution(session, executionBefore);
      await this.persistSession(id, session);
      await this.indexForSearch(id, session);
    }
  }

  async list(registry: { isRunning: (id: string) => boolean }, callerSessionId: string): Promise<SubAgentInfo[]> {
    const out: SubAgentInfo[] = [];
    // Resolved once for the whole scan rather than per entry: the caller does not change between
    // two sub-agents, and a read per sub-agent would make listing quadratic in disk reads.
    const caller = await this.resolveCaller(callerSessionId);
    try {
      // The shared walk, not a glob: a sub-agent is a directory since the storage switch, and
      // looking for `*.json` here listed none of them at all.
      for (const id of subagentSessionIdsSync()) {
        // The settings half first: who may reach it and the numbers a row needs are in meta.json.
        // Opening every sub-agent's log to answer a roster -- which the app asks for at every run
        // end -- read hundreds of megabytes each time. A session with no meta.json (the old flat
        // file) is loaded as it was.
        const stored = await readMeta(id).catch(() => null);
        const session = stored?.meta ? undefined : await loadSession(id);
        const meta = stored?.meta ?? session?.meta;
        if (!meta) continue;
        if (!isReachableFrom(meta, caller)) continue;
        const running = registry.isRunning(id);
        // A running one is counted off its log, which moves before the meta is next written.
        const messageCount = !running && stored?.promptCount !== undefined
          ? stored.promptCount
          : (await sessionLogOf(id)).entries().filter(e => e.prompt).length;
        const model = stored ? stored.modelOverride : session?.modelOverride;
        out.push({
          id,
          displayName: meta.displayName,
          type: meta.type,
          messageCount,
          status: running ? "running" : "idle",
          visibility: meta.visibility,
          ...(meta.workspaceKey ? { workspaceKey: meta.workspaceKey } : {}),
          ...(meta.workspaceDir ? { workspaceDir: meta.workspaceDir } : {}),
          ...(model ? { model } : {}),
          createdAt: meta.createdAt,
        });
      }
    } catch {
      // no subagents dir
    }
    return out;
  }

  /**
   * One agent in detail: its roster row, how its last run ended, and what a caller may do next.
   *
   * The lifecycle is read off the log rather than kept anywhere, because the log is the only record
   * of what a run did -- `agents(action='list')` answers "how many, still running", and a caller
   * choosing between waiting, resuming and giving up needs the run's ending and its last tool.
   * Reachability is the same rule as the roster: an agent this caller cannot drive is not described.
   */
  async inspect(id: string, registry: { isRunning: (id: string) => boolean }, callerSessionId: string): Promise<SubAgentDetail | undefined> {
    const canonical = await this.canonicalId(id, callerSessionId);
    const caller = await this.resolveCaller(callerSessionId);
    const stored = await readMeta(canonical).catch(() => null);
    const session = stored?.meta ? undefined : await loadSession(canonical);
    const meta = stored?.meta ?? session?.meta;
    if (!meta || !isReachableFrom(meta, caller)) return undefined;

    const log = await sessionLogOf(canonical);
    const entries = log.entries();
    const leaf = log.leaf();
    const path = pathOf(entries, leaf);
    const running = registry.isRunning(canonical) || this.isRunningSession(canonical);
    const lastToolEntry = [...path].reverse().find((entry): entry is ToolEntry => entry.type === "tool");
    const quota = (stored ? stored.quotaRetry : session?.quotaRetry)?.pending;
    // A failed run carries its own reason now, so the roster reads the run rather than inferring
    // from the owner's chat-level wait -- which a sub-agent never has.
    const lifecycle = lifecycleOf(path, running);
    const model = stored ? stored.modelOverride : session?.modelOverride;
    const fallbackPolicy = stored ? stored.fallbackPolicy : session?.fallbackPolicy;
    const picks = path.filter((entry) => entry.type === "user").length;

    return {
      id: canonical,
      displayName: meta.displayName,
      type: meta.type,
      messageCount: picks,
      status: running ? "running" : "idle",
      visibility: meta.visibility,
      ...(meta.workspaceKey ? { workspaceKey: meta.workspaceKey } : {}),
      ...(meta.workspaceDir ? { workspaceDir: meta.workspaceDir } : {}),
      ...(model ? { model } : {}),
      createdAt: meta.createdAt,
      lifecycle,
      ...(fallbackPolicy ? { fallbackPolicy } : {}),
      ...(lastToolEntry ? { lastTool: { name: lastToolEntry.name, ok: lastToolEntry.ok } } : {}),
      ...(quota ? { quotaRetry: { at: quota.at, attempts: quota.attempts, windows: quota.windows } } : {}),
      resumable: lifecycle !== "running" && continuable(entries, leaf).ok,
      nextActions: nextActionsOf(lifecycle, running),
    };
  }

  /**
   * Removes the private sub-agents a conversation owns. Called when the app deletes the
   * conversation: a private agent is reachable from its parent alone, so a deleted parent leaves
   * it an unreachable orphan. Global agents survive on purpose -- they are shared workers another
   * conversation may still drive, and the roster of any conversation still lists them for a
   * deliberate kill. A running agent is skipped: its run would write its settings back.
   */
  async deleteChildrenOf(parentSessionId: string, registry: { isRunning: (id: string) => boolean }): Promise<number> {
    let removed = 0;
    try {
      for (const id of subagentSessionIdsSync()) {
        const session = await loadSession(id);
        if (!session?.meta) continue;
        if (session.meta.visibility !== "private") continue;
        if (session.meta.parentSessionId !== parentSessionId) continue;
        if (registry.isRunning(id) || this.activeRuns.has(id)) continue;
        if (this.sessionManager) await this.sessionManager.deleteSession(id);
        else await deleteStoredSession(id);
        removed += 1;
      }
    } catch {
      // no subagents dir
    }
    return removed;
  }

  private async runOneShot(
    displayName: string,
    type: SubAgentType,
    task: string,
    workspaceDir: string | undefined,
    workspaceKey: string | undefined,
    parentMessage: UnifiedMessage,
    parentSessionId: string,
    signal?: AbortSignal,
    model?: string,
    toolCallId?: string,
    streamProvider?: (id: string) => SubAgentStream | undefined,
    /**
     * The same per-agent queue the session path uses. A one-shot skipped it, which cost two
     * things: `registry.isRunning` reads exactly this map, so a one-shot showed as "idle" in the
     * roster for its whole life; and `send()` serialises on it, so a send arriving mid-run raced
     * the one-shot on the session file.
     */
    enqueue?: <T>(id: string, task: () => Promise<T>) => Promise<T>,
    /** The caller's effort and ceiling, set on the session this one-shot creates. */
    pins?: { effort?: EffortLevel; contextCap?: number },
  ): Promise<{ id: string; result: string; attachments: Attachment[] }> {
    const id = `subagent/run-${crypto.randomUUID()}`;
    // A one-shot keeps its session now: the app lists it as a temporary sub-agent and can open it
    // like a chat, so deleting it would make the roster promise something it cannot deliver. It
    // stays private -- an unnamed agent must not leak past the conversation that asked for it --
    // and dies with its parent conversation (deleteChildrenOf).
    const spawnedFrom = await this.resolveCaller(parentSessionId);
    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, {
      displayName: displayName || id.slice("subagent/".length),
      type,
      workspaceDir,
      parentSessionId,
      visibility: "private",
      createdAt: new Date().toISOString(),
    }, workspaceKey);
    applyPins(session, pins);
    session.invokedBy = parentSessionId;
    session.parentFolderId = spawnedFrom.folderId;
    recordSubAgentCaller(session, parentSessionId);
    // Write the user turn to the log before the run starts: a crash before the first bridge
    // turn must still show the question that was asked.
    const entryLog = await sessionLogOf(id);
    entryLog.append<UserEntry>({
      type: "user",
      prompt: true,
      text: task,
    });
    return this.runTracked(id, signal, async (trackedSignal) => {
      await entryLog.flush();
      await this.persistSession(id, session);
      await this.indexForSearch(id, session);

      hooks.emit("subagent:spawn", { id, displayName: displayName || id.slice("subagent/".length), type, mode: "run", parentSessionId, action: "spawn", task, ...(toolCallId ? { toolCallId } : {}) });
      const stream = streamProvider?.(id);
      try {
        const execute = () => this.executeRunWithSession(session, type, workspaceDir, parentMessage, trackedSignal, model, stream, undefined, task);
        const result = await (enqueue ? enqueue(id, execute) : execute());
        hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId });
        return { id, result, attachments: this.takeAttachments(id) };
      } catch (err) {
        // A one-shot keeps its session, work included: the caller is told which one it was, so it
        // can resume it instead of starting the same task again from nothing (docs/continue.md).
        throw withSubagentId(err, id);
      } finally {
        await this.indexForSearch(id, session);
        // The run wrote its turns into the session in memory; this is the moment they land on disk.
        await this.persistSession(id, session);
      }
    });
  }

  private async executeRun(
    session: SessionData,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    signal?: AbortSignal,
    model?: string,
    stream?: SubAgentStream,
    userText?: string,
  ): Promise<string> {
    // The caller's own session object, never a reload: `invokedBy` and `parentFolderId` are runtime
    // state stamped at the drive, and a fresh copy from disk would drop exactly the two fields the
    // run's filing and its bill are read from.
    const id = session.id;
    try {
      return await this.executeRunWithSession(session, type, workspaceDir, parentMessage, signal, model, stream, undefined, userText);
    } finally {
      // Persist the first run so a session-mode sub-agent remembers its own answer; without this
      // the next send() reloads a history containing the task but not the reply.
      await this.persistSession(id, session);
      await this.indexForSearch(id, session);
    }
  }

  private async executeRunWithSession(
    session: SessionData,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    signal?: AbortSignal,
    model?: string,
    stream?: SubAgentStream,
    messageId?: string,
    /** User text for the subMessage. The runner already wrote the UserEntry to the log. */
    userText?: string,
    /** Images of that turn, already on the entry: the run resolves its model knowing it has them. */
    images?: SessionAttachment[],
    /** Continue the session as it stands, adding no turn (docs/continue.md). */
    resume?: boolean,
  ): Promise<string> {
    // Its real level, for the run tree and the tools: a browser task under a sub-agent is level 2.
    const depth = session.meta?.parentSessionId ? await this.depthUnder(session.meta.parentSessionId) : 1;
    // The spawn path already checked; this is the one `send` and `resume` pass through.
    const offline = this.offlineNodeError(type, session.workspace);
    if (offline) return offline;
    // Adopt the session into the shared cache before the run: the app channel's history/peek
    // then sees the live object (pre-pushed task, streaming tokens in memory) instead of the
    // file that only contains the pre-pushed task. The manager persists it on its own ticks.
    this.sessionManager?.adopt(session);
    // The same chain every other run resolves, and only once: the engine below is picked from it
    // and the backend receives it as its override, so nothing resolves a second time. Reading the
    // config entry alone was the bug: an agent file's `model:` never reached a spawn, and a model
    // the provider refuses had no step to fall back to. Explicit spawn model sits where a chat's
    // pick sits, above the agent's own pin; a session sub-agent then sticks to it across send()
    // via the modelOverride recorded on the first run.
    const fileModel = this.agentRegistry?.get(type, session.workspace)?.meta.model;
    const pick = model ?? session.modelOverride;
    // Siphon: the root conversation decided this whole tree runs one model -- docs/siphon.md. It is
    // read from the root at every run, never copied onto the child, so a change (or a removal)
    // reaches the next run of every level. `forcedModel` is the step that skips the chain, which is
    // what makes it outrank the explicit spawn `model` sitting just below it.
    const pin = pinModelOf(await rootSessionOf(session, loadSession));
    const request: RunModelRequest = {
      agent: type,
      ...(fileModel ? { fileModel } : {}),
      // A pick keeps its own step (it can be a tag, with a route to walk); only Siphon skips the
      // chain outright, because pinning to one model is exactly the promise that nothing else runs.
      ...(pin ? { forcedModel: pin } : pick ? { sessionModel: pick } : {}),
      // The sub-agent's own pins, which nothing read before: a `/effort` typed in a sub-agent's
      // thread was stored and then ignored by its next run, and a spawn's `effort` would have
      // joined it. A chat's pins reach the resolver through these two fields, so these are the two.
      ...(session.effortOverride ? { sessionEffort: session.effortOverride } : {}),
    };
    let resolved: RunModel;
    try {
      resolved = resolveRunModel(this.config, request, availabilityWorld());
    } catch (err) {
      // A model recorded on the first run goes stale exactly like a chat's pick, and a send() must
      // not die of it. An explicit spawn model is the caller's own, so that one still throws.
      if (model || !pick) throw err;
      void log("warn", "sub-agent model no longer resolves; falling back to the agent chain", {
        id: session.id,
        model: pick,
        error: String(err),
      });
      delete session.modelOverride;
      resolved = resolveRunModel(this.config, { ...request, sessionModel: undefined }, availabilityWorld());
    }

    // Record which model this sub-agent runs on (surfaced by list/status); the engine uses the
    // fully-resolved config below so the agent's provider (baseUrl/apiKey/headers) is honored,
    // not just the model id round-tripped through modelOverride.
    session.modelOverride = resolved.requestedModel ?? resolved.model;

    // The engine is always the home OpenAI-compatible loop now. Same AgentBackend contract.
    const bridge: AgentBackend = new AgentBridge(
      this.config,
      this.toolRegistry,
      this.skillRegistry,
      this.voiceManager,
      this.sttPipeline,
      depth,
      workspaceDir,
      type,
      resolved,
      undefined,
      this.agentRegistry,
    );
    // A sub-agent's pictures belong to the conversation that asked for it, and the hook is how it
    // stores them before its own end marker names them (2026-09-15).
    bridge.setMediaStore(this.mediaStore);
    // Same door for a prompt: a tool of this run that must ask the owner raises its sheet in the
    // parent conversation, where the human who spawned the agent is actually looking.
    bridge.setApprovalHandler(this.approvalHandler);

    const subMessage: UnifiedMessage = {
      id: messageId ?? `subagent-${session.id}`,
      platform: parentMessage.platform,
      chatType: parentMessage.chatType,
      chatId: parentMessage.chatId,
      // The parent's thread, not none: an approval raised by a tool of this run is drawn in the
      // conversation that asked for the agent (a sub-agent has no screen of its own).
      ...(parentMessage.threadId ? { threadId: parentMessage.threadId } : {}),
      userId: parentMessage.userId,
      text: userText ?? "",
      // Not decoration: this is what makes the run resolve as one that carries images (vision
      // reroute) and what makes the drop warn able to fire at all -- an empty array here was a
      // sub-agent silently blind to every picture it was sent.
      attachments: images ?? [],
      isForwarded: false,
      ...(resume ? { resume: true } : {}),
      raw: null,
    };

    // The backend cannot announce this one: it is handed a resolved override and never resolves,
    // so a sub-agent that ran on something other than its pin would say so nowhere. Posted to the
    // parent chat, which is where the human who asked for the spawn is looking.
    announceModelFallback(resolved, subMessage, type);

    // The mailbox is what makes this run steerable mid-flight: the app injects a chat.send into it
    // and the engine picks it up at the next iteration boundary. Open for parent-driven runs too
    // (they are the ones nobody else could steer before); openMailbox is idempotent, so an
    // app-driven run already opened by the router keeps its own.
    const execute = async (): Promise<string> => {
      runRegistry.openMailbox(session.id);
      let failure: unknown = null;
      try {
        // userEntryWritten: true — the runner wrote the UserEntry before calling the bridge,
        // so the bridge must not write a duplicate.
        const result = stream?.onToken
          ? await bridge.handleMessageStreaming(
              subMessage,
              session,
              stream.onToken,
              stream.onToolUse,
              signal,
              // An absorbed injection seals the current bubble and opens a fresh reply to it, the
              // same turn-switch contract the root path uses.
              stream.onTurnSwitch,
              undefined,
              stream.reasoning,
              stream.onToolStart,
              undefined,
              true, // userEntryWritten
            )
          : await bridge.handleMessage(subMessage, session, signal, undefined, undefined, true);
        // What the run's tools produced for the eye (a screenshot) travels with the answer to whoever
        // asked for the run; in prose alone a picture reached nobody.
        this.producedAttachments.set(session.id, bridge.getResponseAttachments(subMessage.id) ?? []);
        return result;
      } catch (err) {
        failure = err;
        if (isAbort(err, signal)) {
          hooks.emit("subagent:aborted", { id: session.id, parentSessionId: session.meta?.parentSessionId ?? "" });
          throw err;
        }
        hooks.emit("subagent:error", { id: session.id, error: err, parentSessionId: session.meta?.parentSessionId ?? "" });
        throw err;
      } finally {
        // Settle whatever the run did not absorb: an injection the engine never drained is rerouted
        // to a fresh run (RerouteSignal), which the router turns into a queued send. The mailbox is
        // closed either way, so a late arrival falls back to send() rather than a dead mailbox.
        runRegistry.settleMailbox(session.id, failure === null ? "resolve" : "reject", failure === null ? undefined : failure);
        runRegistry.closeMailbox(session.id);
      }
    };
    const browser = this.browser;
    if (type !== "browser" || !browser) return execute();
    // One Chromium, no turns: the run works in windows of its own and gives them back here,
    // however it ends -- docs/browser-windows.md.
    browser.beginRun(session.id, session.meta?.parentSessionId, userText);
    try {
      return await execute();
    } finally {
      await browser.endRun(session.id);
    }
  }

  private createSession(
    id: string,
    platform: string,
    chatType: string,
    meta: SubAgentMeta | undefined,
    workspace?: string,
  ): SessionData {
    return {
      id,
      platform,
      chatType,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      meta,
      ...(workspace ? { workspace } : {}),
    };
  }

  private buildUserContent(text: string, attachments?: Attachment[], location?: UnifiedMessage["location"]): string {
    let content = text;
    if (location) content += `\n\n${formatLocationForModel(location)}`;
    if (!attachments || attachments.length === 0) return content;
    const lines = attachments.map((a) => {
      const source = a.path ?? a.url ?? "unknown";
      return `- ${a.type}: ${source}`;
    });
    return `${content}\n\n[Attachments]\n${lines.join("\n")}`;
  }
}

/**
 * How deep sub-agents nest. A run's own sub-agents are level 1; what a level-1 agent may start is a
 * browser task, level 2, and a browser task starts nothing. The tool sets imply it, and on
 * 2026-09-28 they were the only thing that did: a role read off the wrong field handed every
 * sub-agent of a cron job the delegation tools, and browser tasks delegated to browser tasks 325
 * levels deep for six hours. docs/agent-roles.md.
 */
export const MAX_SUBAGENT_DEPTH = 2;

/** An error carrying the sub-agent it came from, for the tool that reports it to the caller. */
export function withSubagentId(err: unknown, id: string): unknown {
  if (err && typeof err === "object" && !("subagentId" in err)) (err as { subagentId?: string }).subagentId = id;
  return err;
}

export function subagentIdOf(err: unknown): string | undefined {
  const id = (err as { subagentId?: unknown } | undefined)?.subagentId;
  return typeof id === "string" ? id : undefined;
}

/** What a caller is told when a sub-agent it ran stopped or failed on its own: its work is kept. */
export function resumeHint(id: string | undefined): string {
  return id ? ` Sub-agent ${id} kept everything it had done: send(id: "${id}") with no message resumes it where it stopped. Do not start a new one for the same task.` : "";
}
