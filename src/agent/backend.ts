import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import type { ToolCallResult } from "./tool-status.ts";

export type TokenCallback = (token: string) => Promise<void>;

export type ToolUseCallback = (tools: ToolCallResult[], verbose: boolean) => Promise<void>;

export type TurnSwitchCallback = (message: UnifiedMessage) => Promise<void>;

/**
 * Where a run reports what the model is thinking -- docs/reasoning-visibility.md. Two shapes
 * because the engines differ in kind, not in degree: an OpenAI-compatible transport streams the
 * text, while the Claude Code bridge redacts it and only counts tokens. A channel that provides
 * neither callback gets nothing, which is how Matrix and Telegram stay untouched.
 */
export interface ReasoningSink {
  /** Reasoning text, incremental. */
  onText?: (delta: string) => Promise<void>;
  /** Running token estimate while a redacted engine thinks. No text will follow. */
  onTokens?: (estimated: number) => Promise<void>;
}

/**
 * What `/compact` answers with. The summary is present only when the engine can hand one back:
 * the local summarizer wrote it, and the SDK one is read out of the transcript afterwards. The
 * channels that can render it collapsed show it; the others show `text` alone.
 */
export interface CompactOutcome {
  text: string;
  summary?: string;
}

// The contract between the message router/channels and an agent execution engine.
// Two implementations are planned: the home OpenAI-compatible loop (AgentBridge)
// and the Claude Agent SDK backend (docs/claude-sdk-backend.md). Everything
// outside the engine (router, channels, cron, /stop, /status) depends on this
// interface only, so backends can be selected per resolved model.
export interface AgentBackend {
  preprocessMessage(message: UnifiedMessage): Promise<void>;
  getEchoMessages(messageId: string): OutgoingMessage[];
  getResponseAttachments(messageId: string): OutgoingMessage["attachments"];
  hadAudioInbound(messageId: string): boolean;
  /** Speech-to-text output per recording, for channels that render it beside its own bubble. */
  transcriptsOf(messageId: string): Array<{ path: string; text: string }>;
  setApprovalHandler(handler: ToolApprovalHandler | undefined): void;
  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal, modelId?: string): Promise<string>;
  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
    modelId?: string,
    // Appended last on purpose: inserting a parameter ahead of an existing one has already bitten
    // this codebase (the `queryFn` test seam on ClaudeSdkBackend).
    reasoning?: ReasoningSink,
  ): Promise<string>;
}
