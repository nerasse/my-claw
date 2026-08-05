/** Wire protocol for the mobile channel. Spec: docs/mobile-channel.md. */

export interface MobileAttachmentMeta {
  id: string;
  type: "image" | "audio" | "video" | "file";
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  audioAsVoice?: boolean;
}

/** Default conversation for devices that do not send a threadId. */
export const DEFAULT_MOBILE_THREAD = "default";

export interface MobileChatSend {
  type: "chat.send";
  id: string;
  text: string;
  threadId?: string;
  ts?: string;
}

export interface MobileSessionList {
  type: "session.list";
}

export interface MobileCommandsList {
  type: "commands.list";
}

export interface MobileSessionHistory {
  type: "session.history";
  threadId: string;
  limit?: number;
}

export interface MobileSessionArchive {
  type: "session.archive";
  threadId: string;
}

export interface MobileSessionDelete {
  type: "session.delete";
  threadId: string;
}

export interface MobileApprovalResponse {
  type: "approval.response";
  id: string;
  accepted: boolean;
}

export interface MobileCapabilitiesFrame {
  type: "device.capabilities";
  accessibility?: boolean;
  notificationListener?: boolean;
  wssConnection?: boolean;
  version?: string;
}

export interface MobilePing {
  type: "ping";
}

/** Accepted from the device. Plain-text frames are treated as chat.send (M1 console). */
export type MobileClientFrame =
  | MobileChatSend
  | MobileSessionList
  | MobileCommandsList
  | MobileSessionHistory
  | MobileSessionArchive
  | MobileSessionDelete
  | MobileApprovalResponse
  | MobileCapabilitiesFrame
  | MobilePing;

export interface MobileToolCallEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  durationMs?: number;
  ok: boolean;
  output: string;
  truncated: boolean;
}

/** Tool card, sent between two text bubbles of the same turn. Suppressed when verbose is off. */
export interface MobileToolCall extends MobileToolCallEntry {
  type: "chat.tool";
  threadId: string;
  turnId: string;
  ts: string;
}

export type MobileHistoryEntry =
  | { id: string; role: "user" | "assistant"; text: string; ts: string }
  | ({ role: "tool"; ts: string } & MobileToolCallEntry);

export interface MobileSessionSummary {
  threadId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface MobileChatMessage {
  type: "chat.message";
  id: string;
  text: string;
  threadId: string;
  attachments: MobileAttachmentMeta[];
  replyToId?: string;
  ts?: string;
}

export interface MobileStreamStart {
  type: "chat.stream.start";
  id: string;
  threadId: string;
  replyToId?: string;
  ts?: string;
}

export interface MobileStreamDelta {
  type: "chat.stream.delta";
  id: string;
  threadId: string;
  text: string;
}

export interface MobileStreamDone {
  type: "chat.stream.done";
  id: string;
  threadId: string;
}

export interface MobileStreamAbort {
  type: "chat.stream.abort";
  id: string;
  threadId: string;
  error?: string;
}

export interface MobileApprovalRequest {
  type: "approval.request";
  id: string;
  threadId: string;
  toolName: string;
  args: Record<string, unknown>;
  replyToId?: string;
  expiresAt: number;
}

export interface MobileSessionListResult {
  type: "session.list.result";
  sessions: MobileSessionSummary[];
}

export interface MobileCommandsResult {
  type: "commands.list.result";
  commands: Array<{ name: string; description: string }>;
}

export interface MobileChatHistory {
  type: "chat.history";
  threadId: string;
  messages: MobileHistoryEntry[];
}

export interface MobileError {
  type: "error";
  message: string;
}

export type MobileServerFrame =
  | MobileChatMessage
  | MobileStreamStart
  | MobileStreamDelta
  | MobileStreamDone
  | MobileStreamAbort
  | MobileToolCall
  | MobileApprovalRequest
  | MobileSessionListResult
  | MobileCommandsResult
  | MobileChatHistory
  | MobileError;
