import { EventType, type MatrixClient } from "matrix-js-sdk";

export type MatrixReactionState = "received" | "thinking" | "tool_use" | "done" | "error";

export interface MatrixReactionConfig {
  enabled: boolean;
  emojis: Record<MatrixReactionState, string>;
}

const DEFAULT_EMOJIS: Record<MatrixReactionState, string> = {
  received: "👀",
  thinking: "🧠",
  tool_use: "⚙️",
  done: "✅",
  error: "⚠️",
};

function buildReactionContent(eventId: string, emoji: string): Record<string, unknown> {
  return {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: eventId,
      key: emoji,
    },
  };
}

export class MatrixReactionManager {
  private ownReactionIds = new Map<string, string>();

  constructor(
    private client: MatrixClient,
    private config: MatrixReactionConfig,
  ) {}

  async set(roomId: string, eventId: string, state: MatrixReactionState): Promise<void> {
    if (!this.config.enabled) return;
    const emoji = this.config.emojis[state] ?? DEFAULT_EMOJIS[state];
    const key = `${roomId}:${eventId}`;

    try {
      const previous = this.ownReactionIds.get(key);
      if (previous) {
        await this.client.redactEvent(roomId, previous).catch(() => {});
      }

      const result = await this.client.sendEvent(
        roomId,
        EventType.Reaction,
        buildReactionContent(eventId, emoji) as never,
      );
      this.ownReactionIds.set(key, result.event_id);
    } catch {
      // cosmetic only
    }
  }
}
