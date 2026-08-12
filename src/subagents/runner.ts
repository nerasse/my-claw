import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MyClawConfig } from "../core/config.ts";
import { MY_CLAW_DIR, resolveAgentWorkspace, resolveWorkspaceKey, workspaceKeyForDir } from "../core/config.ts";
import { resolveAgentLlmConfig } from "../llm/resolver.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { AgentBridge } from "../agent/bridge.ts";
import { ClaudeSdkBackend } from "../agent/claude-sdk/backend.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolUseCallback, TurnSwitchCallback } from "../agent/backend.ts";

import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import { loadSession, saveSession, deleteSession, archiveSession, trimSessionMessages } from "../sessions/store.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { isAbort } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";
import { indexSessionArchive } from "../conversations/store.ts";
import type { SubAgentType, SubAgentMeta, SubAgentInfo } from "./types.ts";
import { sanitizeDisplayName } from "./registry.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

/**
 * Where a sub-agent's run reports itself while a human watches it. Absent for a parent-driven run:
 * `spawn` and the model's `send` stay non-streaming, so nothing about them changes.
 */
export interface SubAgentStream {
  onToken: TokenCallback;
  onToolUse?: ToolUseCallback;
  /** Called when the run absorbs a mid-run injection, so the output layer can seal the current
   *  bubble and open a fresh reply to the injected message -- same contract as the root path. */
  onTurnSwitch?: TurnSwitchCallback;
  reasoning?: ReasoningSink;
}

const MAX_CONCURRENT_RUNS = 3;
const MAX_DEPTH = 2;
const MAX_MESSAGES = 500;
const MAX_MESSAGES_KEEP = 50;

/**
 * Sub-agents are global on purpose: any chat can list and drive any of them, which is what makes
 * them useful as shared workers. A private one is scoped to the session that created it -- either
 * because the owner asked, or because it is a one-shot with no name to share.
 */
function isReachableFrom(meta: SubAgentMeta, callerSessionId: string): boolean {
  if (meta.visibility !== "private") return true;
  // An unknown caller must not match an agent whose parent is also unknown.
  return callerSessionId.length > 0 && meta.parentSessionId === callerSessionId;
}

export class SubAgentRunner {
  private activeCount = 0;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager: VoiceManager,
    private sttPipeline: SttPipeline,
    /** File-defined agents, handed to whichever backend runs the sub-agent. */
    private agentRegistry?: AgentRegistry,
  ) {}

  canSpawn(depth: number): boolean {
    return this.activeCount < MAX_CONCURRENT_RUNS && depth < MAX_DEPTH;
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
    visibility: "global" | "private";
    signal?: AbortSignal;
    model?: string;
    // Same per-agent queue as send(): without it, a send() issued while the spawn's first
    // run is still going races it on the session file (and the SDK session resume).
    enqueue?: <T>(id: string, task: () => Promise<T>) => Promise<T>;
  }): Promise<{ id: string; result: string }> {
    const { type, mode, task, workspaceDir, parentWorkspaceDir, parentMessage, existingIds, generateId, parentSessionId, visibility, signal, model, enqueue } = opts;
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
      return this.runOneShot(displayName, type, task, resolved.dir, resolved.key, parentMessage, parentSessionId, signal, model);
    }

    const id = generateId(displayName, existingIds);
    const meta: SubAgentMeta = {
      displayName,
      type,
      workspaceDir: resolved.dir,
      parentSessionId,
      visibility,
      createdAt: new Date().toISOString(),
    };

    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, meta, resolved.key);
    session.invokedBy = parentSessionId;
    session.messages.push({ role: "user", content: task, timestamp: new Date().toISOString() });
    await saveSession(id, session);
    indexSessionArchive(session);

    hooks.emit("subagent:spawn", { id, displayName, type, mode });
    const run = () => this.executeRun(id, type, resolved.dir, parentMessage, signal, model);
    const result = await (enqueue ? enqueue(id, run) : run());
    hooks.emit("subagent:complete", { id, resultLength: result.length });
    return { id, result };
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
  ): Promise<string> {
    return registry.enqueue(id, async () => {
      const session = await loadSession(id);
      if (!session || !session.meta) {
        return `Error: sub-agent ${id} not found.`;
      }
      if (!isReachableFrom(session.meta, callerSessionId)) {
        return `Error: sub-agent ${id} not found.`;
      }

      const userContent = this.buildUserContent(message, attachments);
      session.messages.push({ role: "user", content: userContent, timestamp: new Date().toISOString() });

      if (session.messages.length > MAX_MESSAGES) {
        session.messages = trimSessionMessages(session.messages, MAX_MESSAGES_KEEP);
      }

      // A global agent can be driven from a chat other than its creator, so this run's tokens
      // belong to whoever sent this message, not to whoever spawned the agent.
      session.invokedBy = callerSessionId;
      const result = await this.executeRunWithSession(session, session.meta.type, session.meta.workspaceDir, parentMessage, signal, undefined, stream);
      await saveSession(id, session);
      indexSessionArchive(session);
      return result;
    });
  }

  async kill(id: string, callerSessionId: string): Promise<string> {
    // deleteSession takes any session id, so without this guard `kill_agent` could be pointed at
    // a chat session and delete a conversation.
    const session = await loadSession(id);
    if (!id.startsWith("subagent/") || !session?.meta || !isReachableFrom(session.meta, callerSessionId)) {
      return `Error: sub-agent ${id} not found.`;
    }
    await deleteSession(id);
    hooks.emit("subagent:killed", { id });
    return `Sub-agent ${id} deleted.`;
  }

  async reset(id: string, callerSessionId: string): Promise<string> {
    const session = await loadSession(id);
    if (!session || !session.meta || !isReachableFrom(session.meta, callerSessionId)) {
      return `Error: sub-agent ${id} not found.`;
    }
    await archiveSession(id);
    // The workspace survives a reset like the rest of the identity: a sub-agent pinned to a
    // project must not silently come back in the default one.
    const fresh = this.createSession(id, session.platform, session.chatType, session.meta, session.workspace);
    await saveSession(id, fresh);
    hooks.emit("subagent:reset", { id });
    return `Sub-agent ${id} session reset. Workspace preserved.`;
  }

  async list(registry: { isRunning: (id: string) => boolean }, callerSessionId: string): Promise<SubAgentInfo[]> {
    const dir = join(MY_CLAW_DIR, "sessions", "subagent");
    const out: SubAgentInfo[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = `subagent/${entry.name.slice(0, -5)}`;
        const session = await loadSession(id);
        if (!session?.meta) continue;
        if (!isReachableFrom(session.meta, callerSessionId)) continue;
        out.push({
          id,
          displayName: session.meta.displayName,
          type: session.meta.type,
          messageCount: session.messages.length,
          status: registry.isRunning(id) ? "running" : "idle",
          visibility: session.meta.visibility,
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
        if (registry.isRunning(id)) continue;
        await deleteSession(id);
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
    session.messages.push({ role: "user", content: task, timestamp: new Date().toISOString() });

    this.activeCount += 1;
    try {
      const result = await this.executeRunWithSession(session, type, workspaceDir, parentMessage, signal, model);
      return { id, result };
    } finally {
      this.activeCount -= 1;
      indexSessionArchive(session);
      // The run wrote its turns into the session in memory; this is the moment they land on disk.
      await saveSession(id, session);
    }
  }

  private async executeRun(
    id: string,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    signal?: AbortSignal,
    model?: string,
  ): Promise<string> {
    const session = (await loadSession(id))!;
    const result = await this.executeRunWithSession(session, type, workspaceDir, parentMessage, signal, model);
    // Persist the first run so a session-mode sub-agent remembers its own answer; without this
    // the next send() reloads a history containing the task but not the reply.
    await saveSession(id, session);
    indexSessionArchive(session);
    return result;
  }

  private async executeRunWithSession(
    session: SessionData,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    signal?: AbortSignal,
    model?: string,
    stream?: SubAgentStream,
  ): Promise<string> {
    const depth = 1;
    // Explicit spawn model wins; a session sub-agent then sticks to it across send()
    // via the modelOverride recorded on the first run.
    const resolved = resolveAgentLlmConfig(this.config.agents?.[type]?.llm, this.config.llm, model ?? session.modelOverride);

    // Record which model this sub-agent runs on (surfaced by list/status); the engine uses the
    // fully-resolved config below so the agent's provider (baseUrl/apiKey/headers) is honored,
    // not just the model id round-tripped through modelOverride.
    session.modelOverride = resolved.model;

    // The engine follows the model: a claude-sdk model runs its own SDK loop, anything
    // else runs the home loop. Same contract either way (AgentBackend).
    const bridge: AgentBackend = resolved.backend === "claude-sdk"
      ? new ClaudeSdkBackend(
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
          undefined,
          this.agentRegistry,
        )
      : new AgentBridge(
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
      id: `subagent-${session.id}`,
      platform: parentMessage.platform,
      chatType: parentMessage.chatType,
      chatId: parentMessage.chatId,
      userId: parentMessage.userId,
      text: session.messages[session.messages.length - 1]?.content ?? "",
      attachments: [],
      isForwarded: false,
      raw: null,
    };

    // The mailbox is what makes this run steerable mid-flight: the app injects a chat.send into it
    // and the engine picks it up at the next iteration boundary. Open for parent-driven runs too
    // (they are the ones nobody else could steer before); openMailbox is idempotent, so an
    // app-driven run already opened by the router keeps its own.
    runRegistry.openMailbox(session.id);
    let failure: unknown = null;
    try {
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
          )
        : await bridge.handleMessage(subMessage, session, signal);
      return result;
    } catch (err) {
      failure = err;
      if (isAbort(err, signal)) {
        hooks.emit("subagent:aborted", { id: session.id });
        throw err;
      }
      hooks.emit("subagent:error", { id: session.id, error: err });
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

  private buildUserContent(text: string, attachments?: Attachment[]): string {
    if (!attachments || attachments.length === 0) return text;
    const lines = attachments.map((a) => {
      const source = a.path ?? a.url ?? "unknown";
      return `- ${a.type}: ${source}`;
    });
    return `${text}\n\n[Attachments]\n${lines.join("\n")}`;
  }
}
