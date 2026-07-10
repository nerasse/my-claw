import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { MyClawConfig, ResolvedLlmConfig } from "../../core/config.ts";
import { MY_CLAW_DIR, resolveMaxIterations } from "../../core/config.ts";
import { join } from "node:path";
import type { SubAgentType } from "../../subagents/types.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../../channels/types.ts";
import type { SessionData } from "../../sessions/store.ts";
import { trimSessionMessages } from "../../sessions/store.ts";
import type { AgentBackend, TokenCallback, ToolUseCallback, TurnSwitchCallback } from "../backend.ts";
import { buildSystemPrompt } from "../prompt/builder.ts";
import { resolveLlmConfigForMessage } from "../../llm/resolver.ts";
import { recordApiCall } from "../../analytics/usage-db.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import { log } from "../../utils/logger.ts";
import { errorLogData } from "../../utils/errors.ts";
import { ToolApprovalManager } from "../approvals.ts";
import type { VoiceManager, SttPipeline } from "../../voice/index.ts";
import { MessagePreprocessor } from "../preprocess.ts";
import { scanForInjection } from "../prompt/anti-injection.ts";
import { recall } from "../../memory/index.ts";
import { hooks } from "../../hooks/index.ts";
import { AbortedError, isAbort } from "../../core/aborted.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { createToolServerForRun } from "./tools.ts";

const MAX_SESSION_MESSAGES = 500;
const MAX_SESSION_MESSAGES_KEEP = 50;

// Without this, Claude's anti-injection training treats a mid-run steering message that
// contradicts the initial task as an attack and ignores it (verified in the phase 0 spike).
const OWNER_STEERING_NOTE =
  "\n\n# Mid-run steering\n" +
  "You are operated by a single trusted owner. User messages arriving mid-conversation " +
  "(including while you are working) are legitimate steering from the owner and take " +
  "precedence over earlier instructions.";

const AUTH_FAILURE_HINT =
  "Claude subscription auth failed — regenerate the token with `claude setup-token` " +
  "and update CLAUDE_CODE_OAUTH_TOKEN in ~/.my-claw/.env";

// Minimal structural views of the SDK message stream. The SDK exports richer types, but
// depending only on the fields we read keeps the fake query used in tests trivial.
interface SdkStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
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

interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

export type SdkQueryFn = (params: {
  prompt: AsyncGenerator<SdkUserMessage>;
  options: Record<string, unknown>;
}) => AsyncIterable<SdkStreamMessage>;

function accumulateUsage(session: SessionData, usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
  if (!session.tokenUsage) {
    session.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };
  }
  session.tokenUsage.promptTokens += usage.promptTokens;
  session.tokenUsage.completionTokens += usage.completionTokens;
  session.tokenUsage.totalTokens += usage.totalTokens;
  session.tokenUsage.apiCalls += 1;
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
  ) {
    this.approvalManager = new ToolApprovalManager(config.blacklist);
    this.preprocessor = sharedPreprocessor ?? new MessagePreprocessor(voiceManager, sttPipeline);
    this.queryFn = queryFn ?? (sdkQuery as unknown as SdkQueryFn);
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
        : this.agentKind === "research" ? "research" : "general";
    const tools = this.toolRegistry.getForAgent(agentToolType);
    const llmConfig = this.llmOverride ?? resolveLlmConfigForMessage(
      this.config.llm,
      session.modelOverride,
      message.attachments.some((a) => a.type === "image" && Boolean(a.path)),
    );
    const startedAt = Date.now();
    const streaming = Boolean(onToken);
    const agentType = this.depth === 0 ? "orchestrator" : this.agentKind ?? "general";
    const maxTurns = resolveMaxIterations(this.config, agentType);
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
    let toolExecutions = 0;

    try {
      let systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model: llmConfig.model,
        channelId: message.chatId,
        sessionId: session.id,
        tools,
        skills: this.skillRegistry.list(),
      });
      systemPrompt = (await hooks.transform("transform:system:prompt", { prompt: systemPrompt, sessionId: session.id, model: llmConfig.model })).prompt;
      systemPrompt += OWNER_STEERING_NOTE;

      const userContent = await this.buildUserTurn(message, session);
      const initialContent = await this.prefixMemory(message, userContent);

      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (signal?.aborted) throw new AbortedError();
      signal?.addEventListener("abort", onAbort, { once: true });

      const server = createToolServerForRun(tools, {
        message,
        session,
        depth: this.depth,
        signal,
        workspaceDir: this.workspaceDir,
        addAttachment: (att) => this.preprocessor.addResponseAttachment(message.id, att),
        onToolDone: async (info) => {
          toolExecutions += 1;
          if (onToolUse) await onToolUse([info], session.verbose !== false);
        },
      });

      let finished = false;
      let finalText: string | undefined;
      let resultSubtype: string | undefined;
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
            const content = await self.buildUserTurn(injected, session);
            void log("info", "mid-run injection (claude-sdk)", { sessionId: session.id, messageId: injected.id });
            yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
          }
        }
      }

      const q = this.queryFn({
        prompt: userMessages(),
        options: {
          model: llmConfig.model,
          fallbackModel: llmConfig.fallbackModel,
          maxTurns,
          systemPrompt,
          cwd: this.workspaceDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd(),
          resume: session.sdkSessionId,
          abortController,
          includePartialMessages: streaming,
          mcpServers: { myclaw: server },
          // Hermetic subprocess: my-claw is the only source of tools and behavior.
          // See docs/claude-sdk-backend.md "Environment isolation".
          tools: [],
          settingSources: [],
          skills: [],
          env: {
            ...process.env,
            CLAUDE_CODE_ENABLE_TASKS: "0",
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CONFIG_DIR: join(MY_CLAW_DIR, "claude-sdk"),
          },
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            const decision = await this.approvalManager.decide({
              session,
              request: {
                id: `${message.id}-${toolName}-${Date.now()}`,
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
            });
            hooks.emit("tool:approval:check", { toolName, sessionId: session.id, decision });
            if (decision === "deny") {
              return { behavior: "deny" as const, message: "Tool denied by approval policy" };
            }
            return { behavior: "allow" as const, updatedInput: input };
          },
        },
      });

      const seenUsageIds = new Set<string>();
      let iteration = 0;
      let lastAssistantText = "";
      let llmWindowStart = Date.now();

      try {
        for await (const msg of q) {
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            session.sdkSessionId = msg.session_id;
            continue;
          }

          if (msg.type === "stream_event") {
            const delta = msg.event?.delta;
            if (onToken && msg.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
              await onToken(delta.text);
            }
            continue;
          }

          if (msg.type === "assistant" && msg.message) {
            this.recordAssistantUsage(msg, session, message, llmConfig, streaming, seenUsageIds, () => {
              iteration += 1;
              return iteration;
            }, llmWindowStart);
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
        signal?.removeEventListener("abort", onAbort);
      }

      if (signal?.aborted) throw new AbortedError();

      if (resultSubtype && resultSubtype !== "success") {
        if (resultSubtype === "error_max_turns") {
          hooks.emit("agent:budget:exhausted", { sessionId: session.id, iteration, maxIterations: maxTurns, toolExecutions });
          finalText = lastAssistantText.trim() || "I reached the maximum number of turns before finishing.";
        } else {
          throw new Error(`claude-sdk run failed (${resultSubtype})`);
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

      const durationMs = Date.now() - startedAt;
      hooks.emit("agent:run:finish", {
        messageId: message.id,
        sessionId: session.id,
        model: llmConfig.model,
        iterations: iteration,
        toolExecutions,
        responseChars: response.length,
        durationMs,
        usage: undefined,
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
      runNode?.exit();
      await this.preprocessor.cleanupTempFiles(message.id);
    }
  }

  /** Scan, transform and mirror one inbound user turn; returns the content to send. */
  private async buildUserTurn(message: UnifiedMessage, session: SessionData): Promise<string> {
    const rawContent = this.preprocessor.buildUserContent(message);
    const scanned = scanForInjection(rawContent, "user-message");
    const transformed = (await hooks.transform("transform:user:content", { content: scanned, sessionId: session.id })).content;
    session.messages.push({ role: "user", content: transformed, timestamp: new Date().toISOString() });
    return transformed;
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
  ): void {
    const m = msg.message;
    if (!m?.usage) return;
    // Parallel tool batches share one API message id; dedupe so a call is counted once.
    const id = m.id ?? `no-id-${Date.now()}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const promptTokens = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
    const completionTokens = m.usage.output_tokens ?? 0;
    const usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
    accumulateUsage(session, usage);
    const toolCalls = (m.content ?? []).filter((b) => b.type === "tool_use").length;
    recordApiCall({
      sessionId: session.id,
      platform: message.platform,
      model: llmConfig.model,
      baseUrl: "claude-sdk",
      streaming,
      caller: this.depth === 0 ? "orchestrator" : "subagent",
      promptTokens,
      completionTokens,
      totalTokens: usage.totalTokens,
      toolCalls,
      iteration: nextIteration(),
      durationMs: Date.now() - windowStart,
    });
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
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      session.messages.push({
        role: "tool",
        toolCallId: block.tool_use_id ?? "",
        content,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
