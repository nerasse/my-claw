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

/** The device id is the chatId/userId for the whole session. */
export interface MobileChatSend {
  type: "chat.send";
  id: string;
  text: string;
  ts?: string;
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
export type MobileClientFrame = MobileChatSend | MobileApprovalResponse | MobileCapabilitiesFrame | MobilePing;

export interface MobileChatMessage {
  type: "chat.message";
  id: string;
  text: string;
  attachments: MobileAttachmentMeta[];
  replyToId?: string;
  ts?: string;
}

export interface MobileStreamStart {
  type: "chat.stream.start";
  id: string;
  replyToId?: string;
  ts?: string;
}

export interface MobileStreamDelta {
  type: "chat.stream.delta";
  id: string;
  text: string;
}

export interface MobileStreamDone {
  type: "chat.stream.done";
  id: string;
}

export interface MobileStreamAbort {
  type: "chat.stream.abort";
  id: string;
  error?: string;
}

export interface MobileApprovalRequest {
  type: "approval.request";
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  replyToId?: string;
  expiresAt: number;
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
  | MobileApprovalRequest
  | MobileError;
