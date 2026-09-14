import type { AgentToolType, MyClawConfig, ResolvedLlmConfig } from "../core/config.ts";
import { resolveWorkspaceKey } from "../core/config.ts";
import {
  resolveInjectionBudgetBonus,
  nestedAgentsEnabled,
  resolveNestedAgentsMaxBytes,
  autoCompactEnabled,
  autoCompactSpeculative,
  resolveAutoCompactThreshold,
} from "../core/config.ts";
import type { SubAgentType } from "../subagents/types.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData, SessionAttachment } from "../sessions/store.ts";
import { attributionParent, markSessionDirty } from "../sessions/store.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import { promptOf, contextEntries } from "../sessions/projection.ts";
import type { Entry } from "../sessions/log.ts";
import { RunRecorder } from "./run-recorder.ts";
import { buildSystemPrompt } from "./prompt/builder.ts";
import { selectRelevantSkills } from "../skills/retrieval.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ProviderMeta } from "../llm/provider.ts";
import { llmComplete, llmCompleteStream } from "../llm/transport.ts";
import { resolveRunModel, type RunModelOverride } from "../llm/run-model.ts";
import { announceModelFallback } from "../llm/fallback-notice.ts";
import { availabilityWorld } from "../llm/world.ts";
import { toOpenAiToolDefinitions, toOpenAiToolCalls } from "../llm/openai-format.ts";
import { trimToContextWindow, estimateTokens } from "../llm/tokens.ts";
import { usageModelOf } from "../llm/model-ref.ts";
import { resolveContextWindow, occupiedContextTokens, measuredPrompt } from "../llm/context-window.ts";
import type { ToolCallResult } from "./tool-status.ts";
import { compactSession, type CompactionResult } from "../sessions/compaction.ts";
import {
  cancelSpeculation,
  claimSpeculation,
  inSpeculationBand,
  startSpeculation,
} from "../sessions/compaction-speculative.ts";
import { isOverflowError, isSilentOverflow } from "../llm/overflow.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { cacheAttributionOf } from "../llm/cache-policy.ts";
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
import { StagnationMeter } from "./stagnation.ts";
import { NestedAgentsCollector, recordNestedInjection } from "./prompt/nested-agents.ts";
import { recall } from "../memory/index.ts";
import { hooks } from "../hooks/index.ts";
import { AbortedError, isAbort, rethrowIfAborted } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";
import { recordRunStart, recordRunEnd } from "../snapshots/store.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback } from "./backend.ts";
import { producesRemoteContent } from "../tools/registry.ts";
import { normalizeUntrusted } from "./prompt/normalize-untrusted.ts";

// The home loop is provider-agnostic except for these two transport calls: codex-backed models
// speak the OpenAI Responses API (docs/codex-backend.md), anthropic-backed ones the Messages API
// (docs/anthropic-backend.md), everything else chat/completions. All three share the
// ChatMessage[] in / LlmResponse out contract so the loop is untouched.
function completeStream(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  return llmCompleteStream(config, messages, onToken, tools, signal, reasoningSink);
}

function complete(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return llmComplete(config, messages, tools, signal);
}

function accumulateUsage(
  session: SessionData,
  usage?: LlmUsage,
  historyLength?: number,
): void {
  if (!usage) return;
  // The billed prompt size, tied to the history it covered, so the compaction gate can stop
  // guessing it from chars/4. See docs/context-window.md.
  if (historyLength !== undefined) {
    session.lastPrompt = measuredPrompt(usage.promptTokens, historyLength) ?? session.lastPrompt;
  }
  markSessionDirty(session);
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



// How many of the most recent images ride along with every request. They are resent on each
// turn, so this is a per-turn tax, not a one-off: a photo is worth ~1-2K tokens.
const MAX_HISTORY_IMAGES = 4;

// Turns a run has to add before the mid-run gate tries again after a summarization that changed
// nothing (a history too short to split, a refused summary, a provider error). Without it a run
// sitting over the threshold would pay for one summarization attempt per iteration and never move.
const MID_RUN_COMPACT_RETRY_TURNS = 10;

/** Images the channel resolved for this turn, in the shape the session keeps. */
function imageAttachmentsOf(message: UnifiedMessage): SessionAttachment[] {
  return message.attachments
    .filter((a) => a.type === "image" && a.path)
    .map((a) => ({ type: "image" as const, path: a.path!, ...(a.mimeType ? { mimeType: a.mimeType } : {}) }));
}

// A tool result with no content confuses the model (it cannot tell "ran, nothing to show" from a
// broken tool). Every tool result is normalized to a non-empty, explicit string.
const EMPTY_TOOL_OUTPUT = "[tool returned an empty response]";


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
    const disabled = session.nestedDisabled ?? [];
    return new NestedAgentsCollector(
      this.workspaceFor(session).workspaceDir,
      resolveNestedAgentsMaxBytes(this.config),
      (file) => {
        session.nestedAgents ??= [];
        recordNestedInjection(session.nestedAgents, file);
      },
      (realPath) => disabled.includes(realPath),
    );
  }

  getEchoMessages(messageId: string): OutgoingMessage[] {
    return this.preprocessor.consumeEchoMessages(messageId);
  }

  getResponseAttachments(messageId: string): OutgoingMessage["attachments"] {
    return this.preprocessor.consumeResponseAttachments(messageId);
  }

  /**
   * The same files, without taking them.
   *
   * The run writes what its tools produced onto the end marker before the router consumes the
   * attachments for the outgoing message: a peek is what lets the log and the live frame both
   * name the same pictures (2026-09-14).
   */
  private mediaPathsOf(messageId: string): string[] {
    const attachments = this.preprocessor.peekResponseAttachments(messageId) ?? [];
    return attachments.flatMap((att) => (att.path ? [att.path] : []));
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
    modelId?: string,
    modelOverride?: RunModelOverride,
    /** When true, the caller already wrote the UserEntry to the log (sub-agent path). */
    userEntryWritten?: boolean,
  ): Promise<string> {
    return this.handle(message, session, undefined, undefined, signal, undefined, modelId, undefined, undefined, modelOverride, userEntryWritten);
  }

  async handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
    modelId?: string,
    reasoning?: ReasoningSink,
    onToolStart?: ToolStartCallback,
    modelOverride?: RunModelOverride,
    /** When true, the caller already wrote the UserEntry to the log (sub-agent path). */
    userEntryWritten?: boolean,
  ): Promise<string> {
    return this.handle(message, session, onToken, onToolUse, signal, onTurnSwitch, modelId, reasoning, onToolStart, modelOverride, userEntryWritten);
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
    modelId?: string,
    reasoningSink?: ReasoningSink,
    onToolStart?: ToolStartCallback,
    modelOverride?: RunModelOverride,
    /** When true, the caller already wrote the UserEntry to the log (sub-agent path). */
    userEntryWritten?: boolean,
  ): Promise<string> {
    await this.preprocessor.preprocessForHandle(message);

    const isCron = message.platform === "cron";
    const agentToolType = isCron
      ? "cron"
      : this.depth === 0
        ? "main"
        : this.agentKind ?? "general";
    const agent = resolveAgent(this.config, this.agentRegistry, agentToolType, session.workspace, session.scopeOverride);
    const tools = this.toolRegistry.getForAgent(
      agent.base,
      agent.deny ? [...(this.config.tools?.disabled ?? []), ...agent.deny] : this.config.tools?.disabled,
      agent.mcp,
      agent.allow,
    );
    // The same resolution the dispatcher used to pick this engine: calling a different chain
    // here is how a run ended up on an engine chosen for another model.
    // Resolved into its own binding so the run's chain keeps its type: an override from the
    // caller carries no chain to announce.
    const runModel = this.llmOverride ? undefined : resolveRunModel(
      this.config,
      {
        agent: agentToolType,
        ...(agent.fileModel ? { fileModel: agent.fileModel } : {}),
        ...(modelId ? { forcedModel: modelId } : {}),
        ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}),
        ...((session.effortOverride ?? modelOverride?.effort) ? { sessionEffort: session.effortOverride ?? modelOverride?.effort } : {}),
        ...(session.scopeEffort ? { sessionScopeEffort: session.scopeEffort } : {}),
        hasImages: message.attachments.some((a) => a.type === "image" && Boolean(a.path)),
      },
      availabilityWorld(),
    );
    const resolvedModel = this.llmOverride ?? (modelOverride?.contextCap !== undefined
      ? { ...runModel!, contextCapOverride: modelOverride.contextCap }
      : runModel!);
    // The conversation is what the prefix cache is stable across, so the session names it. A
    // sub-agent carries its own id on purpose: it has its own system prompt, so sharing the
    // parent's key would point two different prefixes at one cache entry.
    const llmConfig: ResolvedLlmConfig = { ...resolvedModel, cacheKey: resolvedModel.cacheKey ?? session.id };
    // A sub-agent is its own run and warns for its own chain; the dedupe by message id keeps the
    // orchestrator's run to a single notice even though it resolves here as well.
    if (runModel) announceModelFallback(runModel, message, agentToolType);
    const startedAt = Date.now();
    const streaming = Boolean(onToken);
    let toolExecutions = 0;

    const agentType = this.depth === 0 ? "orchestrator" : this.agentKind ?? "general";
    const cronMaxIter = this.config.cron?.maxIterations;
    const maxIterations = isCron && cronMaxIter !== undefined && Number.isFinite(cronMaxIter) && cronMaxIter > 0
      ? cronMaxIter
      : agent.maxIterations;
    const budget = new IterationBudget(maxIterations);
    // Observation only: it reports at run end and never steers the loop -- see src/agent/stagnation.ts.
    const stagnation = new StagnationMeter();
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

    const entries = await sessionLogOf(session.id);
    const recorder = new RunRecorder(entries);
    const contextCount = contextEntries(entries.entries(), entries.leaf()).length;

    // The workspace state before this run starts writing. Keeping the snapshot is what makes
    // `/undo hard` able to restore files; the recording is best-effort and must never take the
    // run down with a capture failure (a non-git workspace with huge untracked files can be slow,
    // a read-only one can throw).
    const { workspaceDir } = this.workspaceFor(session);
    let runSnapshotId: string | undefined;
    try {
      runSnapshotId = (await recordRunStart(session.id, workspaceDir)).runId;
    } catch (err) {
      void log("warn", "snapshot capture failed at run start", { sessionId: session.id, error: String(err) });
    }

    void log("info", "agent run started", {
      ...runLogData(message, session),
      model: llmConfig.model,
      streaming,
      toolCount: tools.length,
      maxIterations: budget.total,
      sessionEntryCount: contextCount,
    });

    // Run-local (never persisted to session): tracks which nested AGENTS.md were already
    // injected this run and the byte budget spent, so each file lands at most once.
    const nestedAgents = this.nestedAgentsCollectorFor(session);

    const gate = await hooks.check("gate:agent:before:reply", { sessionId: session.id, message });
    if (!gate.allowed) {
      return `Reply blocked by gate: ${gate.reason ?? "no reason"}`;
    }

    try {
      // Every agent, not only the orchestrator: a research sub-agent reading documents is exactly
      // the profile that fills a window, and it used to have nothing but the hard trim.
      if (autoCompactEnabled(this.config)) {
        await this.maybeAutoCompact(session, llmConfig, agentToolType, entries, signal);
      }

      // Scoped, not the full store: layer 5 tells the agent it MUST read_skill anything listed, so a
      // catalog wider than the scope would advertise skills read_skill then refuses.
      const allSkills = this.skillRegistry.list(agent.skills, session.workspace);
      const skillsOff = session.skillsOff ?? [];
      const skills = skillsOff.length > 0 ? allSkills.filter((s) => !skillsOff.includes(s.name)) : allSkills;
      const runWorkspace = this.workspaceFor(session);
      let systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model: llmConfig.model,
        sessionId: session.id,
        tools,
        skills,
        workspaceDir: runWorkspace.workspaceDir,
        defaultWorkspaceDir: runWorkspace.defaultWorkspaceDir,
        workspaceKey: session.workspace,
        workspaces: this.config.workspaces,
        workspacePrompts: this.config.workspacePrompts,
        ...(agent.prompt ? { agentPrompt: agent.prompt } : {}),
        instructions: agent.instructions,
        layersOff: session.promptLayersOff,
        suggestedSkills: await selectRelevantSkills(
          skills,
          message.text,
          this.config.memory?.embedding,
          this.config.skills?.suggest,
        ),
      });
      hooks.emit("agent:prompt:built", { sessionId: session.id, model: llmConfig.model, systemPromptLength: systemPrompt.length });
      systemPrompt = (await hooks.transform("transform:system:prompt", { prompt: systemPrompt, sessionId: session.id, model: llmConfig.model })).prompt;

      const userContent = this.preprocessor.buildUserContent(message);
      const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
      const images = imageAttachmentsOf(message);
      const transcripts = this.preprocessor.transcriptsOf(message.id);
      // Sub-agent path: the runner already wrote the UserEntry to survive a crash before the
      // first turn. Skip it here to avoid a duplicate.
      if (!userEntryWritten) {
        recorder.user({
          // The app has already drawn this bubble from chat.send. Reuse that id so a later sync
          // replaces it instead of appending a second copy.
          id: message.id,
          text: transformedContent,
          ...(images.length > 0 ? { attachments: images } : {}),
          ...(message.location ? { location: message.location } : {}),
          ...(transcripts.length > 0 ? { transcripts: Object.fromEntries(transcripts.map((t) => [t.path, t.text])) } : {}),
        });
      }
      // The trigger turn is on the log: whatever this run writes from here on is its work, and
      // the marker lets a reopened thread fold that work until the matching runEnd -- the line
      // between the question and the work is exactly where a reader draws it.
      recorder.runStart();

      const openaiTools = toOpenAiToolDefinitions(tools);

      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...promptOf(entries.entries(), entries.leaf()),
      ];

      // Vision is resolved per model (resolver merges the model entry over the global flag):
      // the global default may be a text-only model while another configured model has vision.
      if (llmConfig.vision) {
        const attached = await this.attachImages(chatMessages, contextEntries(entries.entries(), entries.leaf()));
        if (attached > 0) void log("debug", "images attached to the prompt", { sessionId: session.id, model: llmConfig.model, images: attached });
      } else if (imageAttachmentsOf(message).length > 0) {
        void log("warn", "image dropped: the resolved model has no vision", { sessionId: session.id, model: llmConfig.model });
      }

      await this.injectMemory(message, chatMessages, session);

      const toolSchemaTokens = estimateTokens(JSON.stringify(openaiTools));
      // Carried on the session so the next turn-start gate can count it. That gate runs before this
      // point, so the alternative was assuming zero: it read the window as if a run cost nothing
      // before its first message, and on this install that hid 33k.
      session.lastFixedTokens = toolSchemaTokens + estimateTokens(systemPrompt);
  

      // The prompt is built from the history, so a mid-run compaction has to be followed by this:
      // rewriting one and keeping the other is how a summary lands in the session while the model
      // keeps being sent the turns it replaced. Memory is deliberately not re-injected -- it is a
      // hint attached to the inbound turn, the run has already seen it, and it never enters the
      // history the summary was made from.
      const rebuildPrompt = async (): Promise<void> => {
        // `providerMeta` lives on the in-memory prompt and never in the log (docs/reasoning-replay.md),
        // so rebuilding from the log drops the reasoning state of the run in progress. Dropping it is
        // safe on Anthropic and Responses, but not everywhere: DeepSeek documents `reasoning_content`
        // as required once tools are present and answers 400 without it, GLM and Kimi degrade and
        // miss cache. The blobs are still in hand here -- they are only lost by rebuilding -- so they
        // are carried across, keyed on the tool call id the log persisted for the same turn.
        const carried = new Map<string, ProviderMeta>();
        for (const msg of chatMessages) {
          if (msg.role !== "assistant" || !msg.providerMeta) continue;
          const id = "tool_calls" in msg ? msg.tool_calls?.[0]?.id : undefined;
          if (id) carried.set(id, msg.providerMeta);
        }

        chatMessages.length = 0;
        chatMessages.push({ role: "system", content: systemPrompt }, ...promptOf(entries.entries(), entries.leaf()));
        if (carried.size > 0) {
          for (const msg of chatMessages) {
            if (msg.role !== "assistant" || msg.providerMeta) continue;
            const id = "tool_calls" in msg ? msg.tool_calls?.[0]?.id : undefined;
            const meta = id ? carried.get(id) : undefined;
            if (meta) msg.providerMeta = meta;
          }
        }
        if (llmConfig.vision) await this.attachImages(chatMessages, contextEntries(entries.entries(), entries.leaf()));
      };

      let iteration = 0;
      // Some OpenAI-compatible gateways can terminate after emitting reasoning (or after a tool
      // round) without a final text or tool call. That is not a successful assistant turn. Keep a
      // small retry budget here; otherwise the old `no tool calls => finished` rule silently ended
      // the run with responseChars=0 and left the user with no bubble at all.
      let emptyTurnRetries = 0;
      const MAX_EMPTY_TURN_RETRIES = 2;
      // History length the mid-run gate is allowed to try again at, moved forward only by an attempt
      // that changed nothing: the summarizer needs new turns to have anything new to say.
      let midRunCompactRetryAt = 0;
      // One overflow recovery per run. The window we believe in is the input to the check, so a
      // window that is simply wrong would otherwise compact, retry, overflow and compact forever.
      let overflowRecovered = false;
      while (budget.consume()) {
        if (signal?.aborted) throw new AbortedError();
        // Mid-run steering: pick up any message that arrived during the previous tool round and
        // append it as a user turn before the next LLM call. Sub-agents have their own mailbox
        // now (opened by the runner), which is what lets the app steer one mid-run; the channels
        // cannot reach a subagent/* session, so there is nothing else that could arrive.
        {
          for (const injected of runRegistry.drainInjections(session.id)) {
            budget.grant(injectionBonus);
            await this.injectUserTurn(injected, chatMessages, session, Boolean(llmConfig.vision), recorder, onTurnSwitch);
          }
        }
        iteration++;
        // Between two iterations, before the prompt is assembled: the loop is the only writer here
        // and the alternative is trimToContextWindow dropping the oldest turns for good.
        const currentEntryCount = contextEntries(entries.entries(), entries.leaf()).length;
        if (autoCompactEnabled(this.config) && currentEntryCount >= midRunCompactRetryAt) {
          const outcome = await this.compactMidRun(session, llmConfig, agentToolType, iteration, entries, signal);
          if (outcome === "compacted") {
            await rebuildPrompt();
          } else if (outcome === "skipped") {
            midRunCompactRetryAt = currentEntryCount + MID_RUN_COMPACT_RETRY_TURNS;
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

        /**
         * The gate is an estimate, so it can be wrong in the direction that hurts: a tool result
         * appended after the last check is enough to walk into a hard rejection with nothing having
         * been summarised. Compacting on the provider's own verdict and retrying once is what turns
         * that into a slow turn instead of a lost run -- and it is a *compaction*, so the beginning
         * of the conversation is summarised rather than dropped by `trimToContextWindow`.
         */
        const recoverFromOverflow = async (why: Record<string, unknown>): Promise<boolean> => {
          if (overflowRecovered || !autoCompactEnabled(this.config)) return false;
          overflowRecovered = true;
          void log("warn", "context overflow reported by the provider, compacting and retrying once", {
            ...runLogData(message, session),
            iteration,
            ...why,
          });
          const outcome = await this.runCompaction(session, signal, { sessionId: session.id, iteration, reason: "overflow" });
          if (outcome !== "compacted") return false;
          await rebuildPrompt();
          // Correction, not work: the iteration is given back so a run cannot spend its budget on
          // recovering from a prompt it never got to answer.
          budget.grant(1);
          return true;
        };

        let response: LlmResponse;
        try {
          response = onToken
            ? await completeStream(
                llmConfig,
                chatMessages,
                onToken,
                openaiTools.length > 0 ? openaiTools : undefined,
                signal,
                reasoningSink,
              )
            : await complete(
                llmConfig,
                chatMessages,
                openaiTools.length > 0 ? openaiTools : undefined,
                signal,
              );
        } catch (err) {
          rethrowIfAborted(err, signal);
          if (isOverflowError(err) && (await recoverFromOverflow({ error: errorLogData(err) }))) continue;
          throw err;
        }
        const llmDurationMs = Date.now() - llmStartedAt;

        // The overflow nobody reported: an endpoint that accepts a prompt past its own window and
        // answers anyway, or one that truncates server-side and calls it `length`. Checked before
        // the empty-turn retry, which would otherwise repost the same oversized prompt.
        if (
          isSilentOverflow(
            response.usage,
            response.finishReason,
            this.contextWindow(session, llmConfig, agentToolType).effective,
          )
        ) {
          if (await recoverFromOverflow({ silent: true, promptTokens: response.usage?.promptTokens, finishReason: response.finishReason })) continue;
        }

        hooks.emit("llm:call:end", {
          model: llmConfig.model,
          streaming,
          durationMs: llmDurationMs,
          usage: response.usage,
          toolCallCount: response.toolCalls?.length ?? 0,
        });

          // Prompt-side length, the same units `occupiedContextTokens` pairs it with: measuring the
          // whole history against a billed number that only covered the window after the boundary
          // would read as a measurement of turns the model never saw.
          accumulateUsage(session, response.usage, promptOf(entries.entries(), entries.leaf()).length);
          // The measurement for this turn has landed. On this transport it is the earliest it can
          // be: an OpenAI-compatible stream reports usage in its last chunk, never before.
          if (response.usage) hooks.emit("session:context:measured", { sessionId: session.id });
          recordApiCall({
          sessionId: session.id,
          parentSessionId: attributionParent(session),
          platform: message.platform,
          // The model the API actually received, snapshotted at run time: a tag reference is
          // resolved here so a later tag edit never rewrites the history a row belongs to. The
          // endpoint pin stays on it, because two endpoints of one model are two bills.
          model: usageModelOf(llmConfig),
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
          ...cacheAttributionOf(llmConfig),
        });

        hooks.emit("agent:turn:end", { sessionId: session.id, model: llmConfig.model, iteration, hasToolCalls: Boolean(response.toolCalls?.length), finishReason: response.finishReason, incomplete: response.incomplete });

        if (!response.toolCalls?.length && response.content.trim().length === 0) {
          emptyTurnRetries++;
          void log("warn", "LLM ended an empty turn; retrying instead of finishing silently", {
            ...runLogData(message, session),
            model: llmConfig.model,
            iteration,
            emptyTurnRetries,
            maxEmptyTurnRetries: MAX_EMPTY_TURN_RETRIES,
            finishReason: response.finishReason,
            incomplete: response.incomplete,
            reasoningChars: response.reasoning?.length ?? 0,
          });
          if (emptyTurnRetries <= MAX_EMPTY_TURN_RETRIES) {
            // A retry is correction, not work: give the iteration back so a run with a small
            // maxIterations cannot exhaust its budget on retries and fall through to the
            // max-iterations summary path (which would mask this very failure mode).
            budget.grant(1);
            continue;
          }
          throw new Error(`LLM returned an empty final turn after ${MAX_EMPTY_TURN_RETRIES} retries (finish=${response.finishReason ?? "unknown"})`);
        }
        emptyTurnRetries = 0;

        if (!response.toolCalls?.length) {
          const transformedResponse = (await hooks.transform("transform:agent:response", { response: response.content, sessionId: session.id, model: llmConfig.model })).response;
          // Dropped when a hook rewrote the answer: the cuts are offsets into text that no
          // longer exists, and a wrong cut is worse than none.
          const segments = response.segments && transformedResponse === response.content ? response.segments : undefined;
          recorder.turn({
            content: transformedResponse,
            ...(response.reasoning ? { reasoning: response.reasoning } : {}),
            ...(response.reasoningMs !== undefined ? { reasoningMs: response.reasoningMs } : {}),
            ...(segments ? { segments } : {}),
            ...(response.providerMeta ? { providerMeta: response.providerMeta } : {}),
            ...(response.incomplete ? { incomplete: response.incomplete } : {}),
          });

          // Mid-run steering: a message that arrived during this final call keeps the run going
          // (drainOrClose atomically closes the mailbox when nothing is pending, so late arrivals
          // after this point fall back to a fresh run instead of being lost). The mailbox is the
          // session's own, root or sub-agent alike.
          {
            const injected = runRegistry.drainOrClose(session.id);
            if (injected.length > 0) {
              chatMessages.push({ role: "assistant", content: transformedResponse });
              for (const m of injected) {
                budget.grant(injectionBonus);
                await this.injectUserTurn(m, chatMessages, session, Boolean(llmConfig.vision), recorder, onTurnSwitch);
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
            sessionEntryCount: contextEntries(entries.entries(), entries.leaf()).length,
            durationMs,
            usage: response.usage,
            sessionTokenUsage: session.tokenUsage,
            stagnation: stagnation.report(),
          });
          recorder.runEnd("done", this.mediaPathsOf(message.id));
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

        // A turn cut on `length` stops mid-serialization, so the last tool call carries arguments
        // the provider never finished writing. The lenient JSON parse that follows can make those
        // validate: `{"path":"x.ts","content":"half of` recovers as a shorter string rather than
        // as an error, and the write goes through with a truncated payload. `incomplete` does not
        // cover this, by construction: it requires no tool calls at all (llm/provider.ts).
        //
        // The calls are reported back to the model as failed instead of executed. The model then
        // sees why and reissues them, which is what a tool error is for.
        const truncatedCalls = response.finishReason === "length";
        const assistantToolCalls = toOpenAiToolCalls(response.toolCalls);

        // `providerMeta` rides on the in-memory prompt only, never on `persistedAssistant` below:
        // it is opaque, model-bound and large, and its whole value is spanning the tool iterations
        // of the run in progress. See docs/reasoning-replay.md.
        //
        // Dropped when the turn came back incomplete. A truncated turn can carry a half-formed
        // reasoning item, and handing that back is how a signed or encrypted chain is refused for
        // the rest of the run; the visible text is kept either way. opencode v2 draws the same line
        // ("failed turns and incompatible models omit opaque metadata").
        const replayable = response.providerMeta && !response.incomplete;
        chatMessages.push({
          role: "assistant",
          content: response.content,
          tool_calls: assistantToolCalls,
          ...(replayable ? { providerMeta: response.providerMeta } : {}),
        });

        // The turn that asked for tools. The tool_calls are not on it: they are derived from the
        // ToolEntry that carry the results, so the prompt cannot contain a request without an
        // answer.
        recorder.turn({
          content: response.content,
          ...(response.reasoning ? { reasoning: response.reasoning } : {}),
          ...(response.reasoningMs !== undefined ? { reasoningMs: response.reasoningMs } : {}),
          ...(response.segments ? { segments: response.segments } : {}),
          ...(replayable ? { providerMeta: response.providerMeta } : {}),
          ...(response.incomplete ? { incomplete: response.incomplete } : {}),
        });

        const executeOne = async (tc: typeof response.toolCalls[number]) => {
          if (truncatedCalls) {
            void log("warn", "refused a tool call from a truncated turn", {
              ...runLogData(message, session),
              tool: tc.name,
              toolCallId: tc.id,
            });
            return {
              tc,
              result: {
                content: "Error: the model's turn was cut off by the output limit, so this call's arguments are incomplete. It was not executed. Reissue it, and split the work if the arguments were long.",
                success: false,
              },
              durationMs: 0,
            };
          }
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
          // Surface the tool to the output layer the instant it starts running, before the
          // result is in: a long-running bash can show a spinner and a live output card while
          // it works instead of a silent gap. The id is stable, so appendToolUse upserts.
          if (onToolStart) {
            try { await onToolStart({ id: tc.id, name: tc.name, arguments: tc.arguments }); }
            catch { /* a tool-start frame must never abort the run */ }
          }
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
          toolResults.push({ id: tc.id, name: tc.name, arguments: tc.arguments, durationMs, output: transformedResult, ok: result.success });
          if (nestedAgents) {
            transformedResult += nestedAgents.collect(tc.name, tc.arguments);
          }
          // Recorded before the message is built, and the message comes back from the recording:
          // the whole output is archived first, then the two views are cut from it. The other order
          // is what once wrote a "full output" file that was itself truncated -- src/sessions/tool-output.ts.
          const recorded = await recorder.tool({
            callId: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
            output: transformedResult,
            ok: result.success,
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
          stagnation.observe(recorded.message);
          chatMessages.push({ role: "tool", tool_call_id: tc.id, content: recorded.message });
        }

        if (onToolUse) {
          await onToolUse(toolResults, session.verbose !== false);
        }
      }

      hooks.emit("agent:budget:exhausted", {
        sessionId: session.id,
        iteration,
        maxIterations: budget.total,
        toolExecutions,
      });
      return await this.handleMaxIterations(chatMessages, session, message, llmConfig, agentToolType, startedAt, toolExecutions, iteration, budget, recorder, signal);
    } catch (err) {
      if (isAbort(err, signal)) {
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
        recorder.runEnd("aborted", this.mediaPathsOf(message.id));
        throw new AbortedError();
      }
      // The same ending as the abort above, and for the same reason: the cursor stays where the
      // run left it. Rewinding to the question is what made a run that died a branch `pathOf` does
      // not walk -- settled tool calls, their output and the phases around them on disk and in no
      // view, so a refresh served the question with nothing under it. The channel's `failure` entry
      // therefore lands after the run's last entry instead of on the question, and the next turn
      // reads the work rather than doing it again. What that costs is the dead attempt's tokens in
      // the next prompt -- docs/session-log.md 2.6.
      recorder.runEnd("error", this.mediaPathsOf(message.id));
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
      // The run is over and the owner is reading what it wrote: the one moment where a minute of
      // summarizer time costs nothing. Only inside the band, and never while a run holds the
      // session -- `runNode.exit()` above is what makes this the outside.
      if (autoCompactSpeculative(this.config) && !signal?.aborted) {
        const gate = this.contextGate(session, llmConfig, agentToolType, entries);
        if (!gate.over && inSpeculationBand(gate.occupied, gate.thresholdTokens)) {
          void log("info", "arming a speculative compaction", gate.data);
          startSpeculation(this.config, session);
        }
      }
      // Snapshot the after-state for the diff: only a snapshot that was taken is worth completing.
      if (runSnapshotId) {
        try {
          await recordRunEnd(session.id, runSnapshotId, workspaceDir);
        } catch (err) {
          void log("warn", "snapshot capture failed at run end", { sessionId: session.id, error: String(err) });
        }
      }
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
    recorder: RunRecorder,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<void> {
    if (onTurnSwitch) await onTurnSwitch(injected);

    const userContent = this.preprocessor.buildUserContent(injected);
    const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
    const images = imageAttachmentsOf(injected);
    // The images ride on the entry as on the trigger turn: that field is what every later
    // request and every reopened thread reads the picture back from. Without it the bubble came
    // back as bare text and the model never saw the picture again.
    recorder.user({
      // An injected app message already has a bubble open under its chat.send id.
      id: injected.id,
      text: transformedContent,
      ...(images.length > 0 ? { attachments: images } : {}),
      ...(injected.location ? { location: injected.location } : {}),
    });

    // The built text, not the raw one: a picture sent without a word has an empty raw text, and
    // an empty text block beside the image is a request Anthropic refuses whole. A file that cannot
    // be read leaves the text alone, which still names the attachment.
    const content = vision && images.length > 0 ? await this.preprocessor.buildImageContent(injected, transformedContent) : [];
    chatMessages.push({ role: "user", content: content.length > 0 ? content : transformedContent });

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
    recorder: RunRecorder,
    signal?: AbortSignal,
  ): Promise<string> {
    const summaryPrompt =
      "You've reached the maximum number of tool-calling iterations allowed. " +
      "Please provide a final response summarizing what you've found and accomplished so far, " +
      "without calling any more tools.";

    const injectedText = `[system: ${summaryPrompt}]`;
    chatMessages.push({ role: "system", content: summaryPrompt });
    recorder.user({ text: injectedText });

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
      model: usageModelOf(llmConfig),
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
      ...cacheAttributionOf(llmConfig),
    });

    const rawFinalText = summaryResponse.content.trim() || "I reached the iteration limit and couldn't generate a summary.";
    const finalText = (await hooks.transform("transform:agent:response", { response: rawFinalText, sessionId: session.id, model: llmConfig.model })).response;

    recorder.turn({ content: finalText });

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

    recorder.runEnd("done", this.mediaPathsOf(message.id));
    return finalText;
  }

  /**
   * Inject relevant long-term memory into the current turn only (not session history),
   * so it never accumulates and stays out of cached prefixes. Main agent only.
   */
  private async injectMemory(message: UnifiedMessage, chatMessages: ChatMessage[], session: SessionData): Promise<void> {
    if (this.depth !== 0) return;
    if (this.config.memory?.enabled === false) return;
    if (session.memoryRecallOff) return;
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
        __workspaceKey: params.session.workspace,
        __signal: params.signal,
        // Identity of the calling session, so a tool that creates or drives a sub-agent can record
        // who owns the work. Derived from the session, never from the message: the message alone
        // cannot tell a thread session from its room.
        __sessionId: params.session.id,
        // Identity of this tool call, so a tool that spawns a sub-agent can link the live card
        // back to the tool-start card the streamer already opened.
        __toolCallId: params.toolCallId,
      };
      const result = await tool.execute(enrichedArgs, (chunk) => {
        hooks.emit("tool:execute:progress", { toolCallId: params.toolCallId, sessionId: params.session.id, chunk });
      });
      if (params.signal?.aborted) throw new AbortedError();
      if (result.attachments?.length) {
        for (const att of result.attachments) {
          this.preprocessor.addResponseAttachment(params.message.id, att);
        }
      }
      if (result.success) {
        return {
          success: true,
          content: result.output.trim().length > 0 ? result.output : EMPTY_TOOL_OUTPUT,
        };
      }
      const detail = (result.error ?? result.output).trim();
      return {
        success: false,
        content: `Error: ${detail.length > 0 ? detail : "tool failed with no message"}`,
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
      ...(llmConfig.contextCapOverride !== undefined ? { capOverride: llmConfig.contextCapOverride } : {}),
    });
  }

  /**
   * How full the window is, and by how much the gate is crossed. One reading for the run-start gate
   * and the mid-run one, so the two can never disagree about the same conversation.
   */
  private contextGate(
    session: SessionData,
    llmConfig: ResolvedLlmConfig,
    agent: AgentToolType,
    entries: { entries: () => readonly Entry[]; leaf: () => string | null },
  ): { over: boolean; occupied: number; thresholdTokens: number; data: Record<string, unknown> } {
    const window = this.contextWindow(session, llmConfig, agent);
    const threshold = resolveAutoCompactThreshold(this.config, window.effective);
    const prompt = promptOf(entries.entries(), entries.leaf());
    const fixed = session.lastFixedTokens ?? 0;
    const occupied = occupiedContextTokens(
      prompt,
      (msgs) => [...msgs],
      session.lastPrompt,
      fixed,
    );
    const thresholdTokens = window.effective * threshold;
    return {
      over: occupied > thresholdTokens,
      occupied,
      thresholdTokens,
      data: {
        sessionId: session.id,
        occupiedTokens: occupied,
        measured: session.lastPrompt?.tokens,
        hasMeasurement: session.lastPrompt !== undefined,
        fixedTokens: fixed,
        contextLimit: window.effective,
        rawContextLimit: window.raw,
        windowSource: window.rawSource,
        threshold,
        messageCount: prompt.length,
      },
    };
  }

  /**
   * Compact now, claiming the background summary when one is still good for this branch.
   *
   * The claim is the whole point of speculating: the crossing costs an append instead of a
   * minute. A stale one is dropped inside `claimSpeculation`, which then reads as "nothing armed"
   * and falls through to the blocking pass.
   */
  private async runCompaction(
    session: SessionData,
    signal: AbortSignal | undefined,
    logData: Record<string, unknown>,
  ): Promise<"skipped" | "compacted"> {
    // No `message:queued` here, deliberately. The hook marks a send that is waiting for a run to
    // become possible, and it is lifted when that run starts. A mid-run compaction has no such
    // send: the run is already going, its bubble is the one already being answered, and nothing
    // will ever lift the mark -- so the bubble wore "waiting for the compaction" for hours while a
    // run that only called tools produced no signal to clear it, and the journal replayed the mark
    // on every reconnect. The operation is already visible through `session:compact:start`
    // (`chat.compacting`), which every path emits and which outlives a reload. Observed on the
    // owner's thread, 2026-09-11.
    try {
      const claimed = await claimSpeculation(this.config, session);
      if (claimed?.ok) {
        void log("info", "auto-compaction served from the background summary", {
          ...logData,
          beforeCount: claimed.beforeCount,
          afterCount: claimed.afterCount,
        });
        this.announceBoundary(session, claimed);
        return "compacted";
      }
      // Anything still in flight was planned against the branch this pass is about to rewrite.
      cancelSpeculation(session.id);
      const result = await compactSession(this.config, session, undefined, signal);
      if (!result.ok) {
        void log("warn", "auto-compaction skipped", { ...logData, reason: result.reason });
        return "skipped";
      }
      void log("info", "auto-compaction done", {
        ...logData,
        beforeCount: result.beforeCount,
        afterCount: result.afterCount,
      });
      this.announceBoundary(session, result);
      return "compacted";
    } catch (err) {
      rethrowIfAborted(err, signal);
      void log("error", "auto-compaction failed", { ...logData, error: errorLogData(err) });
      return "skipped";
    }
  }

  /**
   * Draw the boundary now, in the conversation the owner is looking at.
   *
   * `/compact` has always answered with a bubble of its own; an automatic pass had nothing, so a
   * compaction mid-run was invisible until the next history load and the thread silently lost its
   * middle. The frame is the same boundary the replayed history builds, keyed by the same entry
   * id, so the device that already drew it ignores the duplicate.
   */
  private announceBoundary(session: SessionData, result: CompactionResult): void {
    if (!result.boundary || !result.summary) return;
    hooks.emit("session:compact:boundary", {
      sessionId: session.id,
      entryId: result.boundary.entryId,
      summary: result.summary,
      count: result.boundary.count,
    });
  }

  // Soft gate: estimation is a chars/4 heuristic, trimToContextWindow stays the hard
  // fallback at the limit. A compaction failure must never block the run.
  private async maybeAutoCompact(session: SessionData, llmConfig: ResolvedLlmConfig, agent: AgentToolType, entries: { entries: () => readonly Entry[]; leaf: () => string | null }, signal?: AbortSignal): Promise<void> {
    const gate = this.contextGate(session, llmConfig, agent, entries);
    if (!gate.over) return;

    void log("info", "auto-compaction triggered", gate.data);
    await this.runCompaction(session, signal, { sessionId: session.id });
  }

  /**
   * The same gate, between two iterations of one run.
   *
   * A single agentic run can add hundreds of thousands of tokens: the run-start gate leaves that
   * entirely to `trimToContextWindow`, which keeps the prompt inside the window by *dropping* the
   * oldest turns outright. The window was never exceeded, but the conversation lost its beginning
   * instead of having it summarised, which is exactly what compaction exists to avoid.
   *
   * Between two iterations the loop is the only writer (the router serialises runs per session and
   * meta-commands are refused while one holds it), so there is no race to lose: the risk is
   * consistency, and the caller answers it by rebuilding the prompt from the rewritten history.
   * `under` is the cheap case and carries no penalty: only an attempt that changed nothing is worth
   * backing off from.
   */
  private async compactMidRun(
    session: SessionData,
    llmConfig: ResolvedLlmConfig,
    agent: AgentToolType,
    iteration: number,
    entries: { entries: () => readonly Entry[]; leaf: () => string | null },
    signal?: AbortSignal,
  ): Promise<"under" | "skipped" | "compacted"> {
    const gate = this.contextGate(session, llmConfig, agent, entries);
    if (!gate.over) return "under";

    void log("info", "auto-compaction triggered mid-run", { ...gate.data, iteration });
    return await this.runCompaction(session, signal, { sessionId: session.id, iteration });
  }

  /**
   * Puts the images back into the turns that carry them, not just the last one. The chat APIs
   * are stateless: an image only stays visible to the model if it is resent with every request,
   * which is what opencode and Claude Code do. Without this, "and here, what do you see?" hits
   * a model that lost the picture one turn ago.
   *
   * Capped to the most recent images: unlike a desktop client, a phone conversation can pile up
   * photos, and each one costs its tokens on every single turn.
   *
   * The k-th user-role message of the prompt is the k-th `user` or `compaction` entry of the
   * context: those are the only entry types `messagesOf` renders in that role, one message each,
   * so the two sequences zip. Anything else is not a stable count: a run's phases fold into one
   * assistant message however many there are, every settled tool adds a message of its own, and a
   * turn that said and asked nothing renders to none. Walking the entries with a running index
   * drifted on the first run that called a tool, and the drift landed on a tool message, where the
   * image was dropped without a word in the log.
   */
  private async attachImages(chatMessages: ChatMessage[], path: readonly Entry[]): Promise<number> {
    const userSlots: number[] = [];
    for (let i = 1; i < chatMessages.length; i++) {
      if (chatMessages[i]!.role === "user") userSlots.push(i);
    }
    const withImages: Array<{ chatIndex: number; text: string; paths: string[] }> = [];
    let k = 0;
    for (const entry of path) {
      if (entry.type !== "user" && entry.type !== "compaction") continue;
      const chatIndex = userSlots[k++];
      if (chatIndex === undefined) break;
      if (entry.type !== "user") continue;
      const paths = (entry.attachments ?? []).filter((a) => a.type === "image").map((a) => a.path);
      if (paths.length > 0) withImages.push({ chatIndex, text: entry.text, paths });
    }

    let budget = MAX_HISTORY_IMAGES;
    let attached = 0;
    for (const turn of withImages.reverse()) {
      if (budget <= 0) break;
      const paths = turn.paths.slice(-budget);
      budget -= paths.length;
      const target = chatMessages[turn.chatIndex];
      if (target?.role !== "user") continue;
      const content = await imageContentFrom(turn.text, paths);
      const images = content.filter((part) => part.type === "image_url").length;
      if (images > 0) {
        chatMessages[turn.chatIndex] = { role: "user", content };
        attached += images;
      }
    }
    return attached;
  }


}
