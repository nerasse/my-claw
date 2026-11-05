/** @file Hook event type definitions. */

import type { UnifiedMessage } from "../channels/types.ts";
import type { LlmUsage } from "../llm/provider.ts";

// =============================================================================
// Void events -- fire-and-forget, parallel execution
// =============================================================================

export interface HookEventMap {
  // === APP LIFECYCLE ===
  "app:ready": { channels: string[] };
  "app:shutdown": { signal: string };
  "app:error": { error: unknown; type: "rejection" | "exception" };
  "config:reloaded": { changed: string[]; rebootRequired: string[] };
  /** `.env` changed and no config section did: a key that appeared or went can still change which engine answers. */
  "env:refreshed": Record<string, never>;
  /** config.json was unusable at boot; the agent started on a snapshot instead. */
  "config:fallback": { ref: string; error: string };

  // === MESSAGE LIFECYCLE ===
  "message:received": { message: UnifiedMessage };
  "message:preprocessed": { message: UnifiedMessage; transcription?: string };
  "message:route:start": { message: UnifiedMessage; sessionId: string };
  /** Mid-run steering: the message joined an in-flight run instead of starting its own. */
  /** A message arrived while a run was active, so it was parked in the run's mailbox.
   *  Emitted at enqueue time — the drain moment is `message:injected` below. This split exists
   *  because the two events drive different UI states ("queued for the next turn" vs
   *  "drained into the run").
   */
  "message:injection:queued": { message: UnifiedMessage; sessionId: string };
  /** A queued injection was actually drained into the run at a turn boundary. Emitted from the
   *  `onTurnSwitch` callback, which is the single point where the home loop hands a new turn
   *  the message it will answer.
   */
  "message:injected": { message: UnifiedMessage; sessionId: string };
  /**
   * The message is parked before its run: a compaction is rewriting the history it would resume.
   * Nothing else travels for the minute or two this takes, so the channel gets to say so instead
   * of leaving a send with no answer behind it.
   */
  "message:queued": { message: UnifiedMessage; sessionId: string; reason: "compaction" };
  "message:route:complete": {
    message: UnifiedMessage;
    sessionId: string;
    response: string;
    durationMs: number;
  };
  "message:route:error": {
    message: UnifiedMessage;
    sessionId: string;
    error: unknown;
    durationMs: number;
  };
  /**
   * The run was stopped by the owner. Its own end, distinct from an error: the router swallows
   * the abort (the command that caused it already answered), so without this a channel could
   * not tell a stopped run from a finished one.
   */
  "message:route:aborted": {
    message: UnifiedMessage;
    sessionId: string;
    durationMs: number;
  };
  "message:delivered": {
    platform: string;
    chatId: string;
    text: string;
    attachments: number;
  };

  // === AGENT LIFECYCLE ===
  "agent:run:start": {
    messageId: string;
    sessionId: string;
    model: string;
    streaming: boolean;
    maxIterations: number;
  };
  "agent:prompt:built": {
    sessionId: string;
    model: string;
    systemPromptLength: number;
  };
  "agent:turn:start": {
    sessionId: string;
    model: string;
    iteration: number;
  };
  "agent:turn:end": {
    sessionId: string;
    model: string;
    iteration: number;
    hasToolCalls: boolean;
    finishReason?: string;
    incomplete?: boolean;
  };
  "agent:run:finish": {
    messageId: string;
    sessionId: string;
    model: string;
    iterations: number;
    toolExecutions: number;
    responseChars: number;
    durationMs: number;
    usage?: LlmUsage;
  };
  "agent:run:error": {
    messageId: string;
    sessionId: string;
    model: string;
    toolExecutions: number;
    durationMs: number;
    error: unknown;
  };
  "agent:run:aborted": {
    messageId: string;
    sessionId: string;
    model: string;
    toolExecutions: number;
    durationMs: number;
  };
  "agent:budget:exhausted": {
    sessionId: string;
    iteration: number;
    maxIterations: number;
    toolExecutions: number;
  };

  // === LLM LIFECYCLE ===
  "llm:call:start": {
    /** The session the call belongs to, so a channel can address what it draws about it. */
    sessionId: string;
    model: string;
    streaming: boolean;
    messageCount: number;
    toolCount: number;
    iteration: number;
  };
  "llm:call:end": {
    model: string;
    streaming: boolean;
    durationMs: number;
    usage?: LlmUsage;
    toolCallCount: number;
  };
  "llm:call:error": {
    model: string;
    error: unknown;
    attempt: number;
    willRetry: boolean;
  };
  "llm:circuit:opened": { failures: number; cooldownMs: number; baseUrl: string };
  "llm:circuit:closed": { baseUrl: string };

  // === TOOL LIFECYCLE ===
  "tool:execute:start": {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    iteration: number;
    args: Record<string, unknown>;
  };
  "tool:execute:end": {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    success: boolean;
    outputChars: number;
    durationMs: number;
  };
  /** Live output from a long-running tool (bash today). Fired in throttled chunks while the
   *  tool runs, before `tool:execute:end`. */
  "tool:execute:progress": {
    toolCallId: string;
    sessionId: string;
    chunk: { stdout?: string; stderr?: string };
  };
  "tool:execute:error": {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    error: unknown;
    durationMs: number;
  };
  "tool:approval:check": {
    toolName: string;
    sessionId: string;
    decision: string;
  };
  /**
   * A prompt is on the owner's screens and the tool waits on the answer. Emitted by the channel
   * that raised it, after its own guards, so a listener notifies about a question that exists.
   * The thread is the conversation the prompt is drawn in, which for a sub-agent's tool is its
   * parent's -- nobody watches a sub-agent's own screen.
   */
  "approval:requested": {
    owner: string;
    threadId: string;
    sessionId: string;
    toolName: string;
    /** The agent asked by itself: the run waits until the owner answers, so the push says so. */
    waitForever: boolean;
  };
  "tool:bash:execute": {
    command: string;
    exitCode: number;
    durationMs: number;
  };
  "tool:file:write": { path: string; size: number };
  "tool:file:read": { path: string; size: number };
  "tool:fetch:request": {
    url: string;
    method: string;
    status?: number;
    /** Served from the short-lived GET cache instead of the network. */
    cached?: boolean;
  };

  // === SESSION LIFECYCLE ===
  "session:created": { sessionId: string; platform: string; chatType: string; workspace?: string };
  "session:loaded": { sessionId: string };
  "session:workspace": { sessionId: string; workspace?: string };
  "session:persisted": { sessionId: string };
  "session:archived": { sessionId: string; archivePath: string };
  "session:deleted": { sessionId: string };
  "session:evicted": { sessionId: string };
  "session:compact:start": { sessionId: string; messageCount: number };
  /**
   * A fragment of the summary a compaction is writing, as it arrives.
   *
   * The summarizer streams, so a window can show the text being written next to the operation it
   * belongs to instead of a bare spinner. Fragments, not a running total: the reader accumulates
   * them, and re-sending the whole text per batch would cost the square of the summary's length.
   * Batched at the source -- one hook per token would be one frame per token.
   */
  "session:compact:progress": { sessionId: string; text: string };
  /**
   * What the summarizer is thinking, as it thinks it.
   *
   * Its own event rather than a flag on `:progress`: the two are different things on screen, and
   * a compaction inheriting `reasoning_effort: max` can think for a minute before its first word.
   * Dropped on the floor until 2026-09-14, which made a thinking model look like a dead one.
   */
  "session:compact:reasoning": { sessionId: string; text: string };
  "session:compact:end": {
    sessionId: string;
    beforeCount: number;
    afterCount: number;
    summaryLength: number;
  };
  "session:compact:error": { sessionId: string; reason: string };
  /**
   * The operation is over, whatever the outcome: rewritten, nothing to rewrite, failed, aborted.
   * Emitted from a `finally`, which is the point of it -- `session:compact:end` and
   * `session:compact:error` cover the two ends that have something to report, and the three that
   * have nothing (no plan, no summary, an abort) used to end in silence. A listener that draws
   * "compacting" from `session:compact:start` would hold it forever on those.
   */
  "session:compact:settled": { sessionId: string };
  /**
   * A boundary was appended by one of the automatic gates, and the conversation on screen should
   * show it now rather than at the next history load.
   *
   * Addressed by session id, like `session:compact:start` and `:settled`, so a channel picks out
   * the conversations it owns and skips the rest. It used to carry the triggering message instead,
   * which is why only automatic passes could fire it: a `/compact` the owner typed has no such
   * message, and it needs the boundary drawn just as much.
   *
   * Deliberately not wired to any notification: a compaction the owner did not ask for is not an
   * event he has to be told about, and a tray entry (or a ring) for it would be noise.
   */
  "session:compact:boundary": {
    sessionId: string;
    entryId: string;
    summary: string;
    count: number;
    /** What the boundary archived, when it archived something. */
    archive?: string;
  };
  /**
   * A `/compact` the owner typed is over, whichever engine answered it. The three events above
   * live inside the local summarizer and the SDK engine never reaches them, so this is the only
   * one that fires on both paths, once per command, on success and on failure alike.
   */
  "session:compact:finished": {
    sessionId: string;
    /** The app thread the command came from, for the notification's deep link. */
    threadId?: string;
    engine: "sdk" | "local";
    durationMs: number;
    /** The history was rewritten. False is every other end, including "nothing to compact". */
    ok: boolean;
    /** The outcome line the user reads in the chat. */
    text: string;
  };
  "session:model:changed": {
    sessionId: string;
    previousModel: string;
    newModel: string;
  };
  /**
   * A turn reported the prompt it was sent, so how full the window is has just changed. Emitted at
   * each engine's earliest authoritative moment: the home loop when the response lands, the SDK on
   * `message_start`, before a token of the answer. Carries no number on purpose -- a listener reads
   * the occupancy from the session, so the screen and the compaction gate can never quote two
   * different figures.
   */
  "session:context:measured": { sessionId: string };
  /** A row landed in analytics: the spend of `sessionId`, billed to `parentSessionId` (itself for a root). */
  "analytics:call:recorded": { sessionId: string; parentSessionId: string };
  /**
   * A provider's own ledger was read and the figures moved: what it says it charged the key is on
   * every status report, and belongs to no conversation, so this is the one spend event with no
   * session on it.
   *
   * Emitted on a **successful network read only**, never when the cache answered: a five-minute
   * cache answering an idle page twelve times an hour would push twelve reports at a phone for
   * figures that did not move. See docs/status-command.md.
   */
  "llm:account:refreshed": { provider: string };

  // === MEMORY LIFECYCLE ===
  "memory:store": { id: number; category: string; decision: string };
  "memory:recall": { query: string; hitCount: number; semantic: boolean };
  "memory:consolidate": { categoriesProcessed: number; before: number; after: number };
  "memory:backfill": { embedded: number };

  // === MODEL CATALOG ===
  "models:discovered": { count: number; anyFailed: boolean };
  /**
   * A run had to skip a configured model that cannot run and fell back down the chain. Emitted
   * once per run, never per request: a run is dozens of requests, and a warning on each is a
   * warning that gets ignored. See docs/model-resolution.md.
   */
  "model:fallback": {
    platform: string;
    chatId: string;
    threadId?: string;
    /** The agent whose chain degraded: the orchestrator, cron, or a sub-agent's name. */
    agent: string;
    /** The model that could not run, and where it is pinned. */
    model: string;
    origin: string;
    /** Why, in words the owner can act on. */
    reason: string;
    /** What ran instead. */
    ran: string;
  };

  // === MCP LIFECYCLE ===
  "mcp:synced": { servers: string[]; toolCount: number };

  // === TOOL PLUGIN LIFECYCLE ===
  "tools:pluginsReloaded": { count: number };

  // === SKILL LIFECYCLE ===
  "skills:loaded": { count: number };
  "skills:reloaded": { count: number };
  "skill:read": { name: string };
  "skill:created": { name: string };
  "skill:updated": { name: string };
  "skill:deleted": { name: string };

  // === AGENT DEFINITION LIFECYCLE ===
  "agents:loaded": { count: number };
  "agents:reloaded": { count: number };

  // === SUBAGENT LIFECYCLE ===
  "subagent:spawn": {
    id: string;
    displayName: string;
    type: string;
    mode: string;
    /** The parent run that asked for this spawn; routes the event to its streamer/roster. */
    parentSessionId: string;
    /** The `spawn` or `send` tool call that produced this, if any. Lets a live card target the tool-start card. */
    toolCallId?: string;
    /**
     * `spawn` created the sub-agent, `send` drove an existing one. Both go through the same
     * lifecycle so the card, the persisted state and the roster behave identically; only the
     * wording differs.
     */
    action: "spawn" | "send";
    /** What the child is asked to do: the spawn's task, or the message a `send` carries. */
    task?: string;
  };
  "subagent:complete": { id: string; resultLength: number; parentSessionId: string };
  "subagent:error": { id: string; error: unknown; parentSessionId: string };
  "subagent:aborted": { id: string; parentSessionId: string };
  "subagent:killed": { id: string; parentSessionId: string; callerSessionId?: string };
  "subagent:reset": { id: string; parentSessionId: string; callerSessionId?: string };

  // === CRON LIFECYCLE ===
  "cron:tick": { dueCount: number; totalJobs: number };
  "cron:job:start": { jobId: string; jobName: string };
  /** A browser window kept for a while is about to close with its pages: the owner may keep it. */
  "browser:hold:expiring": { holder: string; alias: number; until: number; label?: string; url?: string };
  "cron:job:end": {
    jobId: string;
    jobName: string;
    /** The run's session: its thread is where the tap lands. */
    sessionId: string;
    success: boolean;
    silent: boolean;
    durationMs: number;
  };
  "cron:job:error": { jobId: string; jobName: string; sessionId: string; error: unknown; silent: boolean };
  /** A run of the job is still going past its alert time: announced, never stopped. */
  "cron:job:long": { jobId: string; jobName: string; sessionId: string; runningMs: number; working: number; depth: number; costUsd?: number };
  "cron:job:delivered": {
    jobId: string;
    platform: string;
    chatId: string;
  };
  "cron:job:created": { jobId: string; jobName: string };
  "cron:job:updated": { jobId: string };
  "cron:job:removed": { jobId: string };
  "cron:job:paused": { jobId: string };
  "cron:job:resumed": { jobId: string };
  "cron:job:triggered": { jobId: string };

  // === COMMAND LIFECYCLE ===
  "command:received": {
    command: string;
    args: string;
    platform: string;
    userId: string;
  };
  "command:handled": {
    command: string;
    platform: string;
    response?: string;
  };

  // === STREAMING LIFECYCLE ===
  "stream:start": { platform: string; chatId: string };
  "stream:finish": { platform: string; chatId: string };
  "stream:abort": { platform: string; chatId: string; error: unknown };

  // === CHANNEL LIFECYCLE ===
  "channel:started": { platform: string };
  "channel:stopped": { platform: string };
  "channel:error": { platform: string; error: unknown };
}

export type HookEventName = keyof HookEventMap;
export type HookHandler<T> = (payload: T) => void | Promise<void>;

// =============================================================================
// Gate events -- sequential, can block/cancel operations
// =============================================================================

export interface GateEventMap {
  "gate:message:incoming": { message: UnifiedMessage };
  "gate:tool:before": {
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
  };
  "gate:agent:before:reply": {
    sessionId: string;
    message: UnifiedMessage;
  };
  "gate:message:outgoing": {
    platform: string;
    chatId: string;
    text: string;
  };
  "gate:cron:job:before": { jobId: string; jobName: string };
  "gate:memory:write": { content: string; category: string };
}

export type GateEventName = keyof GateEventMap;
export type GateHandler<T> = (
  payload: T,
) => { allow: boolean; reason?: string } | Promise<{ allow: boolean; reason?: string }>;
export type GateResult = { allowed: boolean; reason?: string };

// =============================================================================
// Waterfall events -- sequential, transform data
// =============================================================================

export interface WaterfallEventMap {
  "transform:system:prompt": { prompt: string; sessionId: string; model: string };
  "transform:user:content": { content: string; sessionId: string };
  "transform:tool:result": {
    toolName: string;
    result: string;
    sessionId: string;
    toolCallId: string;
  };
  "transform:agent:response": { response: string; sessionId: string; model: string };
  "transform:outgoing:message": {
    text: string;
    platform: string;
    chatId: string;
  };
}

export type WaterfallEventName = keyof WaterfallEventMap;
export type WaterfallHandler<T> = (payload: T) => T | Promise<T>;
