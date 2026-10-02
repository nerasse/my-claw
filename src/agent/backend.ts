import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import type { RunModelOverride } from "../llm/run-model.ts";
import type { ToolCallResult } from "./tool-status.ts";

export type TokenCallback = (token: string) => Promise<void>;

export type ToolUseCallback = (tools: ToolCallResult[], verbose: boolean) => Promise<void>;

/** A tool the model requested started executing. Fires before ToolUseCallback, which carries
 *  the finished result. The id is the tool_use id from the model and stays stable across both
 *  callbacks so the output layer can upsert one card. */
export type ToolStartCallback = (tool: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<void> | void;

export type TurnSwitchCallback = (message: UnifiedMessage) => Promise<void>;

/**
 * Where a run reports what the model is thinking -- docs/reasoning-visibility.md. Two shapes
 * because the engines differ in kind, not in degree: an OpenAI-compatible transport streams the
 * text, while the Claude Code bridge redacts it and only counts tokens. A channel that provides
 * neither callback gets nothing, which is how a channel without a sink stays untouched.
 */
export interface ReasoningSink {
  /** Reasoning text, incremental. */
  onText?: (delta: string) => Promise<void>;
  /** Running token estimate while a redacted engine thinks. No text will follow. */
  onTokens?: (estimated: number) => Promise<void>;
  /**
   * A model call of this run began; nothing has come out of it yet. On the run's own sink, never a
   * global hook: a hook is heard by every listener on the session, and a message folded into a run
   * in flight has one too -- each announced the run's calls in its own bubble, so every turn after
   * a mid-run message wore two (2026-10-01).
   */
  onCallStart?: () => Promise<void>;
}

/**
 * What `/compact` answers with. The summary is present only when the engine can hand one back:
 * the local summarizer wrote it, and the SDK one is read out of the transcript afterwards. The
 * channels that can render it collapsed show it; the others show `text` alone.
 */
export interface CompactOutcome {
  text: string;
  summary?: string;
  /**
   * The history was actually rewritten. False covers every other end (nothing to compact, a
   * refusal, a timeout, a /stop), which reads the same in the chat but must not be announced
   * as a completed compaction.
   */
  ok?: boolean;
}

// The contract between the message router/channels and an agent execution engine. The home
// loop is the only implementation: the OpenAI-compatible path, the Codex subscription transport,
// and the native Anthropic Messages transport. Everything outside the engine (router, channels,
// cron, /stop, /status) depends on this interface only, so engines can be swapped without
// touching them.
export interface AgentBackend {
  preprocessMessage(message: UnifiedMessage): Promise<void>;
  getEchoMessages(messageId: string): OutgoingMessage[];
  getResponseAttachments(messageId: string): OutgoingMessage["attachments"];
  hadAudioInbound(messageId: string): boolean;
  /** Speech-to-text output per recording, for channels that render it beside its own bubble. */
  transcriptsOf(messageId: string): Array<{ path: string; text: string }>;
  setApprovalHandler(handler: ToolApprovalHandler | undefined): void;

  /** Where a run stores what its tools produced -- the channel owns the bytes, never the agent. */
  setMediaStore(store: MediaStoreHook | undefined): void;
  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal, modelId?: string, modelOverride?: RunModelOverride, userEntryWritten?: boolean): Promise<string>;
  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
    modelId?: string,
    // Appended last on purpose: inserting a parameter ahead of an existing one has already bitten
    // this codebase.
    reasoning?: ReasoningSink,
    onToolStart?: ToolStartCallback,
    modelOverride?: RunModelOverride,
    userEntryWritten?: boolean,
  ): Promise<string>;
}

/**
 * Stores one file a run produced, where a device can fetch it, and answers the id it is stored
 * under. Injected by the channel; the session id is what tells it which conversation owns the copy
 * (a sub-agent's run stores into its parent's thread, which is where its pictures are shown).
 */
export type MediaStoreHook = (sessionId: string, path: string) => Promise<string | undefined>;
