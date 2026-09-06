import { test } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/sessions/manager.ts";
import { readMeta } from "../../src/sessions/meta.ts";

test("SessionManager: evicts oldest sessions when cache is full", async () => {
  const manager = new SessionManager();

  // Create more sessions than the LRU max (100)
  for (let i = 0; i < 105; i++) {
    await manager.getOrCreateWithMeta(`test/session/${i}`, "telegram", "dm");
  }

  // First 5 should have been evicted from memory (persisted to disk via onEvict)
  // getInfo returns null for evicted sessions (only checks in-memory cache)
  const info0 = manager.getInfo("test/session/0");
  assert.equal(info0, null, "session 0 should be evicted from memory");

  // Recent sessions should still be in cache
  const info104 = manager.getInfo("test/session/104");
  assert.ok(info104, "session 104 should be in memory");
});

test("SessionManager: accessing a session keeps it in cache (LRU touch)", async () => {
  const manager = new SessionManager();

  // Fill cache
  for (let i = 0; i < 100; i++) {
    await manager.getOrCreateWithMeta(`test/session/${i}`, "telegram", "dm");
  }

  // Touch session 0 so it becomes most-recently-used
  await manager.getOrCreateWithMeta("test/session/0", "telegram", "dm");

  // Add one more to trigger eviction
  await manager.getOrCreateWithMeta("test/session/100", "telegram", "dm");

  // Session 0 was touched, so session 1 should be evicted instead
  assert.ok(manager.getInfo("test/session/0"), "session 0 should survive (was touched)");
  assert.equal(manager.getInfo("test/session/1"), null, "session 1 should be evicted");
});

test("SessionManager: a read right after an eviction sees the evicted turns", async () => {
  const manager = new SessionManager();
  const victim = "test/evict/victim";

  const session = await manager.getOrCreateWithMeta(victim, "telegram", "dm");
  session.title = "the setting that must survive";

  // Push it out of the cache. The eviction write is async: reading the file before it lands
  // used to return the pre-eviction copy, and the next run wrote that truncated history back.
  for (let i = 0; i < 101; i++) {
    await manager.getOrCreateWithMeta(`test/evict/filler/${i}`, "telegram", "dm");
  }
  assert.equal(manager.getInfo(victim), null, "victim should be out of memory");

  const reloaded = await manager.read(victim);
  assert.ok(reloaded, "victim should be readable from disk");
  assert.equal(reloaded.title, "the setting that must survive");
});

test("SessionManager: peek loads session into cache", async () => {
  const manager = new SessionManager();
  // peek for a non-existent session returns null (no disk file in test)
  const result = await manager.peek("nonexistent/session");
  assert.equal(result, null);
});


test("SessionManager: open logs are bounded on their own, not only by the session cache", async () => {
  // `logOf` opens a log without touching the session LRU, so a caller that walked every
  // conversation -- the drawer did -- filled the map with handles nothing would ever evict. Each
  // one holds a whole parsed JSONL file, which is how the process reached 451 MB resident.
  const manager = new SessionManager();

  for (let i = 0; i < 40; i++) {
    await manager.getOrCreateWithMeta(`test/logs/${i}`, "telegram", "dm");
    const log = await manager.logOf(`test/logs/${i}`);
    log.append({ type: "user", prompt: true, text: `message ${i}` });
  }

  assert.equal(manager.hasCachedLog("test/logs/0"), false, "the oldest log must be out of the cache");
  assert.ok(manager.hasCachedLog("test/logs/39"), "the newest log must still be cached");

  // Closed, not lost: reopening reads the file, and the entry written before eviction is there.
  const reopened = await manager.logOf("test/logs/0");
  assert.equal(reopened.entries().length, 1);
  assert.equal(reopened.promptCount(), 1);
  assert.equal(reopened.firstUserText(), "message 0");
});

test("SessionManager: a listing's counts are mirrored into the meta, so nothing has to open a log", async () => {
  const manager = new SessionManager();
  const id = "test/counts/one";
  await manager.getOrCreateWithMeta(id, "telegram", "dm");
  const log = await manager.logOf(id);
  log.append({ type: "user", prompt: true, text: "bonjour" });
  log.append({ type: "phase", prompt: true, text: "reponse", runId: "r1" });
  log.append({ type: "failure", prompt: false, error: "boom" });

  await manager.persist(id);

  const meta = await readMeta(id);
  assert.equal(meta?.promptCount, 2, "a failure is not part of a prompt");
  assert.equal(meta?.firstUserText, "bonjour");
});

test("SessionManager: a log a run still holds is the one handed out after its eviction, never a second instance", async () => {
  // Reported: reload a page during a run and the thread comes back as it stood before the
  // question. The run holds the log it opened and appends through that reference; the reload
  // opened enough other logs (one per cron run) to evict it, and the sync then read a fresh
  // instance off the disk, resuming at the leaf the meta last persisted -- from before the run.
  // The failure entry and the next turn attached there, and the run became a dead branch.
  const manager = new SessionManager();
  const id = "test/live/held-by-a-run";
  await manager.getOrCreateWithMeta(id, "telegram", "dm");
  const held = await manager.logOf(id);
  const question = held.append({ type: "user", prompt: true, text: "la question" });

  for (let i = 0; i < 30; i++) {
    await manager.getOrCreateWithMeta(`test/live/other-${i}`, "telegram", "dm");
    await manager.logOf(`test/live/other-${i}`);
  }
  // The run keeps writing through the reference it holds, cache or no cache.
  const work = held.append({ type: "phase", prompt: true, text: "du travail", runId: "run-x" } as never);

  const again = await manager.logOf(id);
  assert.equal(again, held, "the same instance, not one read back off the disk");
  assert.equal(again.leaf(), work.id, "the leaf is where the run left it, not where the meta last saw it");
  assert.equal(manager.peekLog(id), held);

  // A caller with no reference of its own (the adapter recording a failure, the next turn) lands
  // after the run's work, on the same branch.
  const after = again.append({ type: "failure", prompt: false, error: "boom" } as never);
  assert.equal(after.parentId, work.id);
  assert.notEqual(after.parentId, question.parentId);
});

test("SessionManager: the persisted leaf follows the instance a run holds, even once the cache let it go", async () => {
  const manager = new SessionManager();
  const id = "test/live/persisted-leaf";
  const session = await manager.getOrCreateWithMeta(id, "telegram", "dm");
  const held = await manager.logOf(id);
  held.append({ type: "user", prompt: true, text: "q" });
  for (let i = 0; i < 30; i++) {
    await manager.getOrCreateWithMeta(`test/live/churn-${i}`, "telegram", "dm");
    await manager.logOf(`test/live/churn-${i}`);
  }
  const last = held.append({ type: "user", prompt: true, text: "q2" });
  await manager.persist(session.id);
  const meta = await readMeta(id);
  assert.equal(meta?.leafId, last.id);
});
