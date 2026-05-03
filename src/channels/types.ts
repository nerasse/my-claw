export interface UnifiedMessage {
  id: string;
  platform: "telegram" | "matrix";
  userId: string;
  chatId: string;
  chatType: "dm" | "group";
  text: string;
  attachments: Attachment[];
  isForwarded: boolean;
  raw: unknown;
}

export interface Attachment {
  type: "image" | "audio" | "video" | "file";
  url?: string;
  path?: string;
  mimeType?: string;
}

export interface OutgoingMessage {
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  buttons?: ConfirmationButton[];
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
  onMessage(handler: (message: UnifiedMessage) => Promise<void>): void;
}
