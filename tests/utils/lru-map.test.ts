import { test } from "bun:test";
import assert from "node:assert/strict";
import { LruMap, TtlSet } from "../../src/utils/lru-map.ts";

// --- LruMap ---

test("LruMap: respects maxSize", () => {
  const map = new LruMap<string, number>(3);
  map.set("a", 1);
  map.set("b", 2);
  map.set("c", 3);
  map.set("d", 4);
  assert.equal(map.size, 3);
  assert.equal(map.has("a"), false); // evicted (oldest)
  assert.equal(map.get("b"), 2);
  assert.equal(map.get("d"), 4);
});

test("LruMap: get moves entry to most-recently-used", () => {
  const map = new LruMap<string, number>(3);
  map.set("a", 1);
  map.set("b", 2);
  map.set("c", 3);
  map.get("a"); // touch a -> now b is oldest
  map.set("d", 4); // evicts b
  assert.equal(map.has("a"), true);
  assert.equal(map.has("b"), false);
  assert.equal(map.has("c"), true);
  assert.equal(map.has("d"), true);
});

test("LruMap: set existing key moves to end", () => {
  const map = new LruMap<string, number>(3);
  map.set("a", 1);
  map.set("b", 2);
  map.set("c", 3);
  map.set("a", 10); // update a -> b is oldest
  map.set("d", 4); // evicts b
  assert.equal(map.get("a"), 10);
  assert.equal(map.has("b"), false);
});

test("LruMap: onEvict callback fires on eviction", () => {
  const evicted: Array<[string, number]> = [];
  const map = new LruMap<string, number>(2, (k, v) => evicted.push([k, v]));
  map.set("a", 1);
  map.set("b", 2);
  map.set("c", 3); // evicts a
  assert.equal(evicted.length, 1);
  assert.deepEqual(evicted[0], ["a", 1]);
});

test("LruMap: onEvict fires for each evicted entry", () => {
  const evicted: string[] = [];
  const map = new LruMap<string, number>(2, (k) => evicted.push(k));
  map.set("a", 1);
  map.set("b", 2);
  map.set("c", 3); // evicts a
  map.set("d", 4); // evicts b
  assert.deepEqual(evicted, ["a", "b"]);
});

test("LruMap: delete does not trigger onEvict", () => {
  const evicted: string[] = [];
  const map = new LruMap<string, number>(3, (k) => evicted.push(k));
  map.set("a", 1);
  map.delete("a");
  assert.equal(evicted.length, 0);
});

test("LruMap: maxSize 1 works", () => {
  const map = new LruMap<string, number>(1);
  map.set("a", 1);
  map.set("b", 2);
  assert.equal(map.size, 1);
  assert.equal(map.get("b"), 2);
  assert.equal(map.has("a"), false);
});

test("LruMap: standard Map operations still work", () => {
  const map = new LruMap<string, number>(10);
  map.set("a", 1);
  map.set("b", 2);
  assert.equal(map.size, 2);
  assert.equal(map.has("a"), true);
  map.delete("a");
  assert.equal(map.size, 1);
  assert.equal(map.has("a"), false);
  map.clear();
  assert.equal(map.size, 0);
});

// --- TtlSet ---

test("TtlSet: add and has", () => {
  const set = new TtlSet<string>(60_000);
  set.add("a");
  assert.equal(set.has("a"), true);
  assert.equal(set.has("b"), false);
});

test("TtlSet: entries expire after TTL", async () => {
  const set = new TtlSet<string>(50); // 50ms TTL
  set.add("a");
  assert.equal(set.has("a"), true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(set.has("a"), false);
});

test("TtlSet: delete removes entry", () => {
  const set = new TtlSet<string>(60_000);
  set.add("a");
  set.delete("a");
  assert.equal(set.has("a"), false);
});

test("TtlSet: respects maxSize", () => {
  const set = new TtlSet<string>(60_000, 3);
  set.add("a");
  set.add("b");
  set.add("c");
  set.add("d"); // evicts oldest
  assert.ok(set.size <= 3);
  assert.equal(set.has("d"), true);
});

test("TtlSet: prune removes expired entries", async () => {
  const set = new TtlSet<string>(50, 100);
  set.add("a");
  set.add("b");
  await new Promise((r) => setTimeout(r, 80));
  set.add("c"); // triggers prune
  assert.equal(set.has("c"), true);
  assert.equal(set.has("a"), false);
  assert.equal(set.has("b"), false);
});

test("TtlSet: clear empties the set", () => {
  const set = new TtlSet<string>(60_000);
  set.add("a");
  set.add("b");
  set.clear();
  assert.equal(set.size, 0);
});
