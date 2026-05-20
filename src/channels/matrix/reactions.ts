import { EventType, type MatrixClient } from "matrix-js-sdk";
import { MATRIX_REACTION_BUTTON_EMOJIS } from "./actions.ts";
import { toSdkContent } from "./send.ts";
import { LruMap } from "../../utils/lru-map.ts";

export type MatrixReactionState = "received" | "thinking" | "tool_use" | "done" | "error";

export interface MatrixReactionConfig {
  enabled: boolean;
  emojis: Record<MatrixReactionState, string>;
}

const DEFAULT_EMOJIS: Record<MatrixReactionState, string> = {
  received: "👀",
  thinking: "🤔",
  tool_use: "🔥",
  done: "👍",
  error: "😨",
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

const MAX_REACTION_ENTRIES = 2000;

export class MatrixReactionManager {
  private ownReactionIds = new LruMap<string, string>(MAX_REACTION_ENTRIES);

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
        toSdkContent(buildReactionContent(eventId, emoji)),
      );
      this.ownReactionIds.set(key, result.event_id);
    } catch {
      // cosmetic only
    }
  }

  async seedChoices(roomId: string, eventId: string, count: number): Promise<void> {
    if (!this.config.enabled) return;

    for (const emoji of MATRIX_REACTION_BUTTON_EMOJIS.slice(0, Math.max(0, count))) {
      try {
        await this.client.sendEvent(
          roomId,
          EventType.Reaction,
          toSdkContent(buildReactionContent(eventId, emoji)),
        );
      } catch {
        return;
      }
    }
  }
}
