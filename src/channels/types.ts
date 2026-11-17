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
  /**
   * Continue the conversation as it stands: the run adds no turn, it picks up where the last run
   * stopped (docs/continue.md). `text` then carries the last question, for what reads it (skill
   * suggestions, memory), and is never written.
   */
  resume?: boolean;
  /**
   * Set when the turn came from another agent rather than the owner: a background sub-agent's
   * return, or a report a sub-agent handed back. Stamped on the log entry, so a reopened thread
   * still knows this was not the owner speaking (docs/subagents.md).
   */
  from?: { sessionId: string; label: string; kind: "send" | "return"; status?: string };
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

export type ApprovalDecision = "allow-once" | "allow-session" | "allow-always" | "deny";

/**
 * Where the tool that asks would run. Absent means this server's own machine; a remote node's
 * tools carry their node, so a grant given for one machine never auto-runs on another.
 */
export type ApprovalOrigin = { kind: "node"; nodeId: string };

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
  origin?: ApprovalOrigin;
  /**
   * The agent asked by itself (`approval` tool) instead of a gate opening on a call: the prompt
   * waits with no timer, because the run is deliberately waiting on the owner -- a timeout there
   * would answer "no" on his behalf.
   */
  waitForever?: boolean;
  /** The sentence the agent wrote about what it is about to do; the sheet shows it above the args. */
  headline?: string;
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
  /**
   * A scheduled job's delivery rather than a message: the frame names the job, its cadence and the
   * run it came from, and the app draws the delivery card it draws on reload. Set by the cron
   * scheduler, read by the app channel only.
   */
  cron?: { job: string; cadence: string; status?: "ok" | "error"; runId?: string };
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
