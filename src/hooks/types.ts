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
  /** config.json was unusable at boot; the agent started on a snapshot instead. */
  "config:fallback": { ref: string; error: string };

  // === MESSAGE LIFECYCLE ===
  "message:received": { message: UnifiedMessage };
  "message:preprocessed": { message: UnifiedMessage; transcription?: string };
  "message:route:start": { message: UnifiedMessage; sessionId: string };
  /** Mid-run steering: the message joined an in-flight run instead of starting its own. */
  "message:injected": { message: UnifiedMessage; sessionId: string };
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
  "llm:circuit:opened": { failures: number; cooldownMs: number };
  "llm:circuit:closed": Record<string, never>;

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
  };

  // === SESSION LIFECYCLE ===
  "session:created": { sessionId: string; platform: string; chatType: string; workspace?: string };
  "session:loaded": { sessionId: string; messageCount: number };
  "session:persisted": { sessionId: string; messageCount: number };
  "session:reset": { sessionId: string; platform: string; archived: boolean };
  "session:cleared": { sessionId: string; previousMessageCount: number };
  "session:archived": { sessionId: string; archivePath: string };
  "session:deleted": { sessionId: string };
  "session:evicted": { sessionId: string };
  "session:compact:start": { sessionId: string; messageCount: number };
  "session:compact:end": {
    sessionId: string;
    beforeCount: number;
    afterCount: number;
    summaryLength: number;
  };
  "session:compact:error": { sessionId: string; reason: string };
  "session:model:changed": {
    sessionId: string;
    previousModel: string;
    newModel: string;
  };
  "session:messages:trimmed": {
    sessionId: string;
    beforeCount: number;
    afterCount: number;
  };
  /** Local history was replayed into a fresh SDK session (home backend -> claude-sdk). */
  "session:context:transferred": {
    sessionId: string;
    at: string;
    model: string;
    messages: number;
    dropped: number;
    tokens: number;
  };

  // === MEMORY LIFECYCLE ===
  "memory:store": { id: number; category: string; decision: string };
  "memory:recall": { query: string; hitCount: number; semantic: boolean };
  "memory:consolidate": { categoriesProcessed: number; before: number; after: number };
  "memory:backfill": { embedded: number };

  // === MODEL CATALOG ===
  "models:discovered": { count: number; anyFailed: boolean };

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
  };
  "subagent:complete": { id: string; resultLength: number };
  "subagent:error": { id: string; error: unknown };
  "subagent:aborted": { id: string };
  "subagent:killed": { id: string };
  "subagent:reset": { id: string };

  // === CRON LIFECYCLE ===
  "cron:tick": { dueCount: number; totalJobs: number };
  "cron:job:start": { jobId: string; jobName: string };
  "cron:job:end": {
    jobId: string;
    jobName: string;
    success: boolean;
    silent: boolean;
    durationMs: number;
  };
  "cron:job:error": { jobId: string; jobName: string; error: unknown; silent: boolean };
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
  "gate:session:reset": { sessionId: string };
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
