import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MyClawConfig } from "../core/config.ts";
import { MY_CLAW_DIR } from "../core/config.ts";
import { resolveAgentLlmConfig } from "../llm/resolver.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { AgentBridge } from "../agent/bridge.ts";
import { ClaudeSdkBackend } from "../agent/claude-sdk/backend.ts";
import type { AgentBackend } from "../agent/backend.ts";

import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import { loadSession, saveSession, deleteSession, archiveSession, trimSessionMessages } from "../sessions/store.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { isAbort } from "../core/aborted.ts";
import type { SubAgentType, SubAgentMeta, SubAgentInfo } from "./types.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

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
    const { displayName, type, mode, task, workspaceDir, parentMessage, existingIds, generateId, parentSessionId, visibility, signal, model, enqueue } = opts;
    if (mode === "run") {
      if (!this.canSpawn(0)) {
        return { id: "", result: `Error: run limit reached (${MAX_CONCURRENT_RUNS} max concurrent, depth ${MAX_DEPTH} max)` };
      }
      return this.runOneShot(type, task, workspaceDir, parentMessage, parentSessionId, signal, model);
    }

    const id = generateId(displayName, existingIds);
    const meta: SubAgentMeta = {
      displayName,
      type,
      workspaceDir,
      parentSessionId,
      visibility,
      createdAt: new Date().toISOString(),
    };

    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, meta);
    session.invokedBy = parentSessionId;
    session.messages.push({ role: "user", content: task, timestamp: new Date().toISOString() });
    await saveSession(id, session);

    hooks.emit("subagent:spawn", { id, displayName, type, mode });
    const run = () => this.executeRun(id, type, workspaceDir, parentMessage, signal, model);
    const result = await (enqueue ? enqueue(id, run) : run());
    hooks.emit("subagent:complete", { id, resultLength: result.length });
    return { id, result };
  }

  async send(
    id: string,
    message: string,
    attachments: Attachment[] | undefined,
    parentMessage: UnifiedMessage,
    registry: { enqueue: <T>(id: string, task: () => Promise<T>) => Promise<T>; isRunning: (id: string) => boolean },
    callerSessionId: string,
    signal?: AbortSignal,
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
      const result = await this.executeRunWithSession(session, session.meta.type, session.meta.workspaceDir, parentMessage, signal);
      await saveSession(id, session);
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
    const fresh = this.createSession(id, session.platform, session.chatType, session.meta);
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
        });
      }
    } catch {
      // no subagents dir
    }
    return out;
  }

  private async runOneShot(
    type: SubAgentType,
    task: string,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    parentSessionId: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<{ id: string; result: string }> {
    const id = `subagent/run-${crypto.randomUUID()}`;
    // A one-shot agent is unnamed and deleted when the run ends. It gets metadata only so its
    // tokens can be attributed, and that metadata is what makes an agent listable -- hence
    // private, or giving it a parent would also expose it to every other chat.
    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, {
      displayName: id.slice("subagent/".length),
      type,
      workspaceDir,
      parentSessionId,
      visibility: "private",
      createdAt: new Date().toISOString(),
    });
    session.invokedBy = parentSessionId;
    session.messages.push({ role: "user", content: task, timestamp: new Date().toISOString() });

    this.activeCount += 1;
    try {
      const result = await this.executeRunWithSession(session, type, workspaceDir, parentMessage, signal, model);
      return { id, result };
    } finally {
      this.activeCount -= 1;
      await deleteSession(id).catch(() => {});
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
    return result;
  }

  private async executeRunWithSession(
    session: SessionData,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    signal?: AbortSignal,
    model?: string,
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

    try {
      const result = await bridge.handleMessage(subMessage, session, signal);
      return result;
    } catch (err) {
      if (isAbort(err, signal)) {
        hooks.emit("subagent:aborted", { id: session.id });
        throw err;
      }
      hooks.emit("subagent:error", { id: session.id, error: err });
      throw err;
    }
  }

  private createSession(id: string, platform: string, chatType: string, meta: SubAgentMeta | undefined): SessionData {
    return {
      id,
      platform,
      chatType,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messages: [],
      meta,
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
