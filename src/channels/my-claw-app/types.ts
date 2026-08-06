/** Wire protocol for the my-claw-app channel. Spec: docs/my-claw-app-channel.md. */

export interface MyClawAppAttachmentMeta {
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

/**
 * Attachment of a replayed turn. Same shape as the live meta plus `deleted`, set when the blob
 * is gone from the thread: the app still names it, but has nothing to open.
 */
export interface MyClawAppHistoryAttachment extends MyClawAppAttachmentMeta {
  deleted?: boolean;
}

/** Default conversation for devices that do not send a threadId. */
export const DEFAULT_THREAD = "default";

export interface MyClawAppAttachmentRef {
  id: string;
  type: "image" | "audio" | "video" | "file";
  /**
   * Held-the-mic recording rather than an audio file the owner picked. Only the device knows,
   * and the distinction decides the STT language policy: dictation gets the configured language,
   * an arbitrary file gets auto-detection, because forcing a language on unknown speech makes
   * Whisper invent plausible words instead of failing. Honoured only on a stored audio file.
   */
  audioAsVoice?: boolean;
  /** Measured while recording; the server would need to decode the file to learn it. */
  durationMs?: number;
}

export interface MyClawAppChatSend {
  type: "chat.send";
  id: string;
  text: string;
  threadId?: string;
  ts?: string;
  attachments?: MyClawAppAttachmentRef[];
}

export interface MyClawAppSessionList {
  type: "session.list";
}

export interface MyClawAppCommandsList {
  type: "commands.list";
}

export interface MyClawAppFilesList {
  type: "files.list";
  threadId: string;
}

export interface MyClawAppFileDelete {
  type: "files.delete";
  threadId: string;
  id: string;
}

export interface MyClawAppSessionHistory {
  type: "session.history";
  threadId: string;
  limit?: number;
}

export interface MyClawAppSessionArchive {
  type: "session.archive";
  threadId: string;
}

export interface MyClawAppSessionDelete {
  type: "session.delete";
  threadId: string;
}

export interface MyClawAppApprovalResponse {
  type: "approval.response";
  id: string;
  accepted: boolean;
}

export interface MyClawAppCapabilitiesFrame {
  type: "device.capabilities";
  accessibility?: boolean;
  notificationListener?: boolean;
  wssConnection?: boolean;
  version?: string;
}

export interface MyClawAppPing {
  type: "ping";
}

/** Health snapshot, meant to be copy-pasted out of the app. */
export interface MyClawAppDiagSnapshot {
  type: "diag.snapshot";
  threadId?: string;
}

/** Tail of the server log files, filtered. `run` is the correlation id stamped on every line. */
export interface MyClawAppLogsTail {
  type: "logs.tail";
  scope?: string;
  level?: "trace" | "debug" | "info" | "warn" | "error";
  run?: string;
  contains?: string;
  limit?: number;
}

export interface MyClawAppSessionRename {
  type: "session.rename";
  threadId: string;
  /** Blank hands the conversation back to its automatic title. */
  title: string;
}

export interface MyClawAppVoiceModeGet {
  type: "voice.mode.get";
}

export interface MyClawAppVoiceModeSet {
  type: "voice.mode.set";
  mode: "cloud" | "local" | "auto";
}

/** Accepted from the device. Plain-text frames are treated as chat.send (M1 console). */
export type MyClawAppClientFrame =
  | MyClawAppChatSend
  | MyClawAppSessionList
  | MyClawAppCommandsList
  | MyClawAppFilesList
  | MyClawAppFileDelete
  | MyClawAppSessionHistory
  | MyClawAppSessionArchive
  | MyClawAppSessionDelete
  | MyClawAppApprovalResponse
  | MyClawAppCapabilitiesFrame
  | MyClawAppDiagSnapshot
  | MyClawAppLogsTail
  | MyClawAppSessionRename
  | MyClawAppVoiceModeGet
  | MyClawAppVoiceModeSet
  | MyClawAppPing;

export interface MyClawAppToolCallEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  durationMs?: number;
  ok: boolean;
  output: string;
  truncated: boolean;
}

/** Tool card, sent between two text bubbles of the same turn. Suppressed when verbose is off. */
export interface MyClawAppToolCall extends MyClawAppToolCallEntry {
  type: "chat.tool";
  threadId: string;
  turnId: string;
  ts: string;
}

export type MyClawAppHistoryEntry =
  | {
      id: string;
      role: "user" | "assistant";
      text: string;
      ts: string;
      attachments?: MyClawAppHistoryAttachment[];
      /** What was heard in this turn's voice note, so the replayed bubble matches the live one. */
      transcript?: string;
    }
  | ({ role: "tool"; ts: string } & MyClawAppToolCallEntry);

export interface MyClawAppSessionSummary {
  threadId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface MyClawAppChatMessage {
  type: "chat.message";
  id: string;
  text: string;
  threadId: string;
  attachments: MyClawAppAttachmentMeta[];
  replyToId?: string;
  ts?: string;
  /** Correlation id of the run that produced this reply, quotable in a bug report. */
  run?: string;
}

export interface MyClawAppStreamStart {
  type: "chat.stream.start";
  id: string;
  threadId: string;
  replyToId?: string;
  ts?: string;
  run?: string;
}

export interface MyClawAppStreamDelta {
  type: "chat.stream.delta";
  id: string;
  threadId: string;
  text: string;
}

export interface MyClawAppStreamDone {
  type: "chat.stream.done";
  id: string;
  threadId: string;
}

export interface MyClawAppStreamAbort {
  type: "chat.stream.abort";
  id: string;
  threadId: string;
  error?: string;
}

export interface MyClawAppApprovalRequest {
  type: "approval.request";
  id: string;
  threadId: string;
  toolName: string;
  args: Record<string, unknown>;
  replyToId?: string;
  expiresAt: number;
}

export interface MyClawAppSessionListResult {
  type: "session.list.result";
  sessions: MyClawAppSessionSummary[];
}

export interface MyClawAppCommandsResult {
  type: "commands.list.result";
  commands: Array<{ name: string; description: string }>;
}

export interface MyClawAppSessionFile {
  id: string;
  filename: string;
  type: "image" | "audio" | "video" | "file";
  mimeType: string;
  sizeBytes: number;
  ts: string;
}

export interface MyClawAppDiagSnapshotResult {
  type: "diag.snapshot.result";
  text: string;
}

export interface MyClawAppLogsTailResult {
  type: "logs.tail.result";
  text: string;
  lines: number;
  /** Echoed back so the app can show what the tail was filtered on. */
  query: { scope?: string; level?: string; run?: string; contains?: string; limit?: number };
}

export interface MyClawAppFilesListResult {
  type: "files.list.result";
  threadId: string;
  files: MyClawAppSessionFile[];
  totalBytes: number;
}

export interface MyClawAppChatHistory {
  type: "chat.history";
  threadId: string;
  messages: MyClawAppHistoryEntry[];
}

/** Which request was refused, so the app can show it where the user is looking. */
export type MyClawAppErrorScope = "chat" | "files" | "session" | "diag" | "logs" | "voice";

export interface MyClawAppError {
  type: "error";
  message: string;
  scope: MyClawAppErrorScope;
}

/**
 * What the server heard in a voice note, addressed to the message that carried it. Sent instead
 * of the generic echo for this channel: the app renders it inside the recording's own bubble, and
 * a separate message would push the conversation apart to say something about a bubble above it.
 */
export interface MyClawAppChatTranscript {
  type: "chat.transcript";
  threadId: string;
  /** The chat.send id the device generated, so the bubble is found without guessing. */
  replyToId: string;
  text: string;
}

export interface MyClawAppVoiceModeResult {
  type: "voice.mode.result";
  /** What the owner asked for. */
  mode: "cloud" | "local" | "auto";
  /** What "auto" actually resolves to right now, so the app can stop guessing. */
  resolved: "cloud" | "local";
  /** False when no GROQ_API_KEY is set: "cloud" would fail, and the app must say so. */
  cloudAvailable: boolean;
}

export type MyClawAppServerFrame =
  | MyClawAppChatMessage
  | MyClawAppStreamStart
  | MyClawAppStreamDelta
  | MyClawAppStreamDone
  | MyClawAppStreamAbort
  | MyClawAppToolCall
  | MyClawAppApprovalRequest
  | MyClawAppSessionListResult
  | MyClawAppCommandsResult
  | MyClawAppFilesListResult
  | MyClawAppDiagSnapshotResult
  | MyClawAppLogsTailResult
  | MyClawAppChatHistory
  | MyClawAppVoiceModeResult
  | MyClawAppChatTranscript
  | MyClawAppError;
