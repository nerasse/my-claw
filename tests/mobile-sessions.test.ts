import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions/manager.ts";
import { saveSession, deleteSession, type SessionData } from "../src/sessions/store.ts";
import { MobileSessionStoreImpl } from "../src/channels/mobile/sessions.ts";

const DEVICE = "dev-test";
const THREAD = "thread-1";

function session(id: string, messages: SessionData["messages"]): SessionData {
  return {
    id,
    platform: "mobile",
    chatType: "dm",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:01:00.000Z",
    messages,
  };
}

describe("MobileSessionStoreImpl.history", () => {
  let store: MobileSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    store = new MobileSessionStoreImpl(new SessionManager());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  test("replays tool calls as structured cards with output and duration", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "check le site", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "je regarde",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-1", name: "fetch", arguments: '{"url":"https://x.dev"}', durationMs: 412 }],
      },
      { role: "tool", toolCallId: "call-1", content: "HTTP 200 OK", timestamp: "2026-01-01T00:00:03.000Z" },
      { role: "assistant", content: "le site repond", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "tool", "assistant"]);

    const card = entries[2]!;
    assert.equal(card.role, "tool");
    if (card.role !== "tool") throw new Error("expected a tool entry");
    assert.equal(card.name, "fetch");
    assert.deepEqual(card.args, { url: "https://x.dev" });
    assert.equal(card.durationMs, 412);
    assert.equal(card.output, "HTTP 200 OK");
    assert.equal(card.truncated, false);
  });

  test("keeps the card when the timing predates duration persistence and truncates long output", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-2", name: "bash", arguments: "not json" }],
      },
      { role: "tool", toolCallId: "call-2", content: "z".repeat(5000), timestamp: "2026-01-01T00:00:03.000Z" },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 1);
    const card = entries[0]!;
    if (card.role !== "tool") throw new Error("expected a tool entry");
    assert.equal(card.durationMs, undefined);
    assert.deepEqual(card.args, { raw: "not json" });
    assert.equal(card.output.length, 4000);
    assert.equal(card.truncated, true);
  });
});
