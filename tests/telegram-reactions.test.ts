import { test } from "bun:test";
import assert from "node:assert/strict";
import { ReactionManager } from "../src/channels/telegram/reactions.ts";

function createBotMock(shouldThrow = false) {
  const calls: Array<{ chatId: string; messageId: number; reaction: unknown[] }> = [];
  return {
    calls,
    bot: {
      api: {
        async setMessageReaction(chatId: string, messageId: number, reaction: unknown[]) {
          if (shouldThrow) throw new Error("blocked");
          calls.push({ chatId, messageId, reaction });
          return true;
        },
      },
    },
  };
}

test("ReactionManager sends defaults and clears reactions", async () => {
  const { bot, calls } = createBotMock();
  const manager = new ReactionManager(bot as never, { enabled: true });

  await manager.set("1", 2, "thinking");
  await manager.clear("1", 2);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.reaction, [{ type: "emoji", emoji: "🤔" }]);
  assert.deepEqual(calls[1]?.reaction, []);
});

test("ReactionManager falls back from unsupported custom emoji", async () => {
  const { bot, calls } = createBotMock();
  const manager = new ReactionManager(bot as never, {
    enabled: true,
    emojis: { done: "✅" },
  });

  await manager.set("1", 2, "done");
  assert.deepEqual(calls[0]?.reaction, [{ type: "emoji", emoji: "👍" }]);
});

test("ReactionManager ignores failures and disabled mode", async () => {
  const disabled = createBotMock();
  const disabledManager = new ReactionManager(disabled.bot as never, { enabled: false });
  await disabledManager.set("1", 2, "received");
  assert.equal(disabled.calls.length, 0);

  const throwing = createBotMock(true);
  const throwingManager = new ReactionManager(throwing.bot as never, { enabled: true });
  await assert.doesNotReject(() => throwingManager.set("1", 2, "received"));
});
