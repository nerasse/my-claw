import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import type { ToolCallResult } from "./tool-status.ts";

export type TokenCallback = (token: string) => Promise<void>;

export type ToolUseCallback = (tools: ToolCallResult[], verbose: boolean) => Promise<void>;

export type TurnSwitchCallback = (message: UnifiedMessage) => Promise<void>;

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
  setApprovalHandler(handler: ToolApprovalHandler | undefined): void;
  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal): Promise<string>;
  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
  ): Promise<string>;
}
