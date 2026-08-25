import { test, describe, expect } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SessionManager } from "../../src/sessions/manager.ts";
import { deleteSession, loadSession, loadLegacySession, recordSessionCommand, markSessionDirty } from "../../src/sessions/store.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { openSessionLog, type UserEntry, type ToolEntry } from "../../src/sessions/log.ts";
import { readMeta, writeMeta, metaPath, STORAGE_VERSION } from "../../src/sessions/meta.ts";
import { spillToolOutput, readToolOutput } from "../../src/sessions/tool-output.ts";

function createMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
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

test("resolveSessionId: my-claw-app DM -> my-claw-app/dm/{userId}", () => {
  const id = SessionManager.resolveSessionId("my-claw-app", "dm", "c100", "u200");
  assert.equal(id, "my-claw-app/dm/u200");
});

test("resolveSessionId: my-claw-app thread -> my-claw-app/thread/{chatId}/{threadId}", () => {
  const id = SessionManager.resolveSessionId("my-claw-app", "dm", "c100", "u200", {
    threadId: "t999",
  });
  assert.equal(id, "my-claw-app/thread/c100/t999");
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
    assert.equal(session.platform, "my-claw-app");
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
    // A settings field, not `messages`: the conversation lives in the entry log, and nothing in
    // src/ has appended to `session.messages` since the storage switch.
    session.title = "persisted";
    session.modelOverride = "anthropic/claude-opus-5";
    await mgr1.persist(sid);

    const mgr2 = new SessionManager();
    const loaded = await mgr2.getOrCreateWithMeta(sid, "matrix", "group");
    assert.equal(loaded.title, "persisted");
    assert.equal(loaded.modelOverride, "anthropic/claude-opus-5");
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
    original.title = "before restart";
    await mgr1.persist(sid);

    // Simulate a process restart: brand-new manager, empty in-memory cache.
    const mgr2 = new SessionManager();
    const reloaded = await mgr2.getOrCreateWithMeta(sid, "matrix", "group");

    assert.equal(reloaded.createdAt, createdAt, "createdAt must survive a restart (no history reset)");
    assert.equal(reloaded.title, "before restart");
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
    session.title = "premiere question";
    await mgr.persist(sid);
    session.title = "en cours";

    const live = await mgr.read(sid);
    assert.equal(live?.title, "en cours");

    const onDisk = await new SessionManager().read(sid);
    assert.equal(onDisk?.title, "premiere question", "the file is one turn behind, which is the point");
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
    // Marked the way src/ marks it: `messages` is no longer what makes a session dirty.
    a.title = "question";
    markSessionDirty(a);
    await mgr.getOrCreateWithMeta(still, "my-claw-app", "dm");

    await mgr.flushDirty();

    const reader = new SessionManager();
    assert.equal((await reader.read(moved))?.title, "question");
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
    session.title = "nommee pendant le run";
    markSessionDirty(session);

    await mgr.flushAll();

    const reloaded = await new SessionManager().read(sid);
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

// The autosave told a dirty session from a clean one by its message count, which is blind to every
// mutation that does not append. Those survived a clean shutdown (flushAll writes regardless) and
// were lost to a kill -- a sub-agent card settling to "complete" right before one, for instance.
test("flushDirty writes a session mutated in place without a new message", async () => {
  const manager = new SessionManager();
  const sessionId = "my-claw-app/thread/owner/dirty-inplace";
  try {
    const session = await manager.getOrCreate(sessionId, createMessage({ threadId: "dirty-inplace" }));
    session.title = "go";
    await manager.persist(sessionId);

    // No append and no new message: nothing but an in-place mutation makes this session dirty.
    recordSessionCommand(session, { input: "/status", output: "all good", timestamp: new Date().toISOString() });
    await manager.flushDirty();

    // Read from disk, not from the cache the mutation happened in. The journal is the legacy copy
    // -- the app reads slash commands back from the entry log -- so the legacy file is where it
    // lands, and reaching it at all is what proves the flush happened.
    const onDisk = await loadLegacySession(sessionId);
    assert.equal(onDisk?.commands?.length, 1);
    assert.equal(onDisk?.commands?.[0]?.input, "/status");
  } finally {
    await deleteSession(sessionId);
  }
});

test("flushDirty skips a session nothing touched", async () => {
  const manager = new SessionManager();
  const sessionId = "my-claw-app/thread/owner/clean-session";
  try {
    const session = await manager.getOrCreate(sessionId, createMessage({ threadId: "clean-session" }));
    session.messages.push({ role: "user", content: "go", timestamp: new Date().toISOString() });
    await manager.persist(sessionId);

    let writes = 0;
    const spy = (ev: { sessionId: string }) => {
      if (ev.sessionId === sessionId) writes++;
    };
    hooks.on("session:persisted", spy);
    try {
      await manager.flushDirty();
      assert.equal(writes, 0, "a clean session is not rewritten on every tick");
    } finally {
      hooks.off("session:persisted", spy);
    }
  } finally {
    await deleteSession(sessionId);
  }
});

describe("SessionManager: the log half", () => {
  test("a session opens its log once and keeps the same handle", async () => {
    const manager = new SessionManager();
    const id = "log-manager/one";
    await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    const first = await manager.logOf(id);
    expect(await manager.logOf(id)).toBe(first);
  });

  test("two callers asking at once share one open", async () => {
    // Two reads of the same file would each build a log, and the loser's appends would land in a
    // handle nobody holds.
    const manager = new SessionManager();
    const id = "log-manager/race";
    const [a, b] = await Promise.all([manager.logOf(id), manager.logOf(id)]);
    expect(a).toBe(b!);
  });

  test("the cursor comes from meta, not from the end of the file", async () => {
    // Those differ exactly when the conversation sits on a branch that is not the newest thing
    // written, which is the entire point of storing a cursor.
    const id = "log-manager/cursor";
    const writer = await openSessionLog(id);
    const first = writer.append<UserEntry>({ type: "user", prompt: true, text: "un" });
    writer.append<UserEntry>({ type: "user", prompt: true, text: "deux" });
    await writer.flush();
    await writeMeta(id, { id, platform: "my-claw-app", chatType: "dm", createdAt: "", lastActiveAt: "", storageVersion: STORAGE_VERSION, leafId: first.id });

    const manager = new SessionManager();
    const opened = await manager.logOf(id);
    expect(opened.leaf()).toBe(first.id);
    expect(opened.head()).not.toBe(first.id);
  });

  test("persist writes the settings beside the entries, without the history", async () => {
    const manager = new SessionManager();
    const id = "log-manager/persist";
    const session = await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    session.title = "mon fil";
    const entries = await manager.logOf(id);
    const entry = entries.append<UserEntry>({ type: "user", prompt: true, text: "bonjour" });
    await entries.flush();
    await manager.persist(id);

    const meta = await readMeta(id);
    expect(meta).toMatchObject({ title: "mon fil", leafId: entry.id });
    const raw = JSON.parse(await readFile(metaPath(id), "utf-8")) as Record<string, unknown>;
    expect(raw["messages"]).toBeUndefined();
  });

  test("a session with no log yet still gets its settings written", async () => {
    // Gated on an open log, this write was skipped exactly when no run had opened one: renaming a
    // thread in a fresh process reached the flat file and not the directory, and the directory is
    // what gets read back. The cursor is null because there is no log to name a leaf in, which is
    // also what "start from the end" means.
    const manager = new SessionManager();
    const id = "log-manager/nolog";
    const session = await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    session.title = "renommee sans run";
    await manager.persist(id);

    expect(await readMeta(id)).toMatchObject({ title: "renommee sans run", leafId: null });
  });

  test("flushAll drains what the appends left in flight", async () => {
    // The appends are fire-and-forget so a write never sits on the path of a token; an exit is
    // the one moment that has to be undone.
    const manager = new SessionManager();
    const id = "log-manager/flush";
    await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    const entries = await manager.logOf(id);
    entries.append<UserEntry>({ type: "user", prompt: true, text: "en vol" });
    await manager.flushAll();
    expect((await openSessionLog(id)).entries()).toHaveLength(1);
  });

  test("deleting a session takes its entries and its spilled outputs with it", async () => {
    const manager = new SessionManager();
    const id = "log-manager/deleted";
    await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    const entries = await manager.logOf(id);
    entries.append<UserEntry>({ type: "user", prompt: true, text: "adieu" });
    await entries.flush();
    await spillToolOutput(id, "c1", "x".repeat(20), 5);

    await manager.deleteSession(id);
    expect(await readToolOutput(id, "c1")).toBeNull();
    expect((await openSessionLog(id)).entries()).toEqual([]);
  });

  test("dropping a session releases its log without touching the file", async () => {
    // `drop` exists for a file someone else deleted; it must not become a second delete.
    const manager = new SessionManager();
    const id = "log-manager/dropped";
    const entries = await manager.logOf(id);
    entries.append<UserEntry>({ type: "user", prompt: true, text: "reste" });
    await entries.flush();
    manager.drop(id);
    expect(manager.peekLog(id)).toBeUndefined();
    expect((await openSessionLog(id)).entries()).toHaveLength(1);
  });

  test("the sweep keeps what an entry names", async () => {
    const manager = new SessionManager();
    const id = "log-manager/sweep";
    const entries = await manager.logOf(id);
    entries.append<ToolEntry>({
      type: "tool", prompt: true, callId: "kept", name: "bash", args: {},
      output: "", truncated: true, ok: true, runId: "r1",
    });
    await entries.flush();
    await spillToolOutput(id, "kept", "a".repeat(20), 5);
    await spillToolOutput(id, "orphan", "b".repeat(20), 5);

    expect(await manager.sweepToolOutput(id)).toBe(1);
    expect(await readToolOutput(id, "kept")).not.toBeNull();
    expect(await readToolOutput(id, "orphan")).toBeNull();
  });
});
