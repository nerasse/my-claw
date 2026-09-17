import { test } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/sessions/manager.ts";
import { recordApiCall } from "../../src/analytics/usage-db.ts";
import { statsReport } from "../../src/channels/stats-command.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

/**
 * The page promises the owner that the money a conversation spent outlives the conversation:
 * "the analytics outlive the sessions by design, so 'gone' is a normal answer and not an error"
 * (stats-command.ts), and a deleted session is drawn with a badge instead of disappearing from
 * the ranking ("dropping it would make the ranking add up to less than the total printed above
 * it"). Deleting drops the log, the meta and the archives -- a different set of files from the
 * analytics database -- so nothing in that path may reach into it. Reported broken by the owner
 * on 2026-09-17; this is the lock on the promise.
 */

const config: MyClawConfig = {
  whitelist: [],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
};

function message(threadId: string): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "owner",
    chatId: "owner",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
    threadId,
  };
}

test("a deleted conversation keeps every call the report counted", async () => {
  const manager = new SessionManager();
  const threadId = `gone-${Date.now()}`;
  const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "owner", "owner", { threadId });
  await manager.getOrCreate(sessionId, message(threadId));
  for (const n of [1, 2, 3]) {
    recordApiCall({
      sessionId,
      platform: "my-claw-app",
      model: "test-model",
      baseUrl: "https://example.com",
      streaming: false,
      caller: "orchestrator",
      promptTokens: 100 * n,
      completionTokens: 10 * n,
      totalTokens: 110 * n,
      toolCalls: 0,
      iteration: n,
      durationMs: 5,
    });
  }

  const infoOf = async (id: string) => ((await manager.read(id)) ? {} : undefined);
  const before = await statsReport({ config, period: "30d", sessionInfo: infoOf });
  const rowBefore = before.sessions.find((row) => row.sessionId === sessionId);
  assert.equal(rowBefore?.calls, 3, "the conversation is in the ranking before the delete");
  assert.equal(rowBefore?.deleted, false);

  await manager.deleteSession(sessionId);

  const after = await statsReport({ config, period: "30d", sessionInfo: infoOf });
  const rowAfter = after.sessions.find((row) => row.sessionId === sessionId);
  assert.equal(after.totals.calls, before.totals.calls, "the totals keep the deleted conversation's calls");
  assert.equal(rowAfter?.calls, 3, "the ranking keeps its row");
  assert.equal(rowAfter?.deleted, true, "and says the conversation is gone");
});
