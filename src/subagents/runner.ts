import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MyClawConfig } from "../core/config.ts";
import { resolveMaxIterations, MY_CLAW_DIR } from "../core/config.ts";
import { resolveAgentLlmConfig } from "../llm/resolver.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { AgentBridge } from "../agent/bridge.ts";
import { IterationBudget } from "../agent/iteration-budget.ts";
import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import { loadSession, saveSession, deleteSession, archiveSession } from "../sessions/store.ts";
import { log } from "../utils/logger.ts";
import type { SubAgentType, SubAgentMeta, SubAgentInfo } from "./types.ts";
import type { VoiceManager, SttPipeline, TtsPipeline } from "../voice/index.ts";

const MAX_CONCURRENT_RUNS = 3;
const MAX_DEPTH = 2;
const MAX_MESSAGES = 500;
const MAX_MESSAGES_KEEP = 50;

export class SubAgentRunner {
  private activeCount = 0;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager: VoiceManager,
    private sttPipeline: SttPipeline,
    private ttsPipeline: TtsPipeline,
  ) {}

  canSpawn(depth: number): boolean {
    return this.activeCount < MAX_CONCURRENT_RUNS && depth < MAX_DEPTH;
  }

  async spawn(
    displayName: string,
    type: SubAgentType,
    mode: "run" | "session",
    task: string,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
    existingIds: Set<string>,
    generateId: (name: string, existing: Set<string>) => string,
  ): Promise<{ id: string; result: string }> {
    if (mode === "run") {
      if (!this.canSpawn(0)) {
        return { id: "", result: `Error: run limit reached (${MAX_CONCURRENT_RUNS} max concurrent, depth ${MAX_DEPTH} max)` };
      }
      return this.runOneShot(type, task, workspaceDir, 0, parentMessage);
    }

    const id = generateId(displayName, existingIds);
    const meta: SubAgentMeta = {
      displayName,
      type,
      workspaceDir,
      createdBy: parentMessage.chatId,
      createdAt: new Date().toISOString(),
    };

    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, meta);
    session.messages.push({ role: "user", content: task, timestamp: new Date().toISOString() });
    await saveSession(id, session);

    const result = await this.executeRun(id, type, workspaceDir, 0, parentMessage);
    return { id, result };
  }

  async send(
    id: string,
    message: string,
    attachments: Attachment[] | undefined,
    parentMessage: UnifiedMessage,
    registry: { enqueue: <T>(id: string, task: () => Promise<T>) => Promise<T>; isRunning: (id: string) => boolean },
  ): Promise<string> {
    return registry.enqueue(id, async () => {
      const session = await loadSession(id);
      if (!session || !session.meta) {
        return `Error: sub-agent ${id} not found.`;
      }

      const userContent = this.buildUserContent(message, attachments);
      session.messages.push({ role: "user", content: userContent, timestamp: new Date().toISOString() });

      if (session.messages.length > MAX_MESSAGES) {
        session.messages = session.messages.slice(-MAX_MESSAGES_KEEP);
      }

      const result = await this.executeRunWithSession(session, session.meta.type, session.meta.workspaceDir, parentMessage);
      await saveSession(id, session);
      return result;
    });
  }

  async kill(id: string): Promise<string> {
    await deleteSession(id);
    return `Sub-agent ${id} deleted.`;
  }

  async reset(id: string): Promise<string> {
    const session = await loadSession(id);
    if (!session || !session.meta) {
      return `Error: sub-agent ${id} not found.`;
    }
    await archiveSession(id);
    const fresh = this.createSession(id, session.platform, session.chatType, session.meta);
    await saveSession(id, fresh);
    return `Sub-agent ${id} session reset. Workspace preserved.`;
  }

  async list(registry: { isRunning: (id: string) => boolean }): Promise<SubAgentInfo[]> {
    const dir = join(MY_CLAW_DIR, "sessions", "subagent");
    const out: SubAgentInfo[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = `subagent/${entry.name.slice(0, -5)}`;
        const session = await loadSession(id);
        if (!session?.meta) continue;
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
    parentDepth: number,
    parentMessage: UnifiedMessage,
  ): Promise<{ id: string; result: string }> {
    const id = `subagent/run-${crypto.randomUUID()}`;
    const session = this.createSession(id, parentMessage.platform, parentMessage.chatType, undefined);
    session.messages.push({ role: "user", content: task, timestamp: new Date().toISOString() });

    this.activeCount += 1;
    try {
      const result = await this.executeRunWithSession(session, type, workspaceDir, parentMessage);
      return { id, result };
    } finally {
      this.activeCount -= 1;
    }
  }

  private async executeRun(
    id: string,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentDepth: number,
    parentMessage: UnifiedMessage,
  ): Promise<string> {
    const session = (await loadSession(id))!;
    return this.executeRunWithSession(session, type, workspaceDir, parentMessage);
  }

  private async executeRunWithSession(
    session: SessionData,
    type: SubAgentType,
    workspaceDir: string | undefined,
    parentMessage: UnifiedMessage,
  ): Promise<string> {
    const depth = 1;
    const resolved = resolveAgentLlmConfig(this.config.agents[type]?.llm, this.config.llm);
    const tools = this.toolRegistry.getForAgent(type === "research" ? "research" : "general");

    session.modelOverride = resolved.model;

    const budget = new IterationBudget(resolveMaxIterations(this.config, type));

    const bridge = new AgentBridge(
      this.config,
      this.toolRegistry,
      this.skillRegistry,
      this.voiceManager,
      this.sttPipeline,
      this.ttsPipeline,
      depth,
      workspaceDir,
      budget,
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

    const result = await bridge.handleMessage(subMessage, session);
    return result;
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
