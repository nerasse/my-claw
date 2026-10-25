import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { addEntry, getActiveByCategory, countActive, closeMemoryDb, clearAllEntries } from "../db.ts";
import { hashContent } from "../dedup.ts";
import { consolidate, type LlmCaller } from "../consolidate.ts";

const DB = join(tmpdir(), `mc-consol-${process.pid}-${Date.now()}.db`);
let savedWs: string | undefined;
let savedDb: string | undefined;

beforeAll(() => {
  savedWs = process.env["MY_CLAW_WORKSPACE"];
  savedDb = process.env["MY_CLAW_MEMORY_DB"];
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  process.env["MY_CLAW_WORKSPACE"] = tmpdir();
  closeMemoryDb();
});
afterAll(() => {
  closeMemoryDb();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  if (savedDb === undefined) delete process.env["MY_CLAW_MEMORY_DB"];
  else process.env["MY_CLAW_MEMORY_DB"] = savedDb;
  if (savedWs === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = savedWs;
});
beforeEach(() => clearAllEntries());

function seedUser(n: number) {
  for (let i = 0; i < n; i++) {
    const c = `user fact number ${i}`;
    addEntry(c, "user", {}, hashContent(c));
  }
}

test("merges a category and supersedes old entries", async () => {
  seedUser(5);
  const caller: LlmCaller = async () => "User fact A\nUser fact B";
  const res = await consolidate(caller);
  expect(res.categoriesProcessed).toBe(1);
  const active = getActiveByCategory("user");
  expect(active.map((e) => e.content).sort()).toEqual(["User fact A", "User fact B"]);
});

test("skips categories below the merge threshold", async () => {
  seedUser(2);
  let called = false;
  const caller: LlmCaller = async () => {
    called = true;
    return "x";
  };
  const res = await consolidate(caller);
  expect(called).toBe(false);
  expect(res.categoriesProcessed).toBe(0);
  expect(countActive()).toBe(2);
});

test("never wipes a category on empty llm response", async () => {
  seedUser(5);
  const caller: LlmCaller = async () => "   ";
  const res = await consolidate(caller);
  expect(res.categoriesProcessed).toBe(0);
  expect(countActive()).toBe(5);
});

test("skips when no compaction achieved", async () => {
  seedUser(4);
  const caller: LlmCaller = async () => "one\ntwo\nthree\nfour\nfive";
  const res = await consolidate(caller);
  expect(res.categoriesProcessed).toBe(0);
  expect(countActive()).toBe(4);
});

test("strips bullet and numbering markers from facts", async () => {
  seedUser(4);
  const caller: LlmCaller = async () => "- First fact\n2. Second fact";
  await consolidate(caller);
  const active = getActiveByCategory("user").map((e) => e.content).sort();
  expect(active).toEqual(["First fact", "Second fact"]);
});

test("survives llm call failure without data loss", async () => {
  seedUser(5);
  const caller: LlmCaller = async () => {
    throw new Error("llm down");
  };
  const res = await consolidate(caller);
  expect(res.categoriesProcessed).toBe(0);
  expect(countActive()).toBe(5);
});
