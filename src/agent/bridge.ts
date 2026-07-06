import type { MyClawConfig, ResolvedLlmConfig } from "../core/config.ts";
import { resolveMaxIterations, resolveInjectionBudgetBonus } from "../core/config.ts";
import type { SubAgentType } from "../subagents/types.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData, SessionMessage } from "../sessions/store.ts";
import { trimSessionMessages, dropLeadingOrphanToolMessages } from "../sessions/store.ts";
import { buildSystemPrompt } from "./prompt/builder.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage } from "../llm/provider.ts";
import { resolveLlmConfig } from "../llm/resolver.ts";
import { toOpenAiToolDefinitions, toOpenAiToolCalls } from "../llm/openai-format.ts";
import { trimToContextWindow, estimateTokens } from "../llm/tokens.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { log } from "../utils/logger.ts";
import { errorLogData } from "../utils/errors.ts";
import { ToolApprovalManager } from "./approvals.ts";
import type { VoiceManager, SttPipeline, TtsPipeline } from "../voice/index.ts";
import { MessagePreprocessor } from "./preprocess.ts";
import { IterationBudget } from "./iteration-budget.ts";
import { scanForInjection } from "./prompt/anti-injection.ts";
import { recall } from "../memory/index.ts";
import { hooks } from "../hooks/index.ts";
import { AbortedError, isAbort } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";

function accumulateUsage(session: SessionData, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
  if (!usage) return;
  if (!session.tokenUsage) {
    session.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };
  }
  session.tokenUsage.promptTokens += usage.promptTokens;
  session.tokenUsage.completionTokens += usage.completionTokens;
  session.tokenUsage.totalTokens += usage.totalTokens;
  session.tokenUsage.apiCalls += 1;
}

function runLogData(message: UnifiedMessage, session: SessionData): Record<string, unknown> {
  return {
    messageId: message.id,
    sessionId: session.id,
    platform: message.platform,
    userId: message.userId,
    chatId: message.chatId,
    chatType: message.chatType,
    threadId: message.threadId,
    attachmentCount: message.attachments.length,
    textChars: message.text.length,
  };
}


const MAX_SESSION_MESSAGES = 500;
const MAX_SESSION_MESSAGES_KEEP = 50;

// A tool result with no content confuses the model (it cannot tell "ran, nothing to show" from a
// broken tool). Every tool result is normalized to a non-empty, explicit string.
const EMPTY_TOOL_OUTPUT = "[tool returned an empty response]";

// Defense in depth: no single tool result should be able to poison the whole session context.
// Individual tools (fetch, read, ...) apply their own limits; this is the last-resort ceiling
// for any output that slips through. ~60K chars ≈ 15K tokens.
const MAX_TOOL_OUTPUT_CHARS = 60_000;

function capToolOutput(content: string): string {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
  return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[... truncated: ${content.length} chars total, ${MAX_TOOL_OUTPUT_CHARS} kept ...]`;
}

export class AgentBridge {
  private approvalManager: ToolApprovalManager;
  private preprocessor: MessagePreprocessor;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager?: VoiceManager,
    private sttPipeline?: SttPipeline,
    private ttsPipeline?: TtsPipeline,
    private depth: number = 0,
    private workspaceDir?: string,
    // Sub-agent kind and its fully-resolved LLM config. Set by SubAgentRunner so a "research"
    // sub-agent actually gets the read-only toolset + its own provider, instead of being
    // inferred from depth (depth is always 1 for sub-agents, which collapsed to "general").
    private agentKind?: SubAgentType,
    private llmOverride?: ResolvedLlmConfig,
  ) {
    this.approvalManager = new ToolApprovalManager(config.blacklist);
    this.preprocessor = new MessagePreprocessor(this.voiceManager, this.sttPipeline);
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

  async handleMessage(
    message: UnifiedMessage,
    session: SessionData,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.handle(message, session, undefined, undefined, signal);
  }

  async handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: (token: string) => Promise<void>,
    onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>,
    signal?: AbortSignal,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<string> {
    return this.handle(message, session, onToken, onToolUse, signal, onTurnSwitch);
  }

  async preprocessMessage(message: UnifiedMessage): Promise<void> {
    return this.preprocessor.preprocessMessage(message);
  }

  private async handle(
    message: UnifiedMessage,
    session: SessionData,
    onToken?: (token: string) => Promise<void>,
    onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>,
    signal?: AbortSignal,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<string> {
    await this.preprocessor.preprocessForHandle(message);

    const isCron = message.platform === "cron";
    const agentToolType = isCron
      ? "cron"
      : this.depth === 0
        ? "main"
        : this.agentKind === "research" ? "research" : "general";
    const tools = this.toolRegistry.getForAgent(agentToolType);
    const llmConfig = this.llmOverride ?? resolveLlmConfig(this.config.llm, session.modelOverride);
    const startedAt = Date.now();
    const streaming = Boolean(onToken);
    let toolExecutions = 0;

    const agentType = this.depth === 0 ? "orchestrator" : this.agentKind ?? "general";
    const cronMaxIter = this.config.cron?.maxIterations;
    const maxIterations = isCron && cronMaxIter !== undefined && Number.isFinite(cronMaxIter) && cronMaxIter > 0
      ? cronMaxIter
      : resolveMaxIterations(this.config, agentType);
    const budget = new IterationBudget(maxIterations);
    const injectionBonus = resolveInjectionBudgetBonus(this.config);

    const runLabel = this.depth === 0 ? "main" : session.meta?.displayName ?? agentType;
    const runNode = signal ? runRegistry.enter(signal, runLabel, this.depth) : undefined;

    hooks.emit("agent:run:start", {
      messageId: message.id,
      sessionId: session.id,
      model: llmConfig.model,
      streaming,
      maxIterations: budget.total,
    });

    void log("info", "agent run started", {
      ...runLogData(message, session),
      model: llmConfig.model,
      streaming,
      toolCount: tools.length,
      maxIterations: budget.total,
      sessionMessageCount: session.messages.length,
    });

    let messageCountBeforeLoop = session.messages.length;

    const gate = await hooks.check("gate:agent:before:reply", { sessionId: session.id, message });
    if (!gate.allowed) {
      return `Reply blocked by gate: ${gate.reason ?? "no reason"}`;
    }

    try {
      let systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model: llmConfig.model,
        channelId: message.chatId,
        sessionId: session.id,
        tools,
        skills: this.skillRegistry.list(),
      });
      hooks.emit("agent:prompt:built", { sessionId: session.id, model: llmConfig.model, systemPromptLength: systemPrompt.length });
      systemPrompt = (await hooks.transform("transform:system:prompt", { prompt: systemPrompt, sessionId: session.id, model: llmConfig.model })).prompt;

      const rawUserContent = this.preprocessor.buildUserContent(message);
      const userContent = scanForInjection(rawUserContent, "user-message");
      const now = new Date().toISOString();
      const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
      session.messages.push({ role: "user", content: transformedContent, timestamp: now });
      messageCountBeforeLoop = session.messages.length;

      const openaiTools = toOpenAiToolDefinitions(tools);

      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...this.toChatMessages(session.messages),
      ];

      if (this.config.llm.vision && message.attachments.some((a) => a.type === "image" && a.path)) {
        const lastIdx = chatMessages.length - 1;
        if (chatMessages[lastIdx]?.role === "user") {
          chatMessages[lastIdx] = {
            role: "user",
            content: await this.preprocessor.buildImageContent(message),
          };
        }
      }

      await this.injectMemory(message, chatMessages);

      const toolSchemaTokens = estimateTokens(JSON.stringify(openaiTools));

      let iteration = 0;
      while (budget.consume()) {
        if (signal?.aborted) throw new AbortedError();
        // Mid-run steering: pick up any message that arrived during the previous tool round and
        // append it as a user turn before the next LLM call (only the root run owns the mailbox).
        if (this.depth === 0) {
          for (const injected of runRegistry.drainInjections(session.id)) {
            budget.grant(injectionBonus);
            await this.injectUserTurn(injected, chatMessages, session, onTurnSwitch);
          }
        }
        iteration++;
        const trimmed = trimToContextWindow(chatMessages, llmConfig.limit?.context, toolSchemaTokens);
        if (trimmed !== chatMessages) {
          chatMessages.length = 0;
          chatMessages.push(...trimmed);
        }

        hooks.emit("agent:turn:start", { sessionId: session.id, model: llmConfig.model, iteration });

        const llmStartedAt = Date.now();
        hooks.emit("llm:call:start", {
          model: llmConfig.model,
          streaming,
          messageCount: chatMessages.length,
          toolCount: openaiTools.length,
          iteration,
        });

        const response = onToken
          ? await chatCompletionStream(
              llmConfig,
              chatMessages,
              onToken,
              openaiTools.length > 0 ? openaiTools : undefined,
              signal,
            )
          : await chatCompletion(
              llmConfig,
              chatMessages,
              openaiTools.length > 0 ? openaiTools : undefined,
              signal,
            );
        const llmDurationMs = Date.now() - llmStartedAt;

        hooks.emit("llm:call:end", {
          model: llmConfig.model,
          streaming,
          durationMs: llmDurationMs,
          usage: response.usage,
          toolCallCount: response.toolCalls?.length ?? 0,
        });

        accumulateUsage(session, response.usage);
        recordApiCall({
          sessionId: session.id,
          platform: message.platform,
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          streaming,
          caller: this.depth === 0 ? "orchestrator" : "subagent",
          promptTokens: response.usage?.promptTokens ?? 0,
          completionTokens: response.usage?.completionTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
          toolCalls: response.toolCalls?.length ?? 0,
          iteration,
          durationMs: llmDurationMs,
        });

        hooks.emit("agent:turn:end", { sessionId: session.id, model: llmConfig.model, iteration, hasToolCalls: Boolean(response.toolCalls?.length) });

        if (!response.toolCalls?.length) {
          const transformedResponse = (await hooks.transform("transform:agent:response", { response: response.content, sessionId: session.id, model: llmConfig.model })).response;
          session.messages.push({ role: "assistant", content: transformedResponse, timestamp: new Date().toISOString() });

          // Mid-run steering: a message that arrived during this final call keeps the run going
          // (drainOrClose atomically closes the mailbox when nothing is pending, so late arrivals
          // after this point fall back to a fresh run instead of being lost).
          if (this.depth === 0) {
            const injected = runRegistry.drainOrClose(session.id);
            if (injected.length > 0) {
              chatMessages.push({ role: "assistant", content: transformedResponse });
              for (const m of injected) {
                budget.grant(injectionBonus);
                await this.injectUserTurn(m, chatMessages, session, onTurnSwitch);
              }
              continue;
            }
          }

          const durationMs = Date.now() - startedAt;
          hooks.emit("agent:run:finish", {
            messageId: message.id,
            sessionId: session.id,
            model: llmConfig.model,
            iterations: iteration,
            toolExecutions,
            responseChars: transformedResponse.length,
            durationMs,
            usage: response.usage,
          });
          void log("info", "agent run finished", {
            ...runLogData(message, session),
            model: llmConfig.model,
            streaming,
            iteration,
            toolExecutions,
            maxIterations: budget.total,
            responseChars: transformedResponse.length,
            sessionMessageCount: session.messages.length,
            durationMs,
            usage: response.usage,
            sessionTokenUsage: session.tokenUsage,
          });
          if (session.messages.length > MAX_SESSION_MESSAGES) {
            const beforeCount = session.messages.length;
            session.messages = trimSessionMessages(session.messages, MAX_SESSION_MESSAGES_KEEP);
            hooks.emit("session:messages:trimmed", { sessionId: session.id, beforeCount, afterCount: session.messages.length });
          }
          return transformedResponse;
        }

        void log("info", "agent requested tool calls", {
          ...runLogData(message, session),
          model: llmConfig.model,
          iteration,
          toolCallCount: response.toolCalls.length,
          tools: response.toolCalls.map((tc) => tc.name),
          budgetUsed: budget.total - budget.remaining,
          budgetRemaining: budget.remaining,
        });

        const assistantToolCalls = toOpenAiToolCalls(response.toolCalls);

        chatMessages.push({
          role: "assistant",
          content: response.content,
          tool_calls: assistantToolCalls,
        });

        session.messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: assistantToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
          timestamp: new Date().toISOString(),
        });

        const executeOne = async (tc: typeof response.toolCalls[number]) => {
          const toolGate = await hooks.check("gate:tool:before", {
            toolName: tc.name,
            args: tc.arguments,
            sessionId: session.id,
          });
          if (!toolGate.allowed) {
            hooks.emit("tool:execute:end", {
              toolName: tc.name,
              toolCallId: tc.id,
              sessionId: session.id,
              success: false,
              outputChars: 0,
              durationMs: 0,
            });
            return { tc, result: { content: `Error: tool blocked by gate: ${toolGate.reason ?? "no reason"}`, success: false }, durationMs: 0 };
          }

          const toolStartedAt = Date.now();
          hooks.emit("tool:execute:start", {
            toolName: tc.name,
            toolCallId: tc.id,
            sessionId: session.id,
            iteration,
            args: tc.arguments,
          });
          void log("info", "tool execution started", {
            ...runLogData(message, session),
            model: llmConfig.model,
            iteration,
            toolCallId: tc.id,
            tool: tc.name,
            argKeys: Object.keys(tc.arguments),
          });

          const result = await this.executeTool({
            name: tc.name,
            args: tc.arguments,
            message,
            session,
            toolCallId: tc.id,
            signal,
          });

          const durationMs = Date.now() - toolStartedAt;

          if (result.success) {
            hooks.emit("tool:execute:end", {
              toolName: tc.name,
              toolCallId: tc.id,
              sessionId: session.id,
              success: true,
              outputChars: result.content.length,
              durationMs,
            });
          } else {
            hooks.emit("tool:execute:error", {
              toolName: tc.name,
              toolCallId: tc.id,
              sessionId: session.id,
              error: new Error(result.content),
              durationMs,
            });
          }

          void log(result.success ? "info" : "warn", "tool execution finished", {
            ...runLogData(message, session),
            model: llmConfig.model,
            iteration,
            toolCallId: tc.id,
            tool: tc.name,
            success: result.success,
            outputChars: result.content.length,
            durationMs,
          });

          return { tc, result, durationMs };
        };

        const settled = response.toolCalls.length > 1
          ? await Promise.all(response.toolCalls.map(executeOne))
          : [await executeOne(response.toolCalls[0]!)];

        const toolResults: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }> = [];
        for (const { tc, result, durationMs } of settled) {
          toolExecutions += 1;
          toolResults.push({ name: tc.name, arguments: tc.arguments, durationMs });
          const transformedResult = (await hooks.transform("transform:tool:result", {
            toolName: tc.name,
            result: result.content,
            sessionId: session.id,
            toolCallId: tc.id,
          })).result;
          chatMessages.push({ role: "tool", tool_call_id: tc.id, content: transformedResult });
          session.messages.push({ role: "tool", toolCallId: tc.id, content: transformedResult, timestamp: new Date().toISOString() });
        }

        if (onToolUse) {
          await onToolUse(toolResults, session.verbose !== false);
        }
      }

      if (session.messages.length > MAX_SESSION_MESSAGES) {
        const beforeCount = session.messages.length;
        session.messages = trimSessionMessages(session.messages, MAX_SESSION_MESSAGES_KEEP);
        hooks.emit("session:messages:trimmed", { sessionId: session.id, beforeCount, afterCount: session.messages.length });
      }
      hooks.emit("agent:budget:exhausted", {
        sessionId: session.id,
        iteration,
        maxIterations: budget.total,
        toolExecutions,
      });
      return await this.handleMaxIterations(chatMessages, session, message, llmConfig, startedAt, toolExecutions, iteration, budget, signal);
    } catch (err) {
      if (isAbort(err, signal)) {
        this.sealDanglingToolCalls(session);
        hooks.emit("agent:run:aborted", {
          messageId: message.id,
          sessionId: session.id,
          model: llmConfig.model,
          toolExecutions,
          durationMs: Date.now() - startedAt,
        });
        void log("info", "agent run aborted", {
          ...runLogData(message, session),
          model: llmConfig.model,
          streaming,
          toolExecutions,
          durationMs: Date.now() - startedAt,
        });
        throw new AbortedError();
      }
      session.messages.length = messageCountBeforeLoop;
      hooks.emit("agent:run:error", {
        messageId: message.id,
        sessionId: session.id,
        model: llmConfig.model,
        toolExecutions,
        durationMs: Date.now() - startedAt,
        error: err,
      });
      void log("error", "agent run failed", {
        ...runLogData(message, session),
        model: llmConfig.model,
        streaming,
        toolExecutions,
        durationMs: Date.now() - startedAt,
        error: errorLogData(err),
      });
      throw err;
    } finally {
      runNode?.exit();
      await this.preprocessor.cleanupTempFiles(message.id);
    }
  }

  /**
   * Append a mid-run injected message as a fresh user turn (text + media), mirroring how the
   * initial message is built. STT/video preprocessing already ran before routing, so we only
   * rebuild the content here. The next LLM call sees it.
   */
  private async injectUserTurn(
    injected: UnifiedMessage,
    chatMessages: ChatMessage[],
    session: SessionData,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<void> {
    if (onTurnSwitch) await onTurnSwitch(injected);

    const rawUserContent = this.preprocessor.buildUserContent(injected);
    const userContent = scanForInjection(rawUserContent, "user-message");
    const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
    session.messages.push({ role: "user", content: transformedContent, timestamp: new Date().toISOString() });

    if (this.config.llm.vision && injected.attachments.some((a) => a.type === "image" && a.path)) {
      chatMessages.push({ role: "user", content: await this.preprocessor.buildImageContent(injected) });
    } else {
      chatMessages.push({ role: "user", content: transformedContent });
    }

    void log("info", "mid-run injection", { sessionId: session.id, messageId: injected.id, textChars: injected.text.length });
  }

  /**
   * On abort we keep the full history but guarantee no assistant tool_call is left without a
   * tool response (which would break the next turn's API call). Appends a synthetic result for
   * any dangling tool_call id in the last assistant message.
   */
  private sealDanglingToolCalls(session: SessionData): void {
    let lastAssistantIdx = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i]!.role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return;
    const assistant = session.messages[lastAssistantIdx]!;
    if (assistant.role !== "assistant" || !assistant.toolCalls?.length) return;
    const toolCalls = assistant.toolCalls;

    const answered = new Set<string>();
    for (let i = lastAssistantIdx + 1; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      if (msg.role === "tool" && msg.toolCallId) answered.add(msg.toolCallId);
    }
    for (const tc of toolCalls) {
      if (!answered.has(tc.id)) {
        session.messages.push({ role: "tool", toolCallId: tc.id, content: "[Stopped by user]", timestamp: new Date().toISOString() });
      }
    }
  }

  private async handleMaxIterations(
    chatMessages: ChatMessage[],
    session: SessionData,
    message: UnifiedMessage,
    llmConfig: ReturnType<typeof resolveLlmConfig>,
    startedAt: number,
    toolExecutions: number,
    iteration: number,
    budget: IterationBudget,
    signal?: AbortSignal,
  ): Promise<string> {
    const summaryPrompt =
      "You've reached the maximum number of tool-calling iterations allowed. " +
      "Please provide a final response summarizing what you've found and accomplished so far, " +
      "without calling any more tools.";

    chatMessages.push({ role: "system", content: summaryPrompt });
    session.messages.push({ role: "user", content: `[system: ${summaryPrompt}]`, timestamp: new Date().toISOString() });

    const trimmed = trimToContextWindow(chatMessages, llmConfig.limit?.context);
    if (trimmed !== chatMessages) {
      chatMessages.length = 0;
      chatMessages.push(...trimmed);
    }

    void log("warn", "agent run requesting summary after iteration limit", {
      ...runLogData(message, session),
      model: llmConfig.model,
      iteration,
      toolExecutions,
      maxIterations: budget.total,
      durationMs: Date.now() - startedAt,
    });

    hooks.emit("llm:call:start", {
      model: llmConfig.model,
      streaming: false,
      messageCount: chatMessages.length,
      toolCount: 0,
      iteration: iteration + 1,
    });

    const summaryStartedAt = Date.now();
    const summaryResponse = await chatCompletion(llmConfig, chatMessages, undefined, signal);
    const summaryDurationMs = Date.now() - summaryStartedAt;

    hooks.emit("llm:call:end", {
      model: llmConfig.model,
      streaming: false,
      durationMs: summaryDurationMs,
      usage: summaryResponse.usage,
      toolCallCount: 0,
    });

    accumulateUsage(session, summaryResponse.usage);
    recordApiCall({
      sessionId: session.id,
      platform: message.platform,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      streaming: false,
      caller: this.depth === 0 ? "orchestrator" : "subagent",
      promptTokens: summaryResponse.usage?.promptTokens ?? 0,
      completionTokens: summaryResponse.usage?.completionTokens ?? 0,
      totalTokens: summaryResponse.usage?.totalTokens ?? 0,
      toolCalls: 0,
      iteration: iteration + 1,
      durationMs: summaryDurationMs,
    });

    const rawFinalText = summaryResponse.content.trim() || "I reached the iteration limit and couldn't generate a summary.";
    const finalText = (await hooks.transform("transform:agent:response", { response: rawFinalText, sessionId: session.id, model: llmConfig.model })).response;

    session.messages.push({ role: "assistant", content: finalText, timestamp: new Date().toISOString() });

    const durationMs = Date.now() - startedAt;
    hooks.emit("agent:run:finish", {
      messageId: message.id,
      sessionId: session.id,
      model: llmConfig.model,
      iterations: iteration + 1,
      toolExecutions,
      responseChars: finalText.length,
      durationMs,
      usage: summaryResponse.usage,
    });

    void log("info", "agent run finished with summary", {
      ...runLogData(message, session),
      model: llmConfig.model,
      iteration,
      toolExecutions,
      maxIterations: budget.total,
      responseChars: finalText.length,
      durationMs,
    });

    return finalText;
  }

  /**
   * Inject relevant long-term memory into the current turn only (not session history),
   * so it never accumulates and stays out of cached prefixes. Main agent only.
   */
  private async injectMemory(message: UnifiedMessage, chatMessages: ChatMessage[]): Promise<void> {
    if (this.depth !== 0) return;
    if (this.config.memory?.enabled === false) return;
    try {
      const mem = await recall(message.text, this.config.memory);
      if (!mem.text) return;
      const block =
        "<memory-context>\n" +
        "Relevant long-term memory (may be outdated; verify before relying on it):\n" +
        `${mem.text}\n` +
        "</memory-context>";
      const lastIdx = chatMessages.length - 1;
      const last = chatMessages[lastIdx];
      if (!last || last.role !== "user") return;
      if (typeof last.content === "string") {
        chatMessages[lastIdx] = { role: "user", content: `${block}\n\n${last.content}` };
      } else {
        chatMessages[lastIdx] = { role: "user", content: [{ type: "text", text: block }, ...last.content] };
      }
    } catch (err) {
      void log("warn", "memory recall failed", { error: String(err) });
    }
  }

  private async executeTool(params: {
    name: string;
    args: Record<string, unknown>;
    message: UnifiedMessage;
    session: SessionData;
    toolCallId: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; success: boolean }> {
    if (params.signal?.aborted) throw new AbortedError();
    const tool = this.toolRegistry.get(params.name);
    if (!tool) {
      return {
        success: false,
        content: `Error: unknown tool "${params.name}"`,
      };
    }

    const approvalDecision = await this.approvalManager.decide({
      session: params.session,
      request: {
        id: params.toolCallId,
        platform: params.message.platform,
        chatId: params.message.chatId,
        userId: params.message.userId,
        chatType: params.message.chatType,
        messageId: params.message.id,
        sessionId: params.session.id,
        toolName: params.name,
        args: params.args,
        replyToId: params.message.replyToId,
        threadId: params.message.threadId,
      },
    });
    hooks.emit("tool:approval:check", { toolName: params.name, sessionId: params.session.id, decision: approvalDecision });
    if (approvalDecision === "deny") {
      return {
        success: false,
        content: `Error: tool "${params.name}" was denied by approval policy`,
      };
    }

    try {
      const enrichedArgs = {
        ...params.args,
        __depth: this.depth,
        __message: params.message,
        __workspaceDir: this.workspaceDir,
        __signal: params.signal,
      };
      const result = await tool.execute(enrichedArgs);
      if (params.signal?.aborted) throw new AbortedError();
      if (result.attachments?.length) {
        for (const att of result.attachments) {
          this.preprocessor.addResponseAttachment(params.message.id, att);
        }
      }
      if (result.success) {
        return {
          success: true,
          content: capToolOutput(result.output.trim().length > 0 ? result.output : EMPTY_TOOL_OUTPUT),
        };
      }
      const detail = (result.error ?? result.output).trim();
      return {
        success: false,
        content: capToolOutput(`Error: ${detail.length > 0 ? detail : "tool failed with no message"}`),
      };
    } catch (err) {
      if (isAbort(err, params.signal)) throw new AbortedError();
      void log("error", "tool execution failed", { tool: params.name, error: errorLogData(err) });
      return {
        success: false,
        content: `Error: ${String(err)}`,
      };
    }
  }

  private toChatMessages(messages: SessionMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];

    // Defense in depth: a session loaded from disk (or compacted elsewhere) may start with
    // orphan tool messages; emitting them verbatim makes the LLM API reject the whole request.
    for (const msg of dropLeadingOrphanToolMessages(messages)) {
      switch (msg.role) {
        case "user":
          out.push({ role: "user", content: msg.content });
          break;
        case "assistant":
          if (msg.toolCalls?.length) {
            out.push({
              role: "assistant",
              content: msg.content,
              tool_calls: toOpenAiToolCalls(msg.toolCalls),
            });
          } else {
            out.push({ role: "assistant", content: msg.content });
          }
          break;
        case "tool":
          out.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.content });
          break;
      }
    }

    return out;
  }
}
