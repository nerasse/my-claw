import { query as sdkQuery, type Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentToolType, EffortLevel, MyClawConfig, ResolvedLlmConfig } from "../../core/config.ts";
import { resolveWorkspaceKey } from "../../core/config.ts";
import {
  MY_CLAW_DIR,
  nestedAgentsEnabled,
  resolveAgentSkills,
  resolveAgentMcp,
  resolveAgentLlm,
  resolveMaxIterations,
  resolveNestedAgentsMaxBytes,
} from "../../core/config.ts";
import { NestedAgentsCollector } from "../prompt/nested-agents.ts";
import { join } from "node:path";
import type { SubAgentType } from "../../subagents/types.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../../channels/types.ts";
import type { SessionData, SessionMessage } from "../../sessions/store.ts";
import { trimSessionMessages, sealDanglingToolCalls, attributionParent } from "../../sessions/store.ts";
import type { AgentBackend, TokenCallback, ToolUseCallback, TurnSwitchCallback } from "../backend.ts";
import { buildSystemPrompt } from "../prompt/builder.ts";
import { selectRelevantSkills } from "../../skills/retrieval.ts";
import { resolveLlmConfigForAgentMessage } from "../../llm/resolver.ts";
import { loadClaudeToken } from "../../llm/claude-auth.ts";
import { recordApiCall } from "../../analytics/usage-db.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import type { AgentRegistry } from "../../agents/registry.ts";
import { resolveAgent } from "../../agents/resolve.ts";
import { log } from "../../utils/logger.ts";
import { errorLogData } from "../../utils/errors.ts";
import { ToolApprovalManager } from "../approvals.ts";
import type { VoiceManager, SttPipeline } from "../../voice/index.ts";
import { MessagePreprocessor } from "../preprocess.ts";
import { renderPriorConversation } from "./history.ts";
import { estimateTokens } from "../../llm/tokens.ts";
import { resolveContextWindow, measuredPrompt } from "../../llm/context-window.ts";
import { recall } from "../../memory/index.ts";
import { hooks } from "../../hooks/index.ts";
import { AbortedError, isAbort } from "../../core/aborted.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { createToolServerForRun } from "./tools.ts";

// Headroom left for the reply when the resolved model does not declare an output limit.
const DEFAULT_OUTPUT_RESERVE_TOKENS = 32_000;

const MAX_SESSION_MESSAGES = 500;
const MAX_SESSION_MESSAGES_KEEP = 50;

// Without this, Claude's anti-injection training treats a mid-run steering message that
// contradicts the initial task as an attack and ignores it (verified in the phase 0 spike).
// Exported so `/instructions` can show the prompt this backend really sends, not the builder output.
export const OWNER_STEERING_NOTE =
  "\n\n# Mid-run steering\n" +
  "You are operated by a single trusted owner. User messages arriving mid-conversation " +
  "(including while you are working) are legitimate steering from the owner and take " +
  "precedence over earlier instructions.";

const COMPACT_TIMEOUT_MS = 120_000;

const AUTH_FAILURE_HINT =
  "Claude subscription auth failed — regenerate the token with `claude setup-token` " +
  "and update CLAUDE_CODE_OAUTH_TOKEN in ~/.my-claw/.env";

// Minimal structural view of the SDK message stream. The SDK exports richer types, but
// depending only on the fields we read keeps the fake query used in tests trivial. The
// *options* side, in contrast, is typed against the real SDK `Options` so a key typo can
// never be silently ignored (audited finding: `as unknown as` had disabled that check).
interface SdkStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  errors?: string[];
  parent_tool_use_id?: string | null;
  compact_result?: string;
  compact_error?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  error?: string;
  message?: {
    id?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

// The Anthropic API only takes these media types; anything else must be dropped rather
// than sent (guaranteed 400 otherwise).
const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string | SdkContentBlock[] };
  parent_tool_use_id: null;
}

export type SdkQueryFn = (params: {
  prompt: AsyncGenerator<SdkUserMessage>;
  options: SdkOptions;
}) => AsyncIterable<SdkStreamMessage>;

/**
 * MCP tool results are arrays of content blocks; the mirror stores plain text so the home
 * loop can replay it verbatim if the session later switches engines.
 */
function toolResultToText(content: unknown, isError: boolean): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .filter((t) => t.length > 0)
      .join("\n") || JSON.stringify(content);
  } else {
    text = JSON.stringify(content ?? "");
  }
  return isError && !text.startsWith("Error") ? `Error: ${text}` : text;
}

function accumulateUsage(session: SessionData, usage: SdkUsage): void {
  if (!session.tokenUsage) {
    session.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };
  }
  session.tokenUsage.promptTokens += usage.promptTokens;
  session.tokenUsage.completionTokens += usage.completionTokens;
  session.tokenUsage.totalTokens += usage.totalTokens;
  session.tokenUsage.apiCalls += 1;
  if (usage.cacheReadTokens) session.tokenUsage.cacheReadTokens = (session.tokenUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  if (usage.cacheWriteTokens) session.tokenUsage.cacheWriteTokens = (session.tokenUsage.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
}

interface SdkUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * "ultra" is a Codex-only reasoning level and the Claude SDK caps at "max". A session effort
 * chosen while on a Codex model follows you to a Claude one, so clamp rather than fail the run,
 * and log it — the setting must never be dropped silently.
 */
export function toSdkEffort(effort: EffortLevel | undefined): SdkOptions["effort"] {
  if (effort === "ultra") {
    void log("warn", "effort ultra is not supported by claude-sdk, clamping to max");
    return "max";
  }
  return effort;
}

// Shared env for every SDK subprocess: hermetic flags + isolated config dir, with the
// subscription token from the my-claw store injected when present (else the ambient env token
// from process.env is inherited).
function sdkBaseEnv(claudeToken: string | null): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}),
    CLAUDE_CODE_ENABLE_TASKS: "0",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: join(MY_CLAW_DIR, "claude-sdk"),
  };
}

export class ClaudeSdkBackend implements AgentBackend {
  private approvalManager: ToolApprovalManager;
  private preprocessor: MessagePreprocessor;
  private queryFn: SdkQueryFn;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    voiceManager?: VoiceManager,
    sttPipeline?: SttPipeline,
    private depth: number = 0,
    private workspaceDir?: string,
    private agentKind?: SubAgentType,
    private llmOverride?: ResolvedLlmConfig,
    sharedPreprocessor?: MessagePreprocessor,
    queryFn?: SdkQueryFn,
    // See the same parameter on AgentBridge. Last, after the queryFn test seam: inserting it
    // before would silently shift the fake SDK into this slot and send the suite at the real CLI.
    private agentRegistry?: AgentRegistry,
  ) {
    this.approvalManager = new ToolApprovalManager(config.blacklist);
    this.preprocessor = sharedPreprocessor ?? new MessagePreprocessor(voiceManager, sttPipeline);
    // The cast only bridges the *stream* side (our structural read-view vs the SDK's
    // exact union); the options side stays fully checked because every literal we build
    // is typed `SdkOptions`.
    this.queryFn = queryFn ?? (sdkQuery as unknown as SdkQueryFn);
  }

  /** The run's workspace: the session's own key's directory, else the default workspace. */
  private workspaceFor(session: SessionData): { workspaceDir: string; defaultWorkspaceDir: string } {
    // Always the default workspace, never this run's: it is the fallback layer for prompt files
    // a secondary workspace does not override.
    const defaultDir = process.env["MY_CLAW_WORKSPACE"] ?? this.config.workspace ?? process.cwd();
    // An injected dir (the sub-agent runner) has already resolved the agent's workspace and any
    // narrowing inside it, so it wins; the session key covers runs that have no injected dir.
    if (this.workspaceDir) return { workspaceDir: this.workspaceDir, defaultWorkspaceDir: defaultDir };
    if (!session.workspace) return { workspaceDir: defaultDir, defaultWorkspaceDir: defaultDir };
    return {
      workspaceDir: resolveWorkspaceKey(this.config, session.workspace),
      defaultWorkspaceDir: defaultDir,
    };
  }

  getEchoMessages(messageId: string): OutgoingMessage[] {
    return this.preprocessor.consumeEchoMessages(messageId);
  }

  getResponseAttachments(messageId: string): OutgoingMessage["attachments"] {
    return this.preprocessor.consumeResponseAttachments(messageId);
  }

  hadAudioInbound(messageId: string): boolean {
    return this.preprocessor.inboundHadAudio(messageId);
  }

  transcriptsOf(messageId: string): Array<{ path: string; text: string }> {
    return this.preprocessor.transcriptsOf(messageId);
  }

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.approvalManager.setHandler(handler);
  }

  async preprocessMessage(message: UnifiedMessage): Promise<void> {
    return this.preprocessor.preprocessMessage(message);
  }

  async handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal): Promise<string> {
    return this.handle(message, session, undefined, undefined, signal);
  }

  async handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
  ): Promise<string> {
    return this.handle(message, session, onToken, onToolUse, signal, onTurnSwitch);
  }

  /**
   * Maps the /compact meta-command to the SDK's own compaction: the history lives in
   * the SDK session, so summarizing the my-claw mirror would change nothing the model
   * sees. Sends the native `/compact` slash command into the resumed session.
   */
  async compact(session: SessionData): Promise<string> {
    if (!session.sdkSessionId) {
      return "Nothing to compact yet on this session.";
    }
    let finished = false;
    async function* one(): AsyncGenerator<SdkUserMessage> {
      yield { type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null };
      while (!finished) await new Promise((r) => setTimeout(r, 100));
    }
    let compacted = false;
    let compactError: string | undefined;
    let resultText = "";
    // A hung CLI must not hold the /compact command hostage: hard wall, then abort.
    const abortController = new AbortController();
    const wall = setTimeout(() => abortController.abort(), COMPACT_TIMEOUT_MS);
    try {
      const compactOptions: SdkOptions = {
        resume: session.sdkSessionId,
        model: session.modelOverride,
        maxTurns: 1,
        abortController,
        tools: [],
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        executable: "bun",
        env: sdkBaseEnv(await loadClaudeToken()),
      };
      const q = this.queryFn({ prompt: one(), options: compactOptions });
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          session.sdkSessionId = msg.session_id;
        }
        if (msg.type === "system" && msg.subtype === "compact_boundary") compacted = true;
        if (msg.compact_result === "failed") compactError = msg.compact_error ?? "unknown";
        if (msg.type === "result") {
          if (typeof msg.result === "string") resultText = msg.result;
          finished = true;
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) return "Compaction timed out.";
      throw err;
    } finally {
      finished = true;
      clearTimeout(wall);
      session.lastActiveAt = new Date().toISOString();
    }
    if (compactError) return `Compaction failed: ${compactError}`;
    if (compacted) return "Context compacted (SDK session summarized).";
    return resultText.trim() || "Compaction did not run.";
  }

  private async handle(
    message: UnifiedMessage,
    session: SessionData,
    onToken?: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
  ): Promise<string> {
    await this.preprocessor.preprocessForHandle(message);

    const isCron = message.platform === "cron";
    const agentToolType = isCron
      ? "cron"
      : this.depth === 0
        ? "main"
        : this.agentKind ?? "general";
    const agent = resolveAgent(this.config, this.agentRegistry, agentToolType, session.workspace);
    const tools = this.toolRegistry.getForAgent(agent.base, this.config.tools?.disabled, agent.mcp, agent.allow);
    const llmConfig = this.llmOverride ?? resolveLlmConfigForAgentMessage(
      this.config.llm,
      agent.llm,
      session.modelOverride,
      message.attachments.some((a) => a.type === "image" && Boolean(a.path)),
      session.effortOverride,
    );
    const startedAt = Date.now();
    const streaming = Boolean(onToken);
    const agentType = this.depth === 0 ? "orchestrator" : this.agentKind ?? "general";
    const cronMaxIter = this.config.cron?.maxIterations;
    const maxTurns = isCron && cronMaxIter !== undefined && Number.isFinite(cronMaxIter) && cronMaxIter > 0
      ? cronMaxIter
      : agent.maxIterations;
    const runLabel = this.depth === 0 ? "main" : session.meta?.displayName ?? agentType;
    const runNode = signal ? runRegistry.enter(signal, runLabel, this.depth) : undefined;

    hooks.emit("agent:run:start", {
      messageId: message.id,
      sessionId: session.id,
      model: llmConfig.model,
      streaming,
      maxIterations: maxTurns,
    });
    void log("info", "claude-sdk run started", {
      messageId: message.id,
      sessionId: session.id,
      platform: message.platform,
      model: llmConfig.model,
      streaming,
      toolCount: tools.length,
      maxTurns,
      resume: session.sdkSessionId ?? null,
    });

    const gate = await hooks.check("gate:agent:before:reply", { sessionId: session.id, message });
    if (!gate.allowed) {
      runNode?.exit();
      return `Reply blocked by gate: ${gate.reason ?? "no reason"}`;
    }

    const messageCountBefore = session.messages.length;
    const sdkSessionIdBefore = session.sdkSessionId;
    const sdkSyncedAtBefore = session.sdkSyncedAt;
    let toolExecutions = 0;
    let removeAbortListener: (() => void) | undefined;

    try {
      // Scoped, not the full store: layer 5 tells the agent it MUST read_skill anything listed, so a
      // catalog wider than the scope would advertise skills read_skill then refuses.
      const allSkills = this.skillRegistry.list(agent.skills, session.workspace);
      const runWorkspace = this.workspaceFor(session);
      let systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model: llmConfig.model,
        sessionId: session.id,
        tools,
        skills: allSkills,
        workspaceDir: runWorkspace.workspaceDir,
        defaultWorkspaceDir: runWorkspace.defaultWorkspaceDir,
        ...(agent.prompt ? { agentPrompt: agent.prompt } : {}),
        instructions: agent.instructions,
        suggestedSkills: await selectRelevantSkills(
          allSkills,
          message.text,
          this.config.memory?.embedding,
          this.config.skills?.suggest,
        ),
      });
      hooks.emit("agent:prompt:built", { sessionId: session.id, model: llmConfig.model, systemPromptLength: systemPrompt.length });
      systemPrompt = (await hooks.transform("transform:system:prompt", { prompt: systemPrompt, sessionId: session.id, model: llmConfig.model })).prompt;
      systemPrompt += OWNER_STEERING_NOTE;

      // Captured before buildUserTurn, which appends the current message to the same array.
      // Without an SDK session the whole transcript is new to it; with one, only the turns that
      // landed after its watermark (a detour through the home backend) are missing.
      // An SDK session with no watermark predates this mechanism: its history is already owned by
      // the SDK, so replaying it would duplicate the entire conversation. The watermark is written
      // at the end of every run, so such a session self-heals after one turn.
      const syncedAt = session.sdkSyncedAt;
      const priorHistory = !session.sdkSessionId
        ? [...session.messages]
        : syncedAt
          ? session.messages.filter((m) => m.timestamp > syncedAt)
          : [];
      const userContent = await this.buildUserTurn(message, session);
      let initialText = await this.prefixMemory(message, userContent);
      initialText = this.withPriorConversation(initialText, priorHistory, session, systemPrompt, llmConfig, agentToolType);
      const initialContent = await this.withImageBlocks(message, initialText, Boolean(llmConfig.vision));

      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (signal?.aborted) throw new AbortedError();
      signal?.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal?.removeEventListener("abort", onAbort);

      const server = createToolServerForRun(tools, {
        message,
        session,
        depth: this.depth,
        agentType: agentToolType,
        signal,
        workspaceDir: this.workspaceFor(session).workspaceDir,
        addAttachment: (att) => this.preprocessor.addResponseAttachment(message.id, att),
        nestedAgents: nestedAgentsEnabled(this.config)
          ? new NestedAgentsCollector(
              this.workspaceFor(session).workspaceDir,
              resolveNestedAgentsMaxBytes(this.config),
            )
          : undefined,
        onToolDone: async (info) => {
          toolExecutions += 1;
          if (onToolUse) await onToolUse([info], session.verbose !== false);
        },
      });

      let finished = false;
      let finalText: string | undefined;
      let resultSubtype: string | undefined;
      let resultErrors: string[] = [];
      // Messages drained by drainOrClose at a result boundary; the generator picks them
      // up on its next tick so the run continues instead of ending.
      const lateInjections: UnifiedMessage[] = [];
      const self = this;

      async function* userMessages(): AsyncGenerator<SdkUserMessage> {
        yield { type: "user", message: { role: "user", content: initialContent }, parent_tool_use_id: null };
        while (!finished) {
          await new Promise((r) => setTimeout(r, 150));
          if (self.depth !== 0) continue;
          const drained = [...lateInjections.splice(0), ...runRegistry.drainInjections(session.id)];
          for (const injected of drained) {
            if (onTurnSwitch) await onTurnSwitch(injected);
            const text = await self.buildUserTurn(injected, session);
            const content = await self.withImageBlocks(injected, text, Boolean(llmConfig.vision));
            void log("info", "mid-run injection (claude-sdk)", { sessionId: session.id, messageId: injected.id });
            yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
          }
        }
      }

      // Typed against the real SDK Options: a key typo here is a compile error, never a
      // silently ignored setting.
      const queryOptions: SdkOptions = {
        model: llmConfig.model,
        fallbackModel: llmConfig.fallbackModel,
        effort: toSdkEffort(llmConfig.effort),
        maxTurns,
        systemPrompt,
        cwd: this.workspaceFor(session).workspaceDir,
        resume: session.sdkSessionId,
        abortController,
        includePartialMessages: streaming,
        mcpServers: { myclaw: server },
        // Hermetic subprocess: my-claw is the only source of tools and behavior.
        // See docs/claude-sdk-backend.md "Environment isolation".
        tools: [],
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        executable: "bun",
        // One-shot sub-agents never resume: skip writing their SDK session files.
        persistSession: session.id.startsWith("subagent/run-") ? false : undefined,
        stderr: (data: string) => {
          const line = data.trim();
          if (line) void log("warn", "claude-sdk cli stderr", { line: line.slice(0, 500) });
        },
        env: sdkBaseEnv(await loadClaudeToken()),
        canUseTool: async (toolName, input, canUseOpts) => {
          // The SDK aborts this signal when the run dies: without the race, an approval
          // prompt awaiting a human answer would leave the promise dangling forever.
          const aborted = new Promise<"deny">((resolve) => {
            canUseOpts?.signal?.addEventListener("abort", () => resolve("deny"), { once: true });
          });
          const decision = await Promise.race([
            this.approvalManager.decide({
              session,
              request: {
                id: canUseOpts?.toolUseID ?? `${message.id}-${toolName}-${Date.now()}`,
                platform: message.platform,
                chatId: message.chatId,
                userId: message.userId,
                chatType: message.chatType,
                messageId: message.id,
                sessionId: session.id,
                toolName: toolName.replace(/^mcp__myclaw__/, ""),
                args: input,
                replyToId: message.replyToId,
                threadId: message.threadId,
              },
            }),
            aborted,
          ]);
          hooks.emit("tool:approval:check", { toolName, sessionId: session.id, decision });
          if (decision === "deny") {
            return { behavior: "deny" as const, message: "Tool denied by approval policy" };
          }
          return { behavior: "allow" as const, updatedInput: input };
        },
      };
      const q = this.queryFn({ prompt: userMessages(), options: queryOptions });

      const seenUsageIds = new Set<string>();
      let iteration = 0;
      let lastAssistantText = "";
      let llmWindowStart = Date.now();
      let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

      try {
        for await (const msg of q) {
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            session.sdkSessionId = msg.session_id;
            continue;
          }

          // Nested-agent traffic (parent_tool_use_id set) must not leak into the channel
          // stream or the session mirror. None expected with the Agent tool disabled,
          // defense in depth.
          if (msg.parent_tool_use_id) continue;

          if (msg.type === "stream_event") {
            const delta = msg.event?.delta;
            if (onToken && msg.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
              await onToken(delta.text);
            }
            continue;
          }

          if (msg.type === "assistant" && msg.error === "authentication_failed") {
            throw new Error(AUTH_FAILURE_HINT);
          }

          if (msg.type === "assistant" && msg.message) {
            lastUsage = this.recordAssistantUsage(msg, session, message, llmConfig, streaming, seenUsageIds, () => {
              iteration += 1;
              return iteration;
            }, llmWindowStart) ?? lastUsage;
            llmWindowStart = Date.now();
            this.mirrorAssistantMessage(msg, session);
            const text = (msg.message.content ?? [])
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join("");
            if (text.trim()) lastAssistantText = text;
            continue;
          }

          if (msg.type === "user" && msg.message) {
            this.mirrorToolResults(msg, session);
            continue;
          }

          if (msg.type === "result") {
            resultSubtype = msg.subtype;
            resultErrors = msg.errors ?? [];
            if (msg.subtype === "success" && typeof msg.result === "string") {
              finalText = msg.result;
            }
            // A message that arrived during the final response keeps the run going,
            // mirroring the home loop's drainOrClose semantics (the generator will
            // yield it and the SDK starts a fresh turn in the same run).
            if (this.depth === 0 && msg.subtype === "success") {
              const pending = runRegistry.drainOrClose(session.id);
              if (pending.length > 0) {
                lateInjections.push(...pending);
                continue;
              }
            }
            finished = true;
          }
        }
      } catch (err) {
        // The SDK stream throws after yielding an error-subtype result; the result
        // branch below owns the friendly mapping in that case.
        if (!resultSubtype || resultSubtype === "success") throw err;
      } finally {
        finished = true;
      }

      if (signal?.aborted) throw new AbortedError();

      if (resultSubtype && resultSubtype !== "success") {
        if (resultSubtype === "error_max_turns") {
          hooks.emit("agent:budget:exhausted", { sessionId: session.id, iteration, maxIterations: maxTurns, toolExecutions });
          finalText = lastAssistantText.trim() || "I reached the maximum number of turns before finishing.";
        } else {
          const detail = resultErrors.length > 0 ? `: ${resultErrors.join("; ").slice(0, 500)}` : "";
          throw new Error(`claude-sdk run failed (${resultSubtype})${detail}`);
        }
      }

      let response = finalText ?? lastAssistantText;
      if (!response || !response.trim()) {
        throw new Error("claude-sdk run produced no response");
      }
      if (response.startsWith("Failed to authenticate")) {
        throw new Error(AUTH_FAILURE_HINT);
      }

      response = (await hooks.transform("transform:agent:response", { response, sessionId: session.id, model: llmConfig.model })).response;
      // The final text is already mirrored via the assistant message stream; only append
      // if the stream ended without one (defensive).
      const last = session.messages[session.messages.length - 1];
      if (!(last && last.role === "assistant" && last.content === response)) {
        session.messages.push({ role: "assistant", content: response, timestamp: new Date().toISOString() });
      }

      if (session.messages.length > MAX_SESSION_MESSAGES) {
        const beforeCount = session.messages.length;
        session.messages = trimSessionMessages(session.messages, MAX_SESSION_MESSAGES_KEEP);
        hooks.emit("session:messages:trimmed", { sessionId: session.id, beforeCount, afterCount: session.messages.length });
      }

      // Watermark what this SDK session has now seen. Turns appended after it (by the home
      // backend, if the owner switches away and back) are what the next SDK run must replay.
      session.sdkSyncedAt = session.messages[session.messages.length - 1]?.timestamp;

      const durationMs = Date.now() - startedAt;
      hooks.emit("agent:run:finish", {
        messageId: message.id,
        sessionId: session.id,
        model: llmConfig.model,
        iterations: iteration,
        toolExecutions,
        responseChars: response.length,
        durationMs,
        usage: lastUsage,
      });
      void log("info", "claude-sdk run finished", {
        sessionId: session.id,
        model: llmConfig.model,
        iterations: iteration,
        toolExecutions,
        responseChars: response.length,
        durationMs,
        sdkSessionId: session.sdkSessionId,
      });
      return response;
    } catch (err) {
      if (isAbort(err, signal)) {
        // The mirror is kept on abort, so a tool the run never got to answer would leave a
        // dangling tool_call. That is invisible here but rejected by the home backend's API the
        // moment the owner switches to a non-SDK model, wedging every later turn.
        const sealed = sealDanglingToolCalls(session.messages);
        if (sealed > 0) {
          void log("info", "sealed dangling tool calls after an aborted SDK run", { sessionId: session.id, sealed });
        }
        hooks.emit("agent:run:aborted", {
          messageId: message.id,
          sessionId: session.id,
          model: llmConfig.model,
          toolExecutions,
          durationMs: Date.now() - startedAt,
        });
        throw new AbortedError();
      }
      session.messages.length = messageCountBefore;
      // Mirror and SDK pointer roll back together: keeping a session id whose SDK-side
      // history contains the failed turn would desync the two histories.
      session.sdkSessionId = sdkSessionIdBefore;
      session.sdkSyncedAt = sdkSyncedAtBefore;
      hooks.emit("agent:run:error", {
        messageId: message.id,
        sessionId: session.id,
        model: llmConfig.model,
        toolExecutions,
        durationMs: Date.now() - startedAt,
        error: err,
      });
      void log("error", "claude-sdk run failed", {
        sessionId: session.id,
        model: llmConfig.model,
        error: errorLogData(err),
      });
      throw err;
    } finally {
      removeAbortListener?.();
      runNode?.exit();
      await this.preprocessor.cleanupTempFiles(message.id);
    }
  }

  /** Scan, transform and mirror one inbound user turn; returns the content to send. */
  /**
   * Carry a conversation that started on the home backend into a fresh SDK session. The SDK owns
   * history on its path and resumes it by id, so without this the model would see only the newest
   * message and behave as if the session were brand new.
   *
   * The whole transcript is replayed. The only bound is physical: whatever is left of the model's
   * context window once the system prompt, this turn and the reply are accounted for, so an
   * oversized history degrades to its most recent part instead of failing the request outright.
   */
  private withPriorConversation(
    text: string,
    priorHistory: SessionMessage[],
    session: SessionData,
    systemPrompt: string,
    llmConfig: ResolvedLlmConfig,
    agent: AgentToolType,
  ): string {
    if (priorHistory.length === 0) return text;

    // The cap applies here too: replaying history up to the model's full window would defeat a
    // ceiling the operator set precisely to keep prompts short.
    const contextLimit = resolveContextWindow({
      model: llmConfig.model,
      config: this.config,
      declared: llmConfig.limit?.context,
      baseUrl: llmConfig.baseUrl,
      sessionOverride: session.contextOverride,
      agent,
    }).effective;
    const outputReserve = llmConfig.limit?.output ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
    const maxTokens = contextLimit - estimateTokens(systemPrompt) - estimateTokens(text) - outputReserve;

    const rendered = renderPriorConversation(priorHistory, { maxTokens });
    if (!rendered) {
      void log("warn", "prior conversation not carried into the SDK session", {
        sessionId: session.id,
        messages: priorHistory.length,
        maxTokens,
      });
      return text;
    }

    session.contextTransfer = {
      at: new Date().toISOString(),
      messages: rendered.includedMessages,
      dropped: rendered.droppedMessages,
      tokens: rendered.tokens,
      model: llmConfig.model,
    };
    void log("info", "prior conversation carried into a new SDK session", {
      sessionId: session.id,
      ...session.contextTransfer,
    });
    hooks.emit("session:context:transferred", { sessionId: session.id, ...session.contextTransfer });

    return `${rendered.text}\n\n${text}`;
  }

  private async buildUserTurn(message: UnifiedMessage, session: SessionData): Promise<string> {
    const scanned = this.preprocessor.buildUserContent(message);
    const transformed = (await hooks.transform("transform:user:content", { content: scanned, sessionId: session.id })).content;
    session.messages.push({ role: "user", content: transformed, timestamp: new Date().toISOString() });
    return transformed;
  }

  /**
   * Inbound vision: images ride along as Anthropic base64 blocks when the resolved model
   * takes them. The preprocessor already produces data URLs for the OpenAI path; this
   * re-packs them instead of re-reading the files.
   */
  private async withImageBlocks(message: UnifiedMessage, text: string, vision: boolean): Promise<string | SdkContentBlock[]> {
    if (!vision || !message.attachments.some((a) => a.type === "image" && a.path)) return text;
    const blocks: SdkContentBlock[] = [{ type: "text", text }];
    for (const part of await this.preprocessor.buildImageContent(message)) {
      if (typeof part === "object" && part.type === "image_url") {
        const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
        const mediaType = match?.[1];
        if (!match || !mediaType) continue;
        if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
          // The API only accepts jpeg/png/gif/webp; sending anything else is a guaranteed 400.
          void log("warn", "image dropped: unsupported media type for claude-sdk", { mediaType });
          continue;
        }
        blocks.push({ type: "image", source: { type: "base64", media_type: mediaType as ImageMediaType, data: match[2]! } });
      }
    }
    return blocks.length > 1 ? blocks : text;
  }

  /** Memory lands in the outgoing turn only, never in the mirror: it must not accumulate. */
  private async prefixMemory(message: UnifiedMessage, content: string): Promise<string> {
    if (this.depth !== 0) return content;
    if (this.config.memory?.enabled === false) return content;
    try {
      const mem = await recall(message.text, this.config.memory);
      if (!mem.text) return content;
      return (
        "<memory-context>\n" +
        "Relevant long-term memory (may be outdated; verify before relying on it):\n" +
        `${mem.text}\n` +
        "</memory-context>\n\n" +
        content
      );
    } catch (err) {
      void log("warn", "memory recall failed", { error: String(err) });
      return content;
    }
  }

  private recordAssistantUsage(
    msg: SdkStreamMessage,
    session: SessionData,
    message: UnifiedMessage,
    llmConfig: ResolvedLlmConfig,
    streaming: boolean,
    seenIds: Set<string>,
    nextIteration: () => number,
    windowStart: number,
  ): SdkUsage | undefined {
    const m = msg.message;
    if (!m?.usage) return undefined;
    // Parallel tool batches share one API message id; dedupe so a call is counted once.
    const id = m.id ?? `no-id-${Date.now()}`;
    if (seenIds.has(id)) return undefined;
    seenIds.add(id);
    const cacheReadTokens = m.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = m.usage.cache_creation_input_tokens ?? 0;
    // Anthropic reports fresh input separately from the cache buckets. Summing keeps promptTokens
    // meaning "all input", the same as on the OpenAI-compatible path; the buckets are kept as
    // their own fields because they are billed at very different rates.
    const promptTokens = (m.usage.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens;
    const completionTokens = m.usage.output_tokens ?? 0;
    const usage: SdkUsage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
    if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens;
    if (cacheWriteTokens > 0) usage.cacheWriteTokens = cacheWriteTokens;
    accumulateUsage(session, usage);
    // `messages` is only a mirror on this backend (the SDK owns the real history), so the count is
    // approximate here. occupiedContextTokens floors on the plain estimate, so an off count can
    // only make the gate read high, never low.
    session.lastPrompt = measuredPrompt(promptTokens, session.messages.length) ?? session.lastPrompt;
    const toolCalls = (m.content ?? []).filter((b) => b.type === "tool_use").length;
    recordApiCall({
      sessionId: session.id,
      parentSessionId: attributionParent(session),
      platform: message.platform,
      model: llmConfig.model,
      baseUrl: "claude-sdk",
      streaming,
      caller: this.depth === 0 ? "orchestrator" : "subagent",
      promptTokens,
      completionTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      toolCalls,
      iteration: nextIteration(),
      durationMs: Date.now() - windowStart,
    });
    return usage;
  }

  private mirrorAssistantMessage(msg: SdkStreamMessage, session: SessionData): void {
    const blocks = msg.message?.content ?? [];
    const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length > 0) {
      session.messages.push({
        role: "assistant",
        content: text,
        toolCalls: toolUses.map((b) => ({
          id: b.id ?? "",
          name: b.name ?? "",
          arguments: JSON.stringify(b.input ?? {}),
        })),
        timestamp: new Date().toISOString(),
      });
    } else if (text.trim()) {
      session.messages.push({ role: "assistant", content: text, timestamp: new Date().toISOString() });
    }
  }

  private mirrorToolResults(msg: SdkStreamMessage, session: SessionData): void {
    for (const block of msg.message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      session.messages.push({
        role: "tool",
        toolCallId: block.tool_use_id ?? "",
        content: toolResultToText(block.content, Boolean((block as { is_error?: boolean }).is_error)),
        timestamp: new Date().toISOString(),
      });
    }
  }
}
