import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MyClawConfig } from "../core/config.ts";
import { MY_CLAW_DIR, resolveAgentWorkspace, resolveWorkspaceKey, workspaceKeyForDir } from "../core/config.ts";
import { resolveRunModel, type RunModel, type RunModelRequest } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import { announceModelFallback } from "../llm/fallback-notice.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { AgentBridge } from "../agent/bridge.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback } from "../agent/backend.ts";

import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import { loadSession, saveSession, deleteSession, archiveSession, recordSubAgentCaller } from "../sessions/store.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import type { UserEntry } from "../sessions/log.ts";
import { log } from "../utils/logger.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { hooks } from "../hooks/index.ts";
import { isAbort } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";
import { indexSessionEntries } from "../conversations/store.ts";
import type { SubAgentType, SubAgentMeta, SubAgentInfo, SubAgentCallerInfo } from "./types.ts";
import { sanitizeDisplayName } from "./registry.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";
import { formatLocationForModel } from "../agent/preprocess.ts";

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

const MAX_CONCURRENT_RUNS = 3;
const MAX_DEPTH = 2;

/**
 * Who a caller is, for the visibility rule. The workspace is the caller conversation's own key
 * (undefined = the default workspace), which is what a `workspace` agent is scoped to.
 */
export interface SubAgentCaller {
  sessionId: string;
  workspaceKey?: string;
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

interface ActiveSubAgentRun {
  controller: AbortController;
  done: Promise<void>;
}

export class SubAgentRunner {
  private activeCount = 0;
  private activeRuns = new Map<string, Set<ActiveSubAgentRun>>();

  private sessionManager?: SessionManager;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager: VoiceManager,
    private sttPipeline: SttPipeline,
    /** File-defined agents, handed to whichever backend runs the sub-agent. */
    private agentRegistry?: AgentRegistry,
  ) {}

  /**
   * Wires the shared cache so live sub-agent runs are reachable from the app channel
   * (history/peek) while in flight. Constructed before the SessionManager in index.ts,
   * hence the setter instead of a constructor argument.
   */
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
      return await task(controller.signal);
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

  /** Makes this conversation searchable from its log, which is where its turns actually are. */
  private async indexForSearch(id: string, session: SessionData): Promise<void> {
    indexSessionEntries(session, (await sessionLogOf(id)).entries());
  }

  private async persistSession(id: string, session: SessionData): Promise<void> {
    if (this.sessionManager) {
      this.sessionManager.adopt(session);
      await this.sessionManager.persist(id);
    } else {
      await saveSession(id, session);
    }
  }

  canSpawn(depth: number): boolean {
    return this.activeCount < MAX_CONCURRENT_RUNS && depth < MAX_DEPTH;
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
    };
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
  }): Promise<{ id: string; result: string }> {
    const { type, mode, task, workspaceDir, parentWorkspaceDir, parentMessage, existingIds, generateId, parentSessionId, visibility, signal, model, enqueue, toolCallId, streamProvider } = opts;
    // Sanitized here rather than only inside SubAgentRegistry.generateId: that function arrives as
    // a callback, so this is the one place every caller passes through, and it keeps the stored
    // displayName equal to the name inside the id.
    const displayName = sanitizeDisplayName(opts.displayName);

    const resolved = this.resolveWorkspace(type, workspaceDir, parentWorkspaceDir);
    if ("error" in resolved) return { id: "", result: `Error: ${resolved.error}` };

    if (mode === "run") {
      if (!this.canSpawn(0)) {
        return { id: "", result: `Error: run limit reached (${MAX_CONCURRENT_RUNS} max concurrent, depth ${MAX_DEPTH} max)` };
      }
      return this.runOneShot(displayName, type, task, resolved.dir, resolved.key, parentMessage, parentSessionId, signal, model, toolCallId, streamProvider, enqueue);
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
    session.invokedBy = parentSessionId;
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

      hooks.emit("subagent:spawn", { id, displayName, type, mode, parentSessionId, action: "spawn", ...(toolCallId ? { toolCallId } : {}) });
      const stream = streamProvider?.(id);
      const run = () => this.executeRun(id, type, resolved.dir, parentMessage, trackedSignal, model, stream, task);
      const result = await (enqueue ? enqueue(id, run) : run());
      hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId });
      return { id, result };
    });
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

  async send(
    id: string,
    message: string,
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
  ): Promise<string> {
    return this.runTracked(id, signal, (trackedSignal) => registry.enqueue(id, async () => {
      const session = await loadSession(id);
      if (!session || !session.meta) {
        return `Error: sub-agent ${id} not found.`;
      }
      if (!isReachableFrom(session.meta, await this.resolveCaller(callerSessionId))) {
        return `Error: sub-agent ${id} not found.`;
      }

      const userContent = this.buildUserContent(message, attachments, parentMessage.location);
      // Write user turn to the log. A crash before the first bridge turn must still show the question.
      const entryLog = await sessionLogOf(id);
      entryLog.append<UserEntry>({
        type: "user",
        prompt: true,
        text: userContent,
        ...(parentMessage.location ? { location: parentMessage.location } : {}),
        // When a model drives the send, record where it came from
        ...(toolCallId ? { from: { sessionId: callerSessionId, label: "send" } } : {}),
      });
      await entryLog.flush();

      // A global agent can be driven from a chat other than its creator, so this run's tokens
      // belong to whoever sent this message, not to whoever spawned the agent.
      session.invokedBy = callerSessionId;
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
        });
      }
      // Resolved after the event, not before: the app channel creates the sub-agent's streamer
      // while handling the spawn event, so asking any earlier always yields undefined.
      const runStream = stream ?? (tracked ? streamProvider?.(id) : undefined);
      try {
        const result = await this.executeRunWithSession(session, session.meta.type, session.meta.workspaceDir, parentMessage, trackedSignal, undefined, runStream, undefined, userContent);
        if (tracked) hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId: callerSessionId });
        return result;
      } catch (err) {
        // executeRunWithSession already reported this to the session's spawner; a send can come
        // from another conversation, and that one owns the card being watched here.
        if (tracked && callerSessionId !== (session.meta.parentSessionId ?? "")) {
          if (isAbort(err, trackedSignal)) hooks.emit("subagent:aborted", { id, parentSessionId: callerSessionId });
          else hooks.emit("subagent:error", { id, error: err, parentSessionId: callerSessionId });
        }
        throw err;
      } finally {
        // In the finally, not after: a failed run used to lose the question too, and the thread
        // came back from disk with no trace that anything had been sent.
        await this.persistSession(id, session);
        await this.indexForSearch(id, session);
      }
    }));
  }

  async kill(id: string, callerSessionId: string): Promise<string> {
    // deleteSession takes any session id, so without this guard `kill_agent` could be pointed at
    // a chat session and delete a conversation.
    const session = await loadSession(id);
    if (!id.startsWith("subagent/") || !session?.meta || !isReachableFrom(session.meta, await this.resolveCaller(callerSessionId))) {
      return `Error: sub-agent ${id} not found.`;
    }
    await this.stopTracked(id);
    if (this.sessionManager) await this.sessionManager.deleteSession(id);
    else await deleteSession(id);
    // Cache parity: the adopted session must not survive the kill. The manager delete also drains
    // queued writes before removing the file, so a late autosave cannot resurrect the agent.
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
    if (this.sessionManager) {
      this.sessionManager.adopt(current);
      await this.sessionManager.persist(id);
    } else {
      await saveSession(id, current);
    }
    // Through the manager when there is one: it owns the open log, and a reset that leaves that log
    // cached hands the fresh conversation the old leaf and a handle to a file that has moved.
    if (this.sessionManager) await this.sessionManager.archiveConversation(id);
    else await archiveSession(id);
    // The workspace survives a reset like the rest of the identity: a sub-agent pinned to a
    // project must not silently come back in the default one.
    const fresh = this.createSession(id, current.platform, current.chatType, current.meta, current.workspace);
    if (this.sessionManager) {
      this.sessionManager.adopt(fresh);
      await this.sessionManager.persist(id);
    } else {
      await saveSession(id, fresh);
    }
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

  async list(registry: { isRunning: (id: string) => boolean }, callerSessionId: string): Promise<SubAgentInfo[]> {
    const dir = join(MY_CLAW_DIR, "sessions", "subagent");
    const out: SubAgentInfo[] = [];
    // Resolved once for the whole scan rather than per entry: the caller does not change between
    // two files, and a read per sub-agent would make listing quadratic in disk reads.
    const caller = await this.resolveCaller(callerSessionId);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = `subagent/${entry.name.slice(0, -5)}`;
        const session = await loadSession(id);
        if (!session?.meta) continue;
        if (!isReachableFrom(session.meta, caller)) continue;
        // Get entry count from the log
        const entryLog = await sessionLogOf(id);
        out.push({
          id,
          displayName: session.meta.displayName,
          type: session.meta.type,
          messageCount: entryLog.entries().filter(e => e.prompt).length,
          status: registry.isRunning(id) ? "running" : "idle",
          visibility: session.meta.visibility,
          ...(session.meta.workspaceKey ? { workspaceKey: session.meta.workspaceKey } : {}),
          ...(session.modelOverride ? { model: session.modelOverride } : {}),
          createdAt: session.meta.createdAt,
        });
      }
    } catch {
      // no subagents dir
    }
    return out;
  }

  /**
   * Removes the private sub-agents a conversation owns. Called when the app deletes the
   * conversation: a private agent is reachable from its parent alone, so a deleted parent leaves
   * it an unreachable orphan. Global agents survive on purpose -- they are shared workers another
   * conversation may still drive, and the roster of any conversation still lists them for a
   * deliberate kill. A running agent is skipped: its run would resurrect the file via saveSession.
   */
  async deleteChildrenOf(parentSessionId: string, registry: { isRunning: (id: string) => boolean }): Promise<number> {
    const dir = join(MY_CLAW_DIR, "sessions", "subagent");
    let removed = 0;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = `subagent/${entry.name.slice(0, -5)}`;
        const session = await loadSession(id);
        if (!session?.meta) continue;
        if (session.meta.visibility !== "private") continue;
        if (session.meta.parentSessionId !== parentSessionId) continue;
        if (registry.isRunning(id) || this.activeRuns.has(id)) continue;
        if (this.sessionManager) await this.sessionManager.deleteSession(id);
        else await deleteSession(id);
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
  ): Promise<{ id: string; result: string }> {
    const id = `subagent/run-${crypto.randomUUID()}`;
    // A one-shot keeps its session now: the app lists it as a temporary sub-agent and can open it
    // like a chat, so deleting it would make the roster promise something it cannot deliver. It
    // stays private -- an unnamed agent must not leak past the conversation that asked for it --
    // and dies with its parent conversation (deleteChildrenOf).
    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, {
      displayName: displayName || id.slice("subagent/".length),
      type,
      workspaceDir,
      parentSessionId,
      visibility: "private",
      createdAt: new Date().toISOString(),
    }, workspaceKey);
    session.invokedBy = parentSessionId;
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

      hooks.emit("subagent:spawn", { id, displayName: displayName || id.slice("subagent/".length), type, mode: "run", parentSessionId, action: "spawn", ...(toolCallId ? { toolCallId } : {}) });
      const stream = streamProvider?.(id);
      this.activeCount += 1;
      try {
        const execute = () => this.executeRunWithSession(session, type, workspaceDir, parentMessage, trackedSignal, model, stream, undefined, task);
        const result = await (enqueue ? enqueue(id, execute) : execute());
        hooks.emit("subagent:complete", { id, resultLength: result.length, parentSessionId });
        return { id, result };
      } finally {
        this.activeCount -= 1;
        await this.indexForSearch(id, session);
        // The run wrote its turns into the session in memory; this is the moment they land on disk.
        await this.persistSession(id, session);
      }
    });
  }

  private async executeRun(
    id: string,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    signal?: AbortSignal,
    model?: string,
    stream?: SubAgentStream,
    userText?: string,
  ): Promise<string> {
    // `loadSession` also returns null on a truncated file, and the non-null assertion turned that
    // into a TypeError the model received as an opaque tool error.
    const session = await loadSession(id);
    if (!session) {
      void log("error", "sub-agent session unreadable", { id });
      return `Error: sub-agent ${id} not found.`;
    }
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
  ): Promise<string> {
    const depth = 1;
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
    const request: RunModelRequest = {
      agent: type,
      ...(fileModel ? { fileModel } : {}),
      ...(pick ? { sessionModel: pick } : {}),
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

    const subMessage: UnifiedMessage = {
      id: messageId ?? `subagent-${session.id}`,
      platform: parentMessage.platform,
      chatType: parentMessage.chatType,
      chatId: parentMessage.chatId,
      userId: parentMessage.userId,
      text: userText ?? "",
      attachments: [],
      isForwarded: false,
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
      messages: [],
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
