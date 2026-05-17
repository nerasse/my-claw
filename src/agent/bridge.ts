import type { MyClawConfig } from "../core/config.ts";
import { resolveMaxIterations } from "../core/config.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData, SessionMessage } from "../sessions/store.ts";
import { buildSystemPrompt } from "./prompt/builder.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage } from "../llm/provider.ts";
import { resolveLlmConfig } from "../llm/resolver.ts";
import { toOpenAiToolDefinitions, toOpenAiToolCalls } from "../llm/openai-format.ts";
import { trimToContextWindow, estimateTokens } from "../llm/tokens.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { log } from "../utils/logger.ts";
import { ToolApprovalManager } from "./approvals.ts";
import type { VoiceManager, SttPipeline, TtsPipeline } from "../voice/index.ts";
import { MessagePreprocessor } from "./preprocess.ts";
import { IterationBudget } from "./iteration-budget.ts";
import { scanForInjection } from "./prompt/anti-injection.ts";

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

function errorLogData(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return String(err);
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
  ) {
    this.approvalManager = new ToolApprovalManager(config.blacklist);
    this.preprocessor = new MessagePreprocessor(this.voiceManager!, this.sttPipeline!);
  }

  getEchoMessages(): OutgoingMessage[] {
    return this.preprocessor.consumeEchoMessages();
  }

  getResponseAttachments(): OutgoingMessage["attachments"] {
    return this.preprocessor.consumeResponseAttachments();
  }

  hadAudioInbound(): boolean {
    return this.preprocessor.inboundHadAudio;
  }

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.approvalManager.setHandler(handler);
  }

  async handleMessage(
    message: UnifiedMessage,
    session: SessionData,
  ): Promise<string> {
    return this.handle(message, session);
  }

  async handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: (token: string) => Promise<void>,
    onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>,
  ): Promise<string> {
    return this.handle(message, session, onToken, onToolUse);
  }

  async preprocessMessage(message: UnifiedMessage): Promise<void> {
    return this.preprocessor.preprocessMessage(message);
  }

  private async handle(
    message: UnifiedMessage,
    session: SessionData,
    onToken?: (token: string) => Promise<void>,
    onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>,
  ): Promise<string> {
    await this.preprocessor.preprocessForHandle(message);

    const tools = this.toolRegistry.getForAgent(this.depth === 0 ? "main" : this.depth === 1 ? "general" : "research");
    const llmConfig = resolveLlmConfig(this.config.llm, session.modelOverride);
    const startedAt = Date.now();
    const streaming = Boolean(onToken);
    let toolExecutions = 0;

    const agentType = this.depth === 0 ? "orchestrator" : this.depth === 1 ? "general" : "research";
    const budget = new IterationBudget(resolveMaxIterations(this.config, agentType));

    void log("info", "agent run started", {
      ...runLogData(message, session),
      model: llmConfig.model,
      streaming,
      toolCount: tools.length,
      maxIterations: budget.total,
      sessionMessageCount: session.messages.length,
    });

    try {
      const systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model: llmConfig.model,
        channelId: message.chatId,
        sessionId: session.id,
        tools,
        skills: this.skillRegistry.list(),
      });

      const rawUserContent = this.preprocessor.buildUserContent(message);
      const userContent = scanForInjection(rawUserContent, "user-message");
      const now = new Date().toISOString();
      session.messages.push({ role: "user", content: userContent, timestamp: now });

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

      const toolSchemaTokens = estimateTokens(JSON.stringify(openaiTools));

      let iteration = 0;
      while (budget.consume()) {
        iteration++;
        const trimmed = trimToContextWindow(chatMessages, llmConfig.limit?.context, toolSchemaTokens);
        if (trimmed !== chatMessages) {
          chatMessages.length = 0;
          chatMessages.push(...trimmed);
        }

        const llmStartedAt = Date.now();
        const response = onToken
          ? await chatCompletionStream(
              llmConfig,
              chatMessages,
              onToken,
              openaiTools.length > 0 ? openaiTools : undefined,
            )
          : await chatCompletion(
              llmConfig,
              chatMessages,
              openaiTools.length > 0 ? openaiTools : undefined,
            );
        const llmDurationMs = Date.now() - llmStartedAt;

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

        if (!response.toolCalls?.length) {
          session.messages.push({ role: "assistant", content: response.content, timestamp: new Date().toISOString() });
          void log("info", "agent run finished", {
            ...runLogData(message, session),
            model: llmConfig.model,
            streaming,
            iteration,
            toolExecutions,
            maxIterations: budget.total,
            responseChars: response.content.length,
            sessionMessageCount: session.messages.length,
            durationMs: Date.now() - startedAt,
            usage: response.usage,
            sessionTokenUsage: session.tokenUsage,
          });
          return response.content;
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
          const toolStartedAt = Date.now();
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
          });

          const durationMs = Date.now() - toolStartedAt;

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
          chatMessages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
          session.messages.push({ role: "tool", toolCallId: tc.id, content: result.content, timestamp: new Date().toISOString() });
        }

        if (onToolUse) {
          await onToolUse(toolResults, session.verbose !== false);
        }
      }

      return await this.handleMaxIterations(chatMessages, session, message, llmConfig, startedAt, toolExecutions, iteration, budget);
    } catch (err) {
      void log("error", "agent run failed", {
        ...runLogData(message, session),
        model: llmConfig.model,
        streaming,
        toolExecutions,
        durationMs: Date.now() - startedAt,
        error: errorLogData(err),
      });
      throw err;
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

    const summaryStartedAt = Date.now();
    const summaryResponse = await chatCompletion(llmConfig, chatMessages);
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
      durationMs: Date.now() - summaryStartedAt,
    });

    const finalText = summaryResponse.content.trim() || "I reached the iteration limit and couldn't generate a summary.";

    session.messages.push({ role: "assistant", content: finalText, timestamp: new Date().toISOString() });

    void log("info", "agent run finished with summary", {
      ...runLogData(message, session),
      model: llmConfig.model,
      iteration,
      toolExecutions,
      maxIterations: budget.total,
      responseChars: finalText.length,
      durationMs: Date.now() - startedAt,
    });

    return finalText;
  }

  private async executeTool(params: {
    name: string;
    args: Record<string, unknown>;
    message: UnifiedMessage;
    session: SessionData;
    toolCallId: string;
  }): Promise<{ content: string; success: boolean }> {
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
      };
      const result = await tool.execute(enrichedArgs);
      if (result.attachments?.length) {
        for (const att of result.attachments) {
          this.preprocessor.addResponseAttachment(att);
        }
      }
      if (result.success) {
        return {
          success: true,
          content: result.output,
        };
      }
      return {
        success: false,
        content: `Error: ${result.error ?? result.output}`,
      };
    } catch (err) {
      void log("error", "tool execution failed", { tool: params.name, error: errorLogData(err) });
      return {
        success: false,
        content: `Error: ${String(err)}`,
      };
    }
  }

  private toChatMessages(messages: SessionMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];

    for (const msg of messages) {
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
