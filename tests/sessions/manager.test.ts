import { test } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/sessions/manager.ts";
import { deleteSession } from "../../src/sessions/store.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

function createMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
    ...overrides,
  };
}

// --- resolveSessionId ---

test("resolveSessionId: a cron run thread resolves to the run's own session", () => {
  const id = SessionManager.resolveSessionId("my-claw-app", "dm", "owner1", "owner1", {
    threadId: "cron-abcdef123456-1700000000000",
  });
  assert.equal(id, "cron/abcdef123456/1700000000000");
});

test("resolveSessionId: a normal app thread stays under the owner", () => {
  const id = SessionManager.resolveSessionId("my-claw-app", "dm", "owner1", "owner1", {
    threadId: "projet",
  });
  assert.equal(id, "my-claw-app/thread/owner1/projet");
});

test("resolveSessionId: telegram DM -> telegram/dm/{userId}", () => {
  const id = SessionManager.resolveSessionId("telegram", "dm", "c100", "u200");
  assert.equal(id, "telegram/dm/u200");
});

test("resolveSessionId: telegram DM with per-chat scope -> telegram/dm-chat/{chatId}", () => {
  const id = SessionManager.resolveSessionId("telegram", "dm", "c100", "u200", {
    sessionScope: "per-chat",
  });
  assert.equal(id, "telegram/dm-chat/c100");
});

test("resolveSessionId: telegram group -> telegram/group/{chatId}", () => {
  const id = SessionManager.resolveSessionId("telegram", "group", "g500", "u200");
  assert.equal(id, "telegram/group/g500");
});

test("resolveSessionId: telegram thread -> telegram/thread/{chatId}/{threadId}", () => {
  const id = SessionManager.resolveSessionId("telegram", "dm", "c100", "u200", {
    threadId: "t999",
  });
  assert.equal(id, "telegram/thread/c100/t999");
});

test("resolveSessionId: matrix DM -> matrix/dm/{userId}", () => {
  const id = SessionManager.resolveSessionId("matrix", "dm", "c1", "u300");
  assert.equal(id, "matrix/dm/u300");
});

test("resolveSessionId: matrix DM with per-room scope -> matrix/dm-room/{roomId}", () => {
  const id = SessionManager.resolveSessionId("matrix", "dm", "c1", "u300", {
    roomId: "!room:example.org",
    sessionScope: "per-room",
  });
  assert.equal(id, "matrix/dm-room/!room:example.org");
});

test("resolveSessionId: matrix group -> matrix/room/{roomId}", () => {
  const id = SessionManager.resolveSessionId("matrix", "group", "c1", "u300", {
    roomId: "!grp:example.org",
  });
  assert.equal(id, "matrix/room/!grp:example.org");
});

test("resolveSessionId: matrix thread -> matrix/thread/{roomId}/{threadId}", () => {
  const id = SessionManager.resolveSessionId("matrix", "dm", "c1", "u300", {
    roomId: "!r:example.org",
    threadId: "evt123",
  });
  assert.equal(id, "matrix/thread/!r:example.org/evt123");
});

test("resolveSessionId: unknown platform DM -> {platform}/dm/{userId}", () => {
  const id = SessionManager.resolveSessionId("discord", "dm", "c1", "u400");
  assert.equal(id, "discord/dm/u400");
});

test("resolveSessionId: unknown platform group -> {platform}/group/{chatId}", () => {
  const id = SessionManager.resolveSessionId("discord", "group", "g999", "u400");
  assert.equal(id, "discord/group/g999");
});

// --- getOrCreate / getOrCreateWithMeta (async, disk) ---

test("getOrCreate: creates new session if none exists", async () => {
  const sid = `test/manager/${Date.now()}/new`;
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate(sid, createMessage());
    assert.equal(session.id, sid);
    assert.equal(session.platform, "telegram");
    assert.equal(session.chatType, "dm");
    assert.equal(session.messages.length, 0);
  } finally {
    await deleteSession(sid);
  }
});

test("getOrCreate: returns same session object on second call", async () => {
  const sid = `test/manager/${Date.now()}/cache`;
  const manager = new SessionManager();
  try {
    const first = await manager.getOrCreate(sid, createMessage());
    const second = await manager.getOrCreate(sid, createMessage());
    assert.equal(first, second);
  } finally {
    await deleteSession(sid);
  }
});

test("clearHistory: empties messages array", async () => {
  const sid = `test/manager/${Date.now()}/clear`;
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreateWithMeta(sid, "telegram", "dm");
    session.messages.push({ role: "user", content: "hi", timestamp: new Date().toISOString() });
    assert.equal(session.messages.length, 1);

    manager.clearHistory(sid);
    assert.equal(session.messages.length, 0);
  } finally {
    await deleteSession(sid);
  }
});

test("getInfo: returns message count and timestamps", async () => {
  const sid = `test/manager/${Date.now()}/info`;
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreateWithMeta(sid, "telegram", "dm");
    session.messages.push(
      { role: "user", content: "a", timestamp: new Date().toISOString() },
      { role: "assistant", content: "b", timestamp: new Date().toISOString() },
    );

    const info = manager.getInfo(sid);
    assert.ok(info);
    assert.equal(info.messageCount, 2);
    assert.equal(typeof info.createdAt, "string");
    assert.equal(typeof info.lastActiveAt, "string");
  } finally {
    await deleteSession(sid);
  }
});

test("getInfo: returns null for unknown session", () => {
  const manager = new SessionManager();
  assert.equal(manager.getInfo("nonexistent/session/xyz"), null);
});

test("persist: saves to disk and new manager loads it back", async () => {
  const sid = `test/manager/${Date.now()}/persist`;
  try {
    const mgr1 = new SessionManager();
    const session = await mgr1.getOrCreateWithMeta(sid, "matrix", "group");
    session.messages.push({ role: "user", content: "persisted", timestamp: new Date().toISOString() });
    await mgr1.persist(sid);

    const mgr2 = new SessionManager();
    const loaded = await mgr2.getOrCreateWithMeta(sid, "matrix", "group");
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]!.content, "persisted");
  } finally {
    await deleteSession(sid);
  }
});

test("resetSession clears history while preserving the selected model", async () => {
  const sid = `test/manager/${Date.now()}/reset-model`;
  try {
    const firstManager = new SessionManager();
    const session = await firstManager.getOrCreateWithMeta(sid, "telegram", "dm");
    session.messages.push({ role: "user", content: "before reset", timestamp: new Date().toISOString() });
    session.modelOverride = "alt-model";
    session.sdkSessionId = "sdk-history";
    await firstManager.persist(sid);

    const resetManager = new SessionManager();
    await resetManager.resetSession(sid, "telegram", "dm");

    const reset = await resetManager.peek(sid);
    assert.ok(reset);
    assert.equal(reset.messages.length, 0);
    assert.equal(reset.modelOverride, "alt-model");
    assert.equal(reset.sdkSessionId, undefined);

    const reloadedManager = new SessionManager();
    const reloaded = await reloadedManager.peek(sid);
    assert.equal(reloaded?.modelOverride, "alt-model");
  } finally {
    await deleteSession(sid);
  }
});

// Guards the prod symptom: after a restart, a persisted session must reload with
// its ORIGINAL createdAt and history, never a fresh session that overwrites it.
test("restart simulation: a fresh manager reloads the session without resetting createdAt", async () => {
  const sid = `test/manager/${Date.now()}/restart`;
  try {
    const mgr1 = new SessionManager();
    const original = await mgr1.getOrCreateWithMeta(sid, "matrix", "group");
    const createdAt = original.createdAt;
    original.messages.push({ role: "user", content: "before restart", timestamp: new Date().toISOString() });
    await mgr1.persist(sid);

    // Simulate a process restart: brand-new manager, empty in-memory cache.
    const mgr2 = new SessionManager();
    const reloaded = await mgr2.getOrCreateWithMeta(sid, "matrix", "group");

    assert.equal(reloaded.createdAt, createdAt, "createdAt must survive a restart (no history reset)");
    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.messages[0]!.content, "before restart");
  } finally {
    await deleteSession(sid);
  }
});

// --- durability: what a run holds in memory ---

// A run only writes when it ends, so anything reading the file mid-turn (the app's history)
// saw a conversation as it stood before the question was even asked.
test("read: a turn in flight comes back from memory, not from the stale file", async () => {
  const sid = `test/manager/${Date.now()}/read-live`;
  try {
    const mgr = new SessionManager();
    const session = await mgr.getOrCreateWithMeta(sid, "my-claw-app", "dm");
    session.messages.push({ role: "user", content: "premiere question", timestamp: new Date().toISOString() });
    await mgr.persist(sid);
    session.messages.push({ role: "user", content: "en cours", timestamp: new Date().toISOString() });

    const live = await mgr.read(sid);
    assert.equal(live?.messages.length, 2);
    assert.equal(live?.messages[1]!.content, "en cours");

    const onDisk = await new SessionManager().read(sid);
    assert.equal(onDisk?.messages.length, 1, "the file is one turn behind, which is the point");
  } finally {
    await deleteSession(sid);
  }
});

test("read: an unknown session is null and is not cached", async () => {
  const mgr = new SessionManager();
  assert.equal(await mgr.read(`test/manager/${Date.now()}/absent`), null);
  assert.equal(mgr.getInfo(`test/manager/${Date.now()}/absent`), null);
});

test("flushDirty: writes what a run appended, and only that", async () => {
  const moved = `test/manager/${Date.now()}/dirty`;
  const still = `test/manager/${Date.now()}/clean`;
  try {
    const mgr = new SessionManager();
    const a = await mgr.getOrCreateWithMeta(moved, "my-claw-app", "dm");
    a.messages.push({ role: "user", content: "question", timestamp: new Date().toISOString() });
    await mgr.getOrCreateWithMeta(still, "my-claw-app", "dm");

    await mgr.flushDirty();

    const reader = new SessionManager();
    assert.equal((await reader.read(moved))?.messages.length, 1);
    // An empty conversation nobody wrote in must not leave a file behind.
    assert.equal(await reader.read(still), null);
  } finally {
    await deleteSession(moved);
    await deleteSession(still);
  }
});

// The prod symptom: seven adapter restarts in a day, and every message a cached session had
// not written yet was gone for good.
test("flushAll: a restart keeps what was only in memory", async () => {
  const sid = `test/manager/${Date.now()}/flush-all`;
  try {
    const mgr = new SessionManager();
    const session = await mgr.getOrCreateWithMeta(sid, "my-claw-app", "dm");
    session.messages.push({ role: "user", content: "jamais persiste", timestamp: new Date().toISOString() });
    session.title = "nommee pendant le run";

    await mgr.flushAll();

    const reloaded = await new SessionManager().read(sid);
    assert.equal(reloaded?.messages.length, 1);
    assert.equal(reloaded?.title, "nommee pendant le run");
  } finally {
    await deleteSession(sid);
  }
});

test("startAutosave: idempotent, and stoppable without having run", () => {
  const mgr = new SessionManager();
  mgr.startAutosave(50_000);
  mgr.startAutosave(50_000);
  mgr.stopAutosave();
  mgr.stopAutosave();
});
