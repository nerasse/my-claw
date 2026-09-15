export interface UnifiedMessage {
  id: string;
  platform: "cron" | "my-claw-app";
  userId: string;
  chatId: string;
  chatType: "dm" | "group";
  text: string;
  /** Original channel timestamp when the adapter exposes one. */
  timestamp?: string;
  attachments: Attachment[];
  /** One-shot device location shared with this message. */
  location?: ChatLocation;
  isForwarded: boolean;
  replyToId?: string;
  replyToText?: string;
  replyToSender?: string;
  threadId?: string;
  threadRootText?: string;
  roomContext?: string;
  mentionsBot?: boolean;
  sessionScope?: "per-user" | "per-room" | "per-chat";
  raw: unknown;
}

export type LocationAddressLevel = "building" | "street" | "locality" | "city" | "country";

export interface ChatLocationAddress {
  formatted: string;
  level: LocationAddressLevel;
  provider: "geoapify";
  street?: string;
  houseNumber?: string;
  city?: string;
  postcode?: string;
  country?: string;
  confidence?: number;
  /** Rewritten by the owner before sending: display text, never a provider claim. */
  edited?: boolean;
}

export interface ChatLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  altitudeMeters?: number;
  headingDegrees?: number;
  speedMetersPerSecond?: number;
  address?: ChatLocationAddress;
}

export type ChatLocationInput = Omit<ChatLocation, "address"> & {
  /**
   * Owner decision about the display address, carried only on chat.send: an empty string means
   * "coordinates only", a non-empty string is shown as-is and flagged edited. Absent means the
   * server derives the address from the provider.
   */
  addressOverride?: { formatted: string };
};

export type ApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface ToolApprovalRequest {
  id: string;
  platform: UnifiedMessage["platform"];
  chatId: string;
  userId: string;
  chatType: UnifiedMessage["chatType"];
  messageId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  replyToId?: string;
  threadId?: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ApprovalDecision>;

export interface Attachment {
  type: "image" | "audio" | "video" | "file";
  url?: string;
  path?: string;
  /**
   * The store id of the copy, when the run already stored the bytes. A channel that finds one
   * fetches instead of copying again, and the run's log records it so a reopened thread names the
   * same copy the live frame did (2026-09-15).
   */
  id?: string;
  mimeType?: string;
  summaryText?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  audioAsVoice?: boolean;
}

export interface OutgoingMessage {
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  threadId?: string;
  notice?: boolean;
  buttons?: ConfirmationButton[];
  stateKey?: string;
}

export interface ConfirmationButton {
  label: string;
  action: string;
}

export interface ChannelAdapter {
  readonly platform: UnifiedMessage["platform"];
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutgoingMessage): Promise<void>;
  confirm?(chatId: string, text: string, replyToId?: string, threadId?: string): Promise<boolean>;
  onMessage(handler: (message: UnifiedMessage) => Promise<void>): void;
}
