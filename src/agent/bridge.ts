import type { AgentToolType, MyClawConfig, ResolvedLlmConfig } from "../core/config.ts";
import { resolveWorkspaceKey } from "../core/config.ts";
import {
  resolveInjectionBudgetBonus,
  nestedAgentsEnabled,
  resolveNestedAgentsMaxBytes,
  autoCompactEnabled,
  autoCompactSpeculative,
  resolveAutoCompactThreshold,
  providerRetryDelays,
} from "../core/config.ts";
import type { SubAgentType } from "../subagents/types.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage, Attachment } from "../channels/types.ts";
import type { SessionData, SessionAttachment } from "../sessions/store.ts";
import { agentTypeOf, attributionParent, markSessionDirty, usageFolderOf, usageWorkspaceOf } from "../sessions/store.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import { promptOf, contextEntries, keepCurrentTurnReasoning } from "../sessions/projection.ts";
import type { Entry, SessionLog, ToolEntry } from "../sessions/log.ts";
import { continuable, CUT_OFF_NUDGE, endsOnOwnText, interruptedOutput, interruptedSubagents, orphanCalls, subagentOfCall } from "../sessions/resume.ts";
import { RunRecorder } from "./run-recorder.ts";
import { buildSystemPrompt } from "./prompt/builder.ts";
import { turnContextBlock } from "./prompt/turn-context.ts";
import { selectRelevantSkills } from "../skills/retrieval.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ProviderMeta } from "../llm/provider.ts";
import { llmComplete, llmCompleteStream } from "../llm/transport.ts";
import { resolveRunModel, type RunModel, type RunModelOverride } from "../llm/run-model.ts";
import { isCapabilityRefusal, isProviderOutage, isQuotaSpent } from "../llm/outage.ts";
import { providerFallbackTargets } from "../llm/provider-fallback.ts";
import { announceModelFallback } from "../llm/fallback-notice.ts";
import { availabilityWorld } from "../llm/world.ts";
import { toOpenAiToolDefinitions, toOpenAiToolCalls } from "../llm/openai-format.ts";
import { trimToContextWindow, estimateTokens } from "../llm/tokens.ts";
import { usageModelOf } from "../llm/model-ref.ts";
import { resolveContextWindow, occupiedContextTokens, measuredPrompt } from "../llm/context-window.ts";
import type { ToolCallResult } from "./tool-status.ts";
import { compactSession, type CompactionResult, type CompactionPrefix } from "../sessions/compaction.ts";
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
import { AbortedError, isAbort, rethrowIfAborted, sleep } from "../core/aborted.ts";
import { runRegistry } from "../core/run-registry.ts";
import { recordRunStart, recordRunEnd } from "../snapshots/store.ts";
import { currentRunId, newRunId } from "../utils/run-context.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback, MediaStoreHook } from "./backend.ts";
import { storeRunMedia, type StoredRunMedia } from "./media-store.ts";
import { producesRemoteContent, cronCapabilityDeny } from "../tools/registry.ts";
import { nodeToolsFor } from "../nodes/tools.ts";
import { nodeRecord } from "../nodes/store.ts";
import { normalizeUntrusted } from "./prompt/normalize-untrusted.ts";

/**
 * A note the reader owes for a retry or a reroute, in front of the answer.
 *
 * The live stream gets the same note as it happens, so the bubble and the history say the same
 * thing -- the channel replaces the streamed bubble with this text when the run ends.
 */
function withFallbackNotes(text: string, notes: readonly string[]): string {
  return notes.length > 0 ? `${notes.join("\n\n")}\n\n${text}` : text;
}

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
// Tool images get their own budget so a run that captures screenshots cannot evict the picture
// the owner sent. Both are spent most-recent-first.
const MAX_HISTORY_TOOL_IMAGES = 4;

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

/** Injected messages whose entry is waiting to be drained. Well past one run's cap. */

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
   * What this run's tools produced, stored where a device can fetch it, for the end marker.
   *
   * The bytes have to be stored before the marker is written -- the log never rewrites an entry --
   * and only a channel owns a store, so the store is injected. Storing here is also what lets the
   * outgoing frame name the same copy: the id rides back onto the registry's own attachment, and
   * the router's send then fetches instead of copying again (2026-09-15).
   *
   * A run with no store records the paths alone, which is what every marker did before this
   * existed, and what a channel without files (cron, a plugin) still gets.
   */
  private async mediaForMarker(message: UnifiedMessage, session: SessionData): Promise<StoredRunMedia> {
    const attachments = this.preprocessor.attachmentsOf(message.id) ?? [];
    return await storeRunMedia(attachments, session.id, this.mediaStore);
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

  /**
   * Where a run's produced files are stored, so both the marker and the frame can name the copy.
   * Injected like the approval handler: the agent side owns no bytes.
   */
  setMediaStore(store: MediaStoreHook | undefined): void {
    this.mediaStore = store;
  }

  private mediaStore?: MediaStoreHook;

  /**
   * One model call, with a provider failure handled: the waits this run owes, then the run's
   * fallback targets in order -- and the run adopts whichever target answers.
   *
   * A failure *between* two calls, or before the failing call wrote anything, costs the run
   * nothing but the wait: its messages, its tool results and its log are intact, so it continues
   * on another provider instead of dying mid-task. That is the case that mattered: a research
   * child killed on its ninth call took its whole pass down while healthy providers sat unused
   * (2026-09-21).
   *
   * A failure *after* this call wrote something is not reroutable -- the text is on screen, and
   * replaying it would say it twice.
   *
   * The schedule is spent once per run and each target is tried once: a chain that rearmed at
   * every attempt would be a loop. Everything here is the provider's fault; an overflow has its
   * own recovery, and a request we sent wrong is our bug and must surface as itself.
   */
  private async callModel(params: {
    config: ResolvedLlmConfig;
    call: (config: ResolvedLlmConfig) => Promise<LlmResponse>;
    emitted: () => boolean;
    waits: number[];
    attempted: Set<string>;
    notes: string[];
    runModel?: RunModel;
    session: SessionData;
    message: UnifiedMessage;
    agentToolType: string;
    iteration: number;
    streaming: boolean;
    signal?: AbortSignal;
    onToken?: TokenCallback;
  }): Promise<{ response: LlmResponse; config: ResolvedLlmConfig }> {
    let config = params.config;
    let targets: ReturnType<typeof providerFallbackTargets> | undefined;

    for (;;) {
      const startedAt = Date.now();
      try {
        const response = await params.call(config);
        return { response, config };
      } catch (err) {
        rethrowIfAborted(err, params.signal);
        if (isOverflowError(err) || params.emitted() || !(isProviderOutage(err) || isCapabilityRefusal(err))) throw err;

        const reason = String((err as Error | undefined)?.message ?? err).slice(0, 200);
        const failed = { model: config.model, provider: config.provider };
        // A capability the model does not have is not a wait: the next target is the only cure.
        const capability = (err as { capability?: string }).capability;
        // Nor is a spent quota: nothing refills it within the run.
        const wait = capability || isQuotaSpent(err) ? undefined : params.waits.shift();
        if (wait !== undefined) {
          this.recordFailedCall({ ...params, config, durationMs: Date.now() - startedAt, error: err });
          await this.noteFallback(
            `[retry] ${failed.model} failed on the provider's side (${reason}); trying again in ${Math.round(wait / 1000)}s.`,
            params,
          );
          await sleep(wait, params.signal);
          continue;
        }

        targets ??= providerFallbackTargets({
          config: this.config,
          agent: params.agentToolType,
          ...(params.runModel?.route ? { route: params.runModel.route } : {}),
          current: failed,
          hasImages: params.message.attachments.some((a) => a.type === "image" && Boolean(a.path)),
          attempted: params.attempted,
        });
        const next = targets.shift();
        if (!next) throw err;

        this.recordFailedCall({ ...params, config, durationMs: Date.now() - startedAt, error: err });
        params.attempted.add(next.model);
        config = { ...next.config, cacheKey: next.config.cacheKey ?? params.session.id };
        await this.noteFallback(
          capability
            ? `[fallback] ${failed.model} cannot do this (${capability}: ${reason}). This run used ${next.model} instead (${next.label}).`
            : `[fallback] ${failed.model} via ${failed.provider ?? "provider"} is unavailable (${reason}). This run used ${next.model} instead (${next.label}); it returns to ${failed.model} once the provider recovers.`,
          params,
        );
      }
    }
  }

  /** The note goes to the reader twice: live, and in front of the answer the history keeps. */
  private async noteFallback(note: string, params: { notes: string[]; onToken?: TokenCallback }): Promise<void> {
    params.notes.push(note);
    void log("warn", "provider fallback", { note });
    if (params.onToken) await params.onToken(`${note}\n\n`);
  }

  /** A call that never answered is still a call: analytics counts it, and so does its cost. */
  private recordFailedCall(params: {
    config: ResolvedLlmConfig;
    session: SessionData;
    message: UnifiedMessage;
    streaming: boolean;
    iteration: number;
    durationMs: number;
    error: unknown;
  }): void {
    recordApiCall({
      sessionId: params.session.id,
      parentSessionId: attributionParent(params.session),
      platform: params.message.platform,
      model: usageModelOf(params.config),
      baseUrl: params.config.baseUrl,
      providerKey: params.config.provider,
      streaming: params.streaming,
      caller: this.depth === 0 ? "orchestrator" : "subagent",
      workspace: usageWorkspaceOf(this.config, params.session),
      folderId: usageFolderOf(params.session),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      iteration: params.iteration,
      durationMs: params.durationMs,
      error: String((params.error as Error | undefined)?.message ?? params.error).slice(0, 500),
      ...cacheAttributionOf(params.config),
    });
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

    // The role is the session's, never the message's: a sub-agent's message carries its root's
    // platform, and that is how every sub-agent of a cron job ran with the cron role's tools.
    const agentToolType: AgentToolType = this.depth === 0
      ? (agentTypeOf(session) === "cron" ? "cron" : "main")
      : this.agentKind ?? "general";
    const isCron = agentToolType === "cron";
    const agent = resolveAgent(this.config, this.agentRegistry, agentToolType, session.workspace, session.scopeOverride);
    // A cron job's own switches are the same layer as its scope overrides: the role's floor is the
    // registry's (never granted), what this job was handed is the job's. docs/cron.md.
    const disabled = [
      ...(this.config.tools?.disabled ?? []),
      ...(agent.deny ?? []),
      ...(agentToolType === "cron" ? cronCapabilityDeny(session.scopeCapabilities, session.scopeOverride?.tools) : []),
    ];
    let tools = this.toolRegistry.getForAgent(
      agent.base,
      disabled,
      agent.mcp,
      agent.allow,
    );
    // A node agent's tools live on the remote machine: the registry knows none of them, so the
    // connection's manifest is the set, narrowed by the file's `tools:` and the denylist exactly
    // like a local baseline. The runner already refuses an offline node before the run starts;
    // this is the backstop for one that went away in between. docs/remote-nodes.md.
    let nodeRemoteNames: ReadonlySet<string> | undefined;
    if (agent.base === "node") {
      const nodeId = agent.node;
      const remote = nodeId ? nodeToolsFor(nodeId, { ...(agent.allow ? { allow: agent.allow } : {}), disabled }) : null;
      if (remote === null) {
        const name = nodeId ? nodeRecord(nodeId)?.name ?? nodeId : "unknown";
        return `Error: node "${name}" is offline. It reconnects on its own; try again once it is back.`;
      }
      tools = remote;
      nodeRemoteNames = new Set(remote.map((tool) => tool.name));
    }
    let openaiTools = toOpenAiToolDefinitions(tools);
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
    let llmConfig: ResolvedLlmConfig = { ...resolvedModel, cacheKey: resolvedModel.cacheKey ?? session.id };
    // What this run may do when the provider itself fails: the waits it owes (spent once, in
    // order), the models it already tried, and the notes it owes the reader for both.
    const providerWaits = providerRetryDelays(this.config.llm);
    const attemptedModels = new Set<string>([llmConfig.model]);
    const fallbackNotes: string[] = [];
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
    // One id for the run's marker and its snapshot: `/undo` reads the markers after the turn it
    // takes back and finds that turn's snapshots by it.
    const runId = currentRunId() ?? newRunId();
    let runSnapshotId: string | undefined;
    try {
      runSnapshotId = (await recordRunStart(session.id, workspaceDir, runId)).runId;
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
      // Scoped, not the full store: layer 5 tells the agent it MUST load (`skills`) anything listed, so
      // a catalog wider than the scope would advertise skills the tool then refuses.
      const allSkills = this.skillRegistry.list(agent.skills, session.workspace);
      const skillsOff = session.skillsOff ?? [];
      const skills = skillsOff.length > 0 ? allSkills.filter((s) => !skillsOff.includes(s.name)) : allSkills;
      const runWorkspace = this.workspaceFor(session);
      const suggestedSkills = await selectRelevantSkills(
        skills,
        message.text,
        this.config.memory?.embedding,
        this.config.skills?.suggest,
      );
      let systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model: llmConfig.model,
        sessionId: session.id,
        skills,
        workspaceDir: runWorkspace.workspaceDir,
        defaultWorkspaceDir: runWorkspace.defaultWorkspaceDir,
        workspaceKey: session.workspace,
        workspaces: this.config.workspaces,
        workspacePrompts: this.config.workspacePrompts,
        ...(agent.prompt ? { agentPrompt: agent.prompt } : {}),
        instructions: agent.instructions,
        layersOff: session.promptLayersOff,
      });
      hooks.emit("agent:prompt:built", { sessionId: session.id, model: llmConfig.model, systemPromptLength: systemPrompt.length });
      systemPrompt = (await hooks.transform("transform:system:prompt", { prompt: systemPrompt, sessionId: session.id, model: llmConfig.model })).prompt;

      // Every agent, not only the orchestrator: a research sub-agent reading documents is exactly
      // the profile that fills a window, and it used to have nothing but the hard trim. The prefix
      // goes in so the summary reads the cache the conversation already warmed instead of writing
      // its own prompt from scratch.
      if (autoCompactEnabled(this.config)) {
        await this.maybeAutoCompact(session, llmConfig, agentToolType, entries, signal, { systemPrompt, tools: openaiTools });
      }

      const userContent = this.preprocessor.buildUserContent(message);
      const transformedContent = (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
      const images = imageAttachmentsOf(message);
      const transcripts = this.preprocessor.transcriptsOf(message.id);
      // Sub-agent path: the runner already wrote the UserEntry to survive a crash before the
      // first turn. Skip it here to avoid a duplicate. A bubble is written once, so a message the
      // run already recorded as an injection -- or one a force-closed run left on the log for the
      // run that reroutes it -- is not written again either.
      // A Continue adds no turn: the run picks up the conversation exactly as it stands.
      const resuming = message.resume === true;
      if (resuming) {
        // Read again under the session's lock: the run that was going when Continue was pressed
        // may have finished since, and a finished run has nothing to pick up.
        const state = continuable(entries.entries(), entries.leaf());
        if (!state.ok) return state.reason;
      }
      const turnContext = turnContextBlock({
        now: new Date(startedAt),
        suggested: session.promptLayersOff?.includes("suggested") ? [] : suggestedSkills,
      });
      // A Continue adds no turn: the prompt it resumes is the one already on the log, block and all.
      const memoryBlock = resuming ? undefined : await this.memoryContext(message, session);
      const promptText = [turnContext, memoryBlock, transformedContent].filter(Boolean).join("\n\n");
      if (!userEntryWritten && !resuming && !entries.get(message.id)) {
        recorder.user({
          // The app has already drawn this bubble from chat.send. Reuse that id so a later sync
          // replaces it instead of appending a second copy.
          id: message.id,
          text: transformedContent,
          ...(promptText !== transformedContent ? { promptText } : {}),
          ...(images.length > 0 ? { attachments: images } : {}),
          ...(message.location ? { location: message.location } : {}),
          ...(transcripts.length > 0 ? { transcripts: Object.fromEntries(transcripts.map((t) => [t.path, t.text])) } : {}),
        });
      }
      // Sub-agent calls a lost run never settled get their result now, in the turn that made them
      // and before this run opens: that is where they belong, and without them the prompt does not
      // show them at all. Only on a Continue, the one run that means to pick that work back up.
      if (resuming) {
        for (const orphan of orphanCalls(entries.entries(), entries.leaf())) {
          entries.append<ToolEntry>({
            type: "tool",
            prompt: true,
            callId: orphan.callId,
            name: orphan.name,
            args: orphan.args,
            output: interruptedOutput(orphan.name, orphan.subagentId),
            truncated: false,
            ok: false,
            interrupted: true,
            runId: orphan.turnId,
          });
        }
      }
      // Read before this run's own marker: past it, the last run is this one, which has nothing.
      const resumable = resuming && tools.some((t) => t.name === "send")
        ? interruptedSubagents(entries.entries(), entries.leaf())
        : [];

      // The trigger turn is on the log: whatever this run writes from here on is its work, and
      // the marker lets a reopened thread fold that work until the matching runEnd -- the line
      // between the question and the work is exactly where a reader draws it.
      recorder.runStart(runId);

      // A Continue resumes the sub-agents the last run left interrupted before the model says
      // anything: each picks up its own work where it stopped, and its answer becomes the result
      // of a `send` the run makes on its own. Done here rather than left to the model, which,
      // told the id, copied it wrong two times in three (deepseek-v4.1-flash, 2026-09-28).
      if (resumable.length > 0) {
        recorder.nextTurn();
        recorder.turn({ content: "" });
        const calls = resumable.map((r) => ({ id: `resume_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, name: "send", arguments: { id: r.subagentId } as Record<string, unknown> }));
        const resumed = await Promise.allSettled(calls.map(async (tc) => {
          if (onToolStart) {
            try { await onToolStart(tc); }
            catch { /* a tool-start frame must never abort the run */ }
          }
          const callStartedAt = Date.now();
          const result = await this.executeTool({
            name: tc.name, args: tc.arguments, message, session, toolCallId: tc.id, signal, agentType: agentToolType, available: tools,
          });
          const durationMs = Date.now() - callStartedAt;
          if (onToolUse) {
            await onToolUse([{ id: tc.id, name: tc.name, arguments: tc.arguments, durationMs, output: result.content, ok: result.success }], session.verbose !== false);
          }
          return { result, durationMs };
        }));
        for (const [index, outcome] of resumed.entries()) {
          const tc = calls[index]!;
          const interrupted = outcome.status === "rejected";
          await recorder.tool({
            callId: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
            output: interrupted ? interruptedOutput(tc.name, resumable[index]!.subagentId) : outcome.value.result.content,
            ok: !interrupted && outcome.value.result.success,
            ...(interrupted ? { interrupted: true } : { durationMs: outcome.value.durationMs }),
          });
          toolExecutions += 1;
        }
        const stopped = resumed.find((outcome) => outcome.status === "rejected");
        if (stopped?.status === "rejected") throw stopped.reason;
        recorder.nextTurn();
      }

      // Thinking blocks are only needed to span the tool iterations of the turn that produced
      // them; older ones are a conversation's worth of signatures on every request, and the API
      // lets a client drop them from the start of the history -- docs/reasoning-replay.md.
      const history = promptOf(entries.entries(), entries.leaf());
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...(llmConfig.backend === "anthropic" ? keepCurrentTurnReasoning(history) : history),
      ];

      // Vision is resolved per model (resolver merges the model entry over the global flag):
      // the global default may be a text-only model while another configured model has vision.
      if (llmConfig.vision) {
        const attached = await this.attachImages(chatMessages, contextEntries(entries.entries(), entries.leaf()));
        if (attached > 0) void log("debug", "images attached to the prompt", { sessionId: session.id, model: llmConfig.model, images: attached });
      } else if (imageAttachmentsOf(message).length > 0) {
        void log("warn", "image dropped: the resolved model has no vision", { sessionId: session.id, model: llmConfig.model });
      }

      // A sub-agent's user entry was written by the runner before this run, without the per-turn
      // block. The main path persists the block on the entry itself (`promptText`), so the next run
      // rebuilds the same bytes; only this path needs the in-memory injection.
      if (userEntryWritten) {
        const preamble = [turnContext, memoryBlock].filter(Boolean).join("\n\n");
        if (preamble) this.injectTurnContext(chatMessages, preamble);
      }

      // Cut off mid-answer, the model restarts its answer from the top two times in three when
      // handed it alone; told where it stopped, it carries on mid-sentence (four in four, measured).
      // In the prompt only: the log keeps what was said, and nobody typed this.
      if (resuming && resumable.length === 0 && endsOnOwnText(entries.entries(), entries.leaf())) {
        chatMessages.push({ role: "user", content: CUT_OFF_NUDGE });
      }

      let toolSchemaTokens = estimateTokens(JSON.stringify(openaiTools));
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
        if (llmConfig.backend === "anthropic") {
          const bounded = keepCurrentTurnReasoning(chatMessages);
          chatMessages.length = 0;
          chatMessages.push(...bounded);
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
            await this.injectUserTurn(injected, chatMessages, session, Boolean(llmConfig.vision), recorder, entries, onTurnSwitch);
          }
        }
        iteration++;
        // A node's manifest and the record's switches belong to the owner, who may change them
        // while this run is going: the set is rebuilt for every turn, and a tool added now is
        // usable now. A changed tool block invalidates the provider's cached prefix for that
        // turn -- the owner's call, and the price of not running a stale set. A machine that
        // went away keeps the previous set, so its calls answer "not connected" instead of the
        // prompt emptying under the model.
        if (agent.base === "node" && agent.node) {
          const remote = nodeToolsFor(agent.node, { ...(agent.allow ? { allow: agent.allow } : {}), disabled });
          if (remote) {
            tools = remote;
            openaiTools = toOpenAiToolDefinitions(remote);
            nodeRemoteNames = new Set(remote.map((tool) => tool.name));
            toolSchemaTokens = estimateTokens(JSON.stringify(openaiTools));
            // The next run's turn-start gate reads this: a set that grew mid-run is what the
            // window actually carries from now on.
            session.lastFixedTokens = toolSchemaTokens + estimateTokens(systemPrompt);
          }
        }
        // Between two iterations, before the prompt is assembled: the loop is the only writer here
        // and the alternative is trimToContextWindow dropping the oldest turns for good.
        const currentEntryCount = contextEntries(entries.entries(), entries.leaf()).length;
        if (autoCompactEnabled(this.config) && currentEntryCount >= midRunCompactRetryAt) {
          const outcome = await this.compactMidRun(session, llmConfig, agentToolType, iteration, entries, signal, { systemPrompt, tools: openaiTools });
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
          sessionId: session.id,
          model: llmConfig.model,
          streaming,
          messageCount: chatMessages.length,
          toolCount: openaiTools.length,
          iteration,
        });
        // Not a token, so not `markEmitted`: a retry on another provider announces its own wait.
        try {
          await reasoningSink?.onCallStart?.();
        } catch {
          // A display frame must never abort the run.
        }

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
          const outcome = await this.runCompaction(session, signal, { sessionId: session.id, iteration, reason: "overflow" }, { systemPrompt, tools: openaiTools });
          if (outcome !== "compacted") return false;
          await rebuildPrompt();
          // Correction, not work: the iteration is given back so a run cannot spend its budget on
          // recovering from a prompt it never got to answer.
          budget.grant(1);
          return true;
        };

        let response: LlmResponse;
        // Anything the failing call already wrote -- a token, a reasoning delta -- is text the
        // owner can see, and a retry on another provider would write it twice. Read per attempt.
        let callEmitted = false;
        const markEmitted = (): void => {
          callEmitted = true;
        };
        const tokenSink = onToken
          ? async (token: string): Promise<void> => {
              markEmitted();
              await onToken(token);
            }
          : undefined;
        const reasoningGuard = reasoningSink
          ? {
              onText: async (delta: string): Promise<void> => {
                markEmitted();
                await reasoningSink.onText?.(delta);
              },
              onTokens: async (estimated: number): Promise<void> => {
                markEmitted();
                await reasoningSink.onTokens?.(estimated);
              },
            }
          : undefined;
        try {
          const attempt = await this.callModel({
            config: llmConfig,
            call: (config) =>
              tokenSink
                ? completeStream(
                    config,
                    chatMessages,
                    tokenSink,
                    openaiTools.length > 0 ? openaiTools : undefined,
                    signal,
                    reasoningGuard,
                  )
                : complete(
                    config,
                    chatMessages,
                    openaiTools.length > 0 ? openaiTools : undefined,
                    signal,
                  ),
            emitted: () => callEmitted,
            waits: providerWaits,
            attempted: attemptedModels,
            notes: fallbackNotes,
            runModel,
            session,
            message,
            agentToolType,
            iteration,
            streaming,
            signal,
            onToken,
          });
          // The run adopts whichever target answered: its context window, its vision, its usage
          // rows and its cache key all follow from here, for every turn that is left.
          llmConfig = attempt.config;
          response = attempt.response;
        } catch (err) {
          rethrowIfAborted(err, signal);
          if (isOverflowError(err) && (await recoverFromOverflow({ error: errorLogData(err) }))) continue;
          // A call that never answered is still a call. Analytics wrote a row only once a response
          // landed, so a provider outage left no trace at all: `errors` read zero through an
          // evening of dead runs while two bubbles said otherwise (2026-09-20). Same shape as the
          // success row below, zeroed, so an outage is countable and its cost is visible.
          recordApiCall({
            sessionId: session.id,
            parentSessionId: attributionParent(session),
            platform: message.platform,
            model: usageModelOf(llmConfig),
            baseUrl: llmConfig.baseUrl,
            providerKey: llmConfig.provider,
            streaming,
            caller: this.depth === 0 ? "orchestrator" : "subagent",
            workspace: usageWorkspaceOf(this.config, session),
            folderId: usageFolderOf(session),
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            toolCalls: 0,
            iteration,
            durationMs: Date.now() - llmStartedAt,
            error: String((err as Error | undefined)?.message ?? err).slice(0, 500),
            ...cacheAttributionOf(llmConfig),
          });
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
          providerKey: llmConfig.provider,
          streaming,
          caller: this.depth === 0 ? "orchestrator" : "subagent",
          workspace: usageWorkspaceOf(this.config, session),
          folderId: usageFolderOf(session),
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
                await this.injectUserTurn(m, chatMessages, session, Boolean(llmConfig.vision), recorder, entries, onTurnSwitch);
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
          const media = await this.mediaForMarker(message, session);
          recorder.runEnd("done", media.paths, media.ids);
          return withFallbackNotes(transformedResponse, fallbackNotes);
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

        // A card is settled the moment its own tool is done, not when the slowest sibling of the
        // batch is. One assistant message can carry a five-minute sub-agent beside three
        // one-second searches, and a batch-wide flush left those three spinning: their timer
        // measured the wait rather than the work, and their output arrived when the sub-agent
        // finally returned (2026-09-16). The recording below still runs in call order -- the
        // prompt has to, and a replay reads better for it.
        const settle = async (
          tc: typeof response.toolCalls[number],
          result: { content: string; success: boolean; attachments?: Attachment[] },
          durationMs: number,
        ) => {
          let transformedResult = (await hooks.transform("transform:tool:result", {
            toolName: tc.name,
            result: result.content,
            sessionId: session.id,
            toolCallId: tc.id,
          })).result;
          if (producesRemoteContent(tc.name) || nodeRemoteNames?.has(tc.name)) {
            transformedResult = normalizeUntrusted(transformedResult, `tool-result:${tc.name}`);
          }
          if (onToolUse) {
            await onToolUse(
              [{ id: tc.id, name: tc.name, arguments: tc.arguments, durationMs, output: transformedResult, ok: result.success }],
              session.verbose !== false,
            );
          }
          return { tc, result, durationMs, transformedResult };
        };

        const executeOne = async (tc: typeof response.toolCalls[number]) => {
          if (truncatedCalls) {
            void log("warn", "refused a tool call from a truncated turn", {
              ...runLogData(message, session),
              tool: tc.name,
              toolCallId: tc.id,
            });
            return await settle(tc, {
              content: "Error: the model's turn was cut off by the output limit, so this call's arguments are incomplete. It was not executed. Reissue it, and split the work if the arguments were long.",
              success: false,
            }, 0);
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
            return await settle(tc, { content: `Error: tool blocked by gate: ${toolGate.reason ?? "no reason"}`, success: false }, 0);
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

          return await settle(tc, result, durationMs);
        };

        // One call failing is a result, not the end of the batch: the other calls were asked for
        // by the same turn, their answers are still wanted, and what to do about the failure is
        // the model's decision on its next turn. The batch is therefore waited for in full.
        //
        // `Promise.all` used to settle on the first rejection and abandon its siblings: measured
        // 2026-09-21, two sub-agents ran 5 and 9 minutes past their parent's end and wrote into
        // its log *after* `run_end`, which then needed a dead-branch repair. Waiting in full also
        // means a run that ends here has no work of its own still in flight, whatever ends it.
        const outcomes = await Promise.allSettled(response.toolCalls.map((tc) => executeOne(tc)));
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        // Every call is written before the run ends, the interrupted ones included. The whole batch
        // used to be thrown away on the first rejection -- a Stop reaching a `spawn` -- with the
        // siblings that had finished: 295 stopped runs in this install left sub-agents the prompt
        // no longer showed, so the next run started them again from nothing (2026-09-28). A call
        // the run ended under gets the interruption as its result, and a sub-agent's names the
        // child, which a Continue then resumes -- docs/continue.md.
        const calls = response.toolCalls;
        const settled = outcomes.map((outcome, index) => {
          if (outcome.status === "fulfilled") return { ...outcome.value, interrupted: false };
          const tc = calls[index]!;
          const content = interruptedOutput(tc.name, subagentOfCall(entries.entries(), tc.id));
          const result: { content: string; success: boolean; attachments?: Attachment[] } = { content, success: false };
          return { tc, result, durationMs: undefined, transformedResult: content, interrupted: true };
        });

        for (const { tc, result, durationMs, transformedResult, interrupted } of settled) {
          toolExecutions += 1;
          // The card took the transformed output before the nested AGENTS.md injection: that text
          // is prompt plumbing, not something a tool card should show.
          let recordedOutput = transformedResult;
          if (nestedAgents && !interrupted) {
            recordedOutput += nestedAgents.collect(tc.name, tc.arguments);
          }
          // Recorded before the message is built, and the message comes back from the recording:
          // the whole output is archived first, then the two views are cut from it. The other order
          // is what once wrote a "full output" file that was itself truncated -- src/sessions/tool-output.ts.
          // A tool's images (a `read` of a PNG, a screenshot) are narrowed here and travel with
          // the entry and the live message: both views must be able to show the model what the
          // tool put in front of it (2026-09-22).
          const toolImages = (result.attachments ?? [])
            .filter((a) => a.type === "image" && Boolean(a.path))
            .map((a) => ({ type: "image" as const, path: a.path!, ...(a.mimeType ? { mimeType: a.mimeType } : {}) }));
          const recorded = await recorder.tool({
            callId: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
            output: recordedOutput,
            ok: result.success,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(toolImages.length > 0 ? { attachments: toolImages } : {}),
            ...(interrupted ? { interrupted: true } : {}),
          });
          stagnation.observe(recorded.message);
          chatMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              toolImages.length > 0
                ? await imageContentFrom(recorded.message, toolImages.map((a) => a.path))
                : recorded.message,
          });
        }
        if (failed?.status === "rejected") throw failed.reason;
      }

      hooks.emit("agent:budget:exhausted", {
        sessionId: session.id,
        iteration,
        maxIterations: budget.total,
        toolExecutions,
      });
      const summary = await this.handleMaxIterations(chatMessages, session, message, llmConfig, agentToolType, startedAt, toolExecutions, iteration, budget, recorder, signal);
      return withFallbackNotes(summary, fallbackNotes);
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
        const media = await this.mediaForMarker(message, session);
        recorder.runEnd("aborted", media.paths, media.ids);
        throw new AbortedError();
      }
      // The same ending as the abort above, and for the same reason: the cursor stays where the
      // run left it. Rewinding to the question is what made a run that died a branch `pathOf` does
      // not walk -- settled tool calls, their output and the phases around them on disk and in no
      // view, so a refresh served the question with nothing under it. The channel's `failure` entry
      // therefore lands after the run's last entry instead of on the question, and the next turn
      // reads the work rather than doing it again. What that costs is the dead attempt's tokens in
      // the next prompt -- docs/session-log.md 2.6.
      const media = await this.mediaForMarker(message, session);
      recorder.runEnd("error", media.paths, media.ids);
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
   * The text an injected message contributes, from the preprocessor and the channel's own hook.
   */
  private async injectedContent(injected: UnifiedMessage, session: SessionData): Promise<string> {
    const userContent = this.preprocessor.buildUserContent(injected);
    return (await hooks.transform("transform:user:content", { content: userContent, sessionId: session.id })).content;
  }

  /**
   * Puts the entry of every message waiting in the mailbox on the log, before this turn's rows.
   *
   * Called the moment the turn in flight comes back and before any of it is recorded. The turn may
   * be the run reacting to one of those messages -- a message that jumps a question cancels it, and
   * the reaction is the next turn -- and an entry written at the drain below would then land
   * underneath the very rows it caused. Neither claims nor drains: the message still belongs to the
   * prompt at the iteration boundary, which is the first point a user turn may be appended to it.
   */
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
    entries: SessionLog,
    onTurnSwitch?: (message: UnifiedMessage) => Promise<void>,
  ): Promise<void> {
    if (onTurnSwitch) await onTurnSwitch(injected);

    // Written here, at the drain, and nowhere earlier: this is where the model reads the message,
    // and where the app draws it -- a parked send holds the bottom of the thread until its ack, and
    // everything the run emits meanwhile lands above it (`insertionIndex`). The log is the replay
    // of that screen, so it takes the same position. An earlier write (at the return of the turn
    // in flight, 9aacf30) put the bubble above a turn that had started before the message was
    // sent, and a reopened thread no longer matched the one the owner had watched (2026-09-22).
    // Skipped when the log holds the bubble already: a run that force-closed left one behind for
    // the run that reroutes its message, and `Log.append` refuses a second id.
    const transformedContent = await this.injectedContent(injected, session);
    const images = imageAttachmentsOf(injected);
    if (!entries.get(injected.id)) {
      // What the trigger turn carries, the injected one carries too: the images are what every
      // later request and every reopened thread reads the picture back from, and the transcripts
      // are the text under a voice note -- without them a reopened thread drew the waveform bare.
      const transcripts = this.preprocessor.transcriptsOf(injected.id);
      recorder.user({
        // An injected app message already has a bubble open under its chat.send id.
        id: injected.id,
        text: transformedContent,
        ...(images.length > 0 ? { attachments: images } : {}),
        ...(injected.location ? { location: injected.location } : {}),
        ...(transcripts.length > 0 ? { transcripts: Object.fromEntries(transcripts.map((t) => [t.path, t.text])) } : {}),
      });
    }

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
      sessionId: session.id,
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
      providerKey: llmConfig.provider,
      streaming: false,
      caller: this.depth === 0 ? "orchestrator" : "subagent",
      workspace: usageWorkspaceOf(this.config, session),
      folderId: usageFolderOf(session),
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

    const media = await this.mediaForMarker(message, session);
    recorder.runEnd("done", media.paths, media.ids);
    return finalText;
  }

  /**
   * The time and the skill hint travel with the inbound turn, never in the system prompt: the
   * system prompt is the cached prefix, and a per-turn byte in it invalidates the conversation
   * cache (docs/prompt-caching.md). Every agent gets it, sub-agents included.
   */
  private injectTurnContext(chatMessages: ChatMessage[], block: string): void {
    const last = chatMessages[chatMessages.length - 1];
    // Only the inbound turn. A Continue ends on the assistant's cut answer, and prefixing an
    // older user message would rewrite history the cache already holds.
    if (!last || last.role !== "user") return;
    if (typeof last.content === "string") {
      chatMessages[chatMessages.length - 1] = { role: "user", content: `${block}\n\n${last.content}` };
    } else {
      chatMessages[chatMessages.length - 1] = { role: "user", content: [{ type: "text", text: block }, ...last.content] };
    }
  }

  /**
   * The recalled-memory block for the inbound turn, or nothing. Main agent only, and only when the
   * session has not switched recall off. Prompt-only: the caller persists it on the user entry so
   * the next run reconstructs the same prefix instead of rewriting the previous turn.
   */
  private async memoryContext(message: UnifiedMessage, session: SessionData): Promise<string | undefined> {
    if (this.depth !== 0) return undefined;
    if (this.config.memory?.enabled === false) return undefined;
    if (session.memoryRecallOff) return undefined;
    try {
      const mem = await recall(message.text, this.config.memory);
      if (!mem.text) return undefined;
      return (
        "<memory-context>\n" +
        "Relevant long-term memory (may be outdated; verify before relying on it):\n" +
        `${mem.text}\n` +
        "</memory-context>"
      );
    } catch (err) {
      void log("warn", "memory recall failed", { error: String(err) });
      return undefined;
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
  }): Promise<{ content: string; success: boolean; attachments?: Attachment[] }> {
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
      ...(tool.requiresApproval ? { confirm: true } : {}),
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
      if (result.attachments?.length && !result.keepFromReply) {
        for (const att of result.attachments) {
          // Copied into the conversation now, not at the end of the run: by then the tool's file
          // may be gone or overwritten, and the reply showed "(deleted)" (2026-10-04). The end
          // marker and the outgoing frame reuse this id instead of copying again.
          if (att.path && !att.id && this.mediaStore) {
            const id = await this.mediaStore(params.session.id, att.path).catch(() => undefined);
            if (id) att.id = id;
          }
          this.preprocessor.addResponseAttachment(params.message.id, att);
        }
      }
      if (result.success) {
        return {
          success: true,
          content: result.output.trim().length > 0 ? result.output : EMPTY_TOOL_OUTPUT,
          ...(result.attachments?.length ? { attachments: result.attachments } : {}),
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
    prefix?: CompactionPrefix,
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
      const result = await compactSession(this.config, session, undefined, signal, undefined, prefix);
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
      ...(result.archive ? { archive: result.archive } : {}),
    });
  }

  // Soft gate: estimation is a chars/4 heuristic, trimToContextWindow stays the hard
  // fallback at the limit. A compaction failure must never block the run.
  private async maybeAutoCompact(session: SessionData, llmConfig: ResolvedLlmConfig, agent: AgentToolType, entries: { entries: () => readonly Entry[]; leaf: () => string | null }, signal?: AbortSignal, prefix?: CompactionPrefix): Promise<void> {
    const gate = this.contextGate(session, llmConfig, agent, entries);
    if (!gate.over) return;

    void log("info", "auto-compaction triggered", gate.data);
    await this.runCompaction(session, signal, { sessionId: session.id }, prefix);
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
    prefix?: CompactionPrefix,
  ): Promise<"under" | "skipped" | "compacted"> {
    const gate = this.contextGate(session, llmConfig, agent, entries);
    if (!gate.over) return "under";

    void log("info", "auto-compaction triggered mid-run", { ...gate.data, iteration });
    return await this.runCompaction(session, signal, { sessionId: session.id, iteration }, prefix);
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
      if (paths.length > 0) withImages.push({ chatIndex, text: entry.promptText ?? entry.text, paths });
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

    // Tool images, matched by call id rather than by position: a tool message is identified by
    // its own `tool_call_id`, so the pairing cannot drift the way counting user slots once did.
    const toolTurns: Array<{ chatIndex: number; text: string; paths: string[] }> = [];
    for (const entry of path) {
      if (entry.type !== "tool") continue;
      const tool = entry as Extract<Entry, { type: "tool" }>;
      const paths = (tool.attachments ?? []).map((a) => a.path);
      if (paths.length === 0) continue;
      const chatIndex = chatMessages.findIndex((m) => m.role === "tool" && m.tool_call_id === tool.callId);
      if (chatIndex >= 0) toolTurns.push({ chatIndex, text: tool.output, paths });
    }
    let toolBudget = MAX_HISTORY_TOOL_IMAGES;
    for (const turn of toolTurns.reverse()) {
      if (toolBudget <= 0) break;
      const paths = turn.paths.slice(-toolBudget);
      toolBudget -= paths.length;
      const target = chatMessages[turn.chatIndex];
      if (target?.role !== "tool") continue;
      const content = await imageContentFrom(turn.text, paths);
      if (content.some((part) => part.type === "image_url")) {
        chatMessages[turn.chatIndex] = { role: "tool", tool_call_id: target.tool_call_id, content };
        attached += content.filter((part) => part.type === "image_url").length;
      }
    }
    return attached;
  }


}
