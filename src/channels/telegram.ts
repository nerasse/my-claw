import type { ChannelAdapter, UnifiedMessage, OutgoingMessage } from "./types.ts";

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  constructor(private token: string) {}

  async start(): Promise<void> {
    // TODO: init grammy bot
  }

  async stop(): Promise<void> {
    // TODO: stop bot
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    // TODO: send message via grammy
  }

  onMessage(handler: (message: UnifiedMessage) => Promise<void>): void {
    // TODO: register message handler
  }
}
