import type { Bot } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types/message";

export type ReactionState = "received" | "thinking" | "tool_use" | "done" | "error";
type TelegramReactionEmoji = ReactionTypeEmoji["emoji"];

export interface ReactionConfig {
  enabled: boolean;
  emojis?: Partial<Record<ReactionState, string>>;
}

const SUPPORTED_REACTION_EMOJIS: TelegramReactionEmoji[] = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
];

const SUPPORTED_REACTION_EMOJI_SET = new Set<TelegramReactionEmoji>(SUPPORTED_REACTION_EMOJIS);

const DEFAULT_EMOJIS: Record<ReactionState, TelegramReactionEmoji> = {
  received: "\u{1F440}",
  thinking: "\u{1F914}",
  tool_use: "\u{1F525}",
  done: "\u{1F44D}",
  error: "\u{1F628}",
};

function toSupportedReactionEmoji(
  value: string | undefined,
  fallback: TelegramReactionEmoji,
): TelegramReactionEmoji {
  if (value && SUPPORTED_REACTION_EMOJI_SET.has(value as TelegramReactionEmoji)) {
    return value as TelegramReactionEmoji;
  }
  return fallback;
}

export class ReactionManager {
  constructor(
    private bot: Bot,
    private config: ReactionConfig,
  ) {}

  /** Replace the reaction config at runtime (used by the config hot-reload watcher). */
  setConfig(config: ReactionConfig): void {
    this.config = config;
  }

  async set(chatId: string, messageId: number, state: ReactionState): Promise<void> {
    if (!this.config.enabled) return;

    const emoji = toSupportedReactionEmoji(this.config.emojis?.[state], DEFAULT_EMOJIS[state]);
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      return;
    }
  }

  async clear(chatId: string, messageId: number): Promise<void> {
    if (!this.config.enabled) return;

    try {
      await this.bot.api.setMessageReaction(chatId, messageId, []);
    } catch {
      return;
    }
  }
}
