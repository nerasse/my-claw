import type { ChannelAdapter, UnifiedMessage, OutgoingMessage } from "./types.ts";

export class MatrixAdapter implements ChannelAdapter {
  readonly platform = "matrix" as const;

  constructor(
    private homeserver: string,
    private accessToken: string,
    private userId: string,
  ) {}

  async start(): Promise<void> {
    // TODO: init matrix client
  }

  async stop(): Promise<void> {
    // TODO: stop client
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    // TODO: send message via matrix-js-sdk
  }

  onMessage(handler: (message: UnifiedMessage) => Promise<void>): void {
    // TODO: register message handler
  }
}
