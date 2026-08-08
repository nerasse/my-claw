import type { AgentToolType, MyClawConfig, ResolvedLlmConfig } from "../core/config.ts";
import { resolveWorkspaceKey } from "../core/config.ts";
import {
  resolveInjectionBudgetBonus,
  nestedAgentsEnabled,
  resolveNestedAgentsMaxBytes,
  contextPruningEnabled,
  resolveContextPruning,
  autoCompactEnabled,
  resolveAutoCompactThreshold,
} from "../core/config.ts";
import type { SubAgentType } from "../subagents/types.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData, SessionMessage, SessionAttachment } from "../sessions/store.ts";
import { trimSessionMessages, dropLeadingOrphanToolMessages, sealDanglingToolCalls, attributionParent } from "../sessions/store.ts";
import { buildSystemPrompt } from "./prompt/builder.ts";
import { selectRelevantSkills } from "../skills/retrieval.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage, type LlmResponse, type LlmUsage } from "../llm/provider.ts";
import { codexResponse, codexResponseStream } from "../llm/codex.ts";
import { resolveLlmConfigForAgentMessage } from "../llm/resolver.ts";
import { toOpenAiToolDefinitions, toOpenAiToolCalls } from "../llm/openai-format.ts";
import { trimToContextWindow, estimateTokens } from "../llm/tokens.ts";
import { resolveContextWindow, occupiedContextTokens, measuredPrompt } from "../llm/context-window.ts";
import { pruneOldToolResults } from "./context-pruning.ts";
import type { ToolCallResult } from "./tool-status.ts";
import { compactSession } from "../sessions/compaction.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { log } from "../utils/logger.ts";
import { errorLogData } from "../utils/errors.ts";
import { ToolApprovalManager } from "./approvals.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";
import { MessagePreprocessor, imageContentFrom } from "./preprocess.ts";
import { IterationBudget } from "./iteration-budget.ts";
import { NestedAgentsCollector } from "./prompt/nested-agents.ts";
import { recall } from "../memory/index.ts";
import { hooks } from "../hooks/index.ts";
import { AbortedError, isAbort } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";
import type { AgentBackend, TokenCallback, ToolUseCallback, TurnSwitchCallback } from "./backend.ts";
import { producesRemoteContent } from "../tools/registry.ts";
import { normalizeUntrusted } from "./prompt/normalize-untrusted.ts";

// The home loop is provider-agnostic except for these two transport calls: codex-backed models
// speak the OpenAI Responses API (docs/codex-backend.md), everything else chat/completions. Both
// share the ChatMessage[] in / LlmResponse out contract so the loop is untouched.
function completeStream(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return config.backend === "codex"
    ? codexResponseStream(config, messages, onToken, tools, signal)
    : chatCompletionStream(config, messages, onToken, tools, signal);
}

function complete(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return config.backend === "codex"
    ? codexResponse(config, messages, tools, signal)
    : chatCompletion(config, messages, tools, signal);
}

function accumulateUsage(session: SessionData, usage?: LlmUsage, historyLength?: number): void {
  if (!usage) return;
  // The billed prompt size, tied to the history it covered, so the compaction gate can stop
  // guessing it from chars/4. See docs/context-window.md.
  if (historyLength !== undefined) {
    session.lastPrompt = measuredPrompt(usage.promptTokens, historyLength) ?? session.lastPrompt;
  }
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

// How many of the most recent images ride along with every request. They are resent on each
// turn, so this is a per-turn tax, not a one-off: a photo is worth ~1-2K tokens.
const MAX_HISTORY_IMAGES = 4;

/** Images the channel resolved for this turn, in the shape the session keeps. */
function imageAttachmentsOf(message: UnifiedMessage): SessionAttachment[] {
  return message.attachments
    .filter((a) => a.type === "image" && a.path)
    .map((a) => ({ type: "image" as const, path: a.path!, ...(a.mimeType ? { mimeType: a.mimeType } : {}) }));
}

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

export class AgentBridge implements AgentBackend {
  private approvalManager: ToolApprovalManager;
  private preprocessor: MessagePreprocessor;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager?: VoiceManager,
    private sttPipeline?: SttPipeline,
    private depth: number = 0,
    private workspaceDir?: string,
    // Sub-agent kind and its fully-resolved LLM config. Set by SubAgentRunner so a "research"
    // sub-agent actually gets the read-only toolset + its own provider, instead of being
    // inferred from depth (depth is always 1 for sub-agents, which collapsed to "general").
    private agentKind?: SubAgentType,
    private llmOverride?: ResolvedLlmConfig,
    // Injected by the dispatcher so both backends share one echo/attachment store; a
    // preprocessed message must be retrievable no matter which backend runs it.
    sharedPreprocessor?: MessagePreprocessor,
    // File-defined agents. Optional and last: absent resolves to the same baselines this had
    // before agents could come from a file, which keeps every existing caller honest.
    private agentRegistry?: AgentRegistry,
  ) {
    this.approvalManager = new ToolApprovalManager(config.blacklist);
    this.preprocessor = sharedPreprocessor ?? new MessagePreprocessor(this.voiceManager, this.sttPipeline);
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

  /** Run-local (never persisted to session): tracks which nested AGENTS.md were already
   *  injected this run and the byte budget spent, so each file lands at most once. */
  private nestedAgentsCollectorFor(session: SessionData): NestedAgentsCollector | undefined {
    if (!nestedAgentsEnabled(this.config)) return undefined;
    return new NestedAgentsCollector(
      this.workspaceFor(session).workspaceDir,
      resolveNestedAgentsMaxBytes(this.config),
    );
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
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
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
    onToolUse?: (tools: ToolCallResult[], verbose: boolean) => Promise<void>,
    signal?: AbortSignal,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<string> {
    await this.preprocessor.preprocessForHandle(message);

    const isCron = message.platform === "cron";
    const agentToolType = isCron
      ? "cron"
      : this.depth === 0
        ? "main"
        : this.agentKind ?? "general";
    const agent = resolveAgent(this.config, this.agentRegistry, agentToolType, session.workspace, session.scopeOverride);
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
    let toolExecutions = 0;

    const agentType = this.depth === 0 ? "orchestrator" : this.agentKind ?? "general";
    const cronMaxIter = this.config.cron?.maxIterations;
    const maxIterations = isCron && cronMaxIter !== undefined && Number.isFinite(cronMaxIter) && cronMaxIter > 0
      ? cronMaxIter
      : agent.maxIterations;
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

    // Run-local (never persisted to session): tracks which nested AGENTS.md were already
    // injected this run and the byte budget spent, so each file lands at most once.
    const nestedAgents = this.nestedAgentsCollectorFor(session);

    const gate = await hooks.check("gate:agent:before:reply", { sessionId: session.id, message });
    if (!gate.allowed) {
      return `Reply blocked by gate: ${gate.reason ?? "no reason"}`;
    }

    try {
      // Run start is the only moment the session is guaranteed idle: compacting mid-run
      // would race the tool loop, compacting post-run would race the next inbound message.
      if (this.depth === 0 && !isCron && autoCompactEnabled(this.config)) {
        await this.maybeAutoCompact(session, llmConfig, agentToolType);
      }

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

      const userContent = this.preprocessor.buildUserContent(message);
      const now = new Date().toISOString();
      const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
      const images = imageAttachmentsOf(message);
      session.messages.push({
        role: "user",
        content: transformedContent,
        timestamp: now,
        ...(images.length > 0 ? { attachments: images } : {}),
      });
      messageCountBeforeLoop = session.messages.length;

      const openaiTools = toOpenAiToolDefinitions(tools);

      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...this.toChatMessages(session.messages),
      ];

      // Vision is resolved per model (resolver merges the model entry over the global flag):
      // the global default may be a text-only model while another configured model has vision.
      if (llmConfig.vision) {
        const attached = await this.attachImages(chatMessages, session.messages);
        if (attached > 0) void log("debug", "images attached to the prompt", { sessionId: session.id, model: llmConfig.model, images: attached });
      } else if (imageAttachmentsOf(message).length > 0) {
        void log("warn", "image dropped: the resolved model has no vision", { sessionId: session.id, model: llmConfig.model });
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
            await this.injectUserTurn(injected, chatMessages, session, Boolean(llmConfig.vision), onTurnSwitch);
          }
        }
        iteration++;
        // Prompt-side only: session.messages keeps the full outputs. Re-applied every
        // iteration so the protected window slides along long runs.
        if (contextPruningEnabled(this.config)) {
          const pruned = pruneOldToolResults(chatMessages, resolveContextPruning(this.config));
          if (pruned !== chatMessages) {
            chatMessages.length = 0;
            chatMessages.push(...pruned);
          }
        }
        const trimmed = trimToContextWindow(chatMessages, this.contextWindow(session, llmConfig, agentToolType).effective, toolSchemaTokens);
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
          ? await completeStream(
              llmConfig,
              chatMessages,
              onToken,
              openaiTools.length > 0 ? openaiTools : undefined,
              signal,
            )
          : await complete(
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

          accumulateUsage(session, response.usage, session.messages.length);
          recordApiCall({
          sessionId: session.id,
          parentSessionId: attributionParent(session),
          platform: message.platform,
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          streaming,
          caller: this.depth === 0 ? "orchestrator" : "subagent",
          promptTokens: response.usage?.promptTokens ?? 0,
          completionTokens: response.usage?.completionTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
          cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
          toolCalls: response.toolCalls?.length ?? 0,
          iteration,
          durationMs: llmDurationMs,
          proxyCostUsd: response.proxyCostUsd,
          upstreamApiBase: response.upstreamApiBase,
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
                await this.injectUserTurn(m, chatMessages, session, Boolean(llmConfig.vision), onTurnSwitch);
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

        // Kept as a reference so the tool durations measured below can be written back into the
        // persisted message: history renderers (app bubbles) show the same detail as the
        // live stream only if the timings survive the session file.
        const persistedAssistant = {
          role: "assistant" as const,
          content: response.content,
          toolCalls: assistantToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
          timestamp: new Date().toISOString(),
        };
        session.messages.push(persistedAssistant);

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
            agentType: agentToolType,
            available: tools,
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

        const toolResults: ToolCallResult[] = [];
        for (const { tc, result, durationMs } of settled) {
          toolExecutions += 1;
          const persistedCall = persistedAssistant.toolCalls.find((call) => call.id === tc.id);
          if (persistedCall) {
            (persistedCall as { durationMs?: number }).durationMs = durationMs;
          }
          let transformedResult = (await hooks.transform("transform:tool:result", {
            toolName: tc.name,
            result: result.content,
            sessionId: session.id,
            toolCallId: tc.id,
          })).result;
          if (producesRemoteContent(tc.name)) {
            transformedResult = normalizeUntrusted(transformedResult, `tool-result:${tc.name}`);
          }
          // Captured before the nested AGENTS.md injection: that text is prompt plumbing, not
          // something a tool card should show.
          toolResults.push({ name: tc.name, arguments: tc.arguments, durationMs, output: transformedResult, ok: result.success });
          if (nestedAgents) {
            transformedResult += nestedAgents.collect(tc.name, tc.arguments);
          }
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
      return await this.handleMaxIterations(chatMessages, session, message, llmConfig, agentToolType, startedAt, toolExecutions, iteration, budget, signal);
    } catch (err) {
      if (isAbort(err, signal)) {
        sealDanglingToolCalls(session.messages);
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
    vision: boolean,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<void> {
    if (onTurnSwitch) await onTurnSwitch(injected);

    const userContent = this.preprocessor.buildUserContent(injected);
    const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
    session.messages.push({ role: "user", content: transformedContent, timestamp: new Date().toISOString() });

    if (vision && injected.attachments.some((a) => a.type === "image" && a.path)) {
      chatMessages.push({ role: "user", content: await this.preprocessor.buildImageContent(injected) });
    } else {
      chatMessages.push({ role: "user", content: transformedContent });
    }

    void log("info", "mid-run injection", { sessionId: session.id, messageId: injected.id, textChars: injected.text.length });
  }


  private async handleMaxIterations(
    chatMessages: ChatMessage[],
    session: SessionData,
    message: UnifiedMessage,
    llmConfig: ResolvedLlmConfig,
    agent: AgentToolType,
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

    const trimmed = trimToContextWindow(chatMessages, this.contextWindow(session, llmConfig, agent).effective);
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
    const summaryResponse = await complete(llmConfig, chatMessages, undefined, signal);
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
      parentSessionId: attributionParent(session),
      platform: message.platform,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      streaming: false,
      caller: this.depth === 0 ? "orchestrator" : "subagent",
      promptTokens: summaryResponse.usage?.promptTokens ?? 0,
      completionTokens: summaryResponse.usage?.completionTokens ?? 0,
      totalTokens: summaryResponse.usage?.totalTokens ?? 0,
      cacheReadTokens: summaryResponse.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: summaryResponse.usage?.cacheWriteTokens ?? 0,
      toolCalls: 0,
      iteration: iteration + 1,
      durationMs: summaryDurationMs,
      proxyCostUsd: summaryResponse.proxyCostUsd,
      upstreamApiBase: summaryResponse.upstreamApiBase,
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
    // Tool-axis class of the calling agent, so a tool can resolve its own scope. Derived once in
    // handle() rather than recomputed here, which would drift from the set the agent was offered.
    agentType: AgentToolType;
    // The exact tool set offered to the model this run. Passed rather than recomputed so the set
    // that can be executed is the same object the prompt and the API payload were built from.
    available: Tool[];
  }): Promise<{ content: string; success: boolean }> {
    if (params.signal?.aborted) throw new AbortedError();
    // Resolved against the set this agent was offered, never the whole registry. A global lookup
    // executed anything the model named, which defeated three documented controls at once: the
    // sub-agent exclusion lists (a general sub-agent could spawn, write skills or touch memory), the
    // read-only allowlist of the research agent, and the `tools.disabled` denylist. The model only
    // ever sees this set, so a name outside it is a hallucination, not a request to honour.
    const tool = params.available.find((t) => t.name === params.name);
    if (!tool) {
      return {
        success: false,
        content: this.toolRegistry.get(params.name)
          ? `Error: tool "${params.name}" is not available to this agent`
          : `Error: unknown tool "${params.name}"`,
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
        __agentType: params.agentType,
        __message: params.message,
        __workspaceDir: this.workspaceFor(params.session).workspaceDir,
        __signal: params.signal,
        // Identity of the calling session, so a tool that creates or drives a sub-agent can record
        // who owns the work. Derived from the session, never from the message: the message alone
        // cannot tell a thread session from its room.
        __sessionId: params.session.id,
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

  /**
   * Window this run may use: the model's window lowered by the standing cap, unless the model is
   * exempt or the session asked for the full one. Every consumer goes through here so the trim, the
   * compaction gate and /status can never disagree about the number.
   */
  private contextWindow(session: SessionData, llmConfig: ResolvedLlmConfig, agent: AgentToolType) {
    return resolveContextWindow({
      model: llmConfig.model,
      config: this.config,
      declared: llmConfig.limit?.context,
      baseUrl: llmConfig.baseUrl,
      sessionOverride: session.contextOverride,
      agent,
    });
  }

  // Soft gate: estimation is a chars/4 heuristic, trimToContextWindow stays the hard
  // fallback at the limit. A compaction failure must never block the run.
  private async maybeAutoCompact(session: SessionData, llmConfig: ResolvedLlmConfig, agent: AgentToolType): Promise<void> {
    const window = this.contextWindow(session, llmConfig, agent);
    const threshold = resolveAutoCompactThreshold(this.config);
    const occupied = occupiedContextTokens(session.messages, (msgs) => this.toChatMessages([...msgs]), session.lastPrompt);
    if (occupied <= window.effective * threshold) return;

    void log("info", "auto-compaction triggered", {
      sessionId: session.id,
      occupiedTokens: occupied,
      measured: session.lastPrompt?.tokens,
      contextLimit: window.effective,
      rawContextLimit: window.raw,
      windowSource: window.rawSource,
      threshold,
      messageCount: session.messages.length,
    });
    try {
      const result = await compactSession(this.config, session);
      if (!result.ok) {
        void log("warn", "auto-compaction skipped", { sessionId: session.id, reason: result.reason });
      }
    } catch (err) {
      void log("error", "auto-compaction failed", { sessionId: session.id, error: errorLogData(err) });
    }
  }

  /**
   * Puts the images back into the turns that carry them, not just the last one. The chat APIs
   * are stateless: an image only stays visible to the model if it is resent with every request,
   * which is what opencode and Claude Code do. Without this, "and here, what do you see?" hits
   * a model that lost the picture one turn ago.
   *
   * Capped to the most recent images: unlike a desktop client, a phone conversation can pile up
   * photos, and each one costs its tokens on every single turn.
   */
  private async attachImages(chatMessages: ChatMessage[], messages: SessionMessage[]): Promise<number> {
    const kept = dropLeadingOrphanToolMessages(messages);
    // chatMessages[0] is the system prompt, the rest maps 1:1 onto `kept`.
    const withImages: Array<{ index: number; text: string; paths: string[] }> = [];
    for (const [i, msg] of kept.entries()) {
      if (msg.role !== "user" || !msg.attachments?.length) continue;
      const paths = msg.attachments.filter((a) => a.type === "image").map((a) => a.path);
      if (paths.length > 0) withImages.push({ index: i + 1, text: msg.content, paths });
    }

    let budget = MAX_HISTORY_IMAGES;
    let attached = 0;
    for (const turn of withImages.reverse()) {
      if (budget <= 0) break;
      const paths = turn.paths.slice(-budget);
      budget -= paths.length;
      const target = chatMessages[turn.index];
      if (target?.role !== "user") continue;
      const content = await imageContentFrom(turn.text, paths);
      if (content.length > 1) {
        chatMessages[turn.index] = { role: "user", content };
        attached += content.length - 1;
      }
    }
    return attached;
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
