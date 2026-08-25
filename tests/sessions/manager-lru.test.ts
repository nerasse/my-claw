import { test } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/sessions/manager.ts";

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

