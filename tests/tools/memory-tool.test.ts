import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import type { MyClawConfig } from "../../src/core/config.ts";
import { createMemoryTool } from "../../src/tools/memory.ts";
import { closeMemoryDb, clearAllEntries } from "../../src/memory/db.ts";

const DB = join(tmpdir(), `mc-memtool-${process.pid}-${Date.now()}.db`);
let savedWs: string | undefined;
let savedDb: string | undefined;

const config = { memory: {} } as MyClawConfig;
const tool = createMemoryTool(config);

beforeAll(() => {
  savedWs = process.env["MY_CLAW_WORKSPACE"];
  savedDb = process.env["MY_CLAW_MEMORY_DB"];
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  process.env["MY_CLAW_WORKSPACE"] = tmpdir();
  closeMemoryDb();
});

afterAll(() => {
  closeMemoryDb();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  if (savedDb === undefined) delete process.env["MY_CLAW_MEMORY_DB"];
  else process.env["MY_CLAW_MEMORY_DB"] = savedDb;
  if (savedWs === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = savedWs;
});

beforeEach(() => clearAllEntries());

test("remember without content errors", async () => {
  const r = await tool.execute({ action: "remember", content: "" });
  expect(r.success).toBe(false);
  expect(r.output).toContain("content is required");
});

test("invalid action errors", async () => {
  const r = await tool.execute({ action: "frobnicate" });
  expect(r.success).toBe(false);
  expect(r.output).toContain("Invalid action");
});

test("remember then recall returns the fact", async () => {
  const stored = await tool.execute({
    action: "remember",
    content: "User prefers dark mode in the terminal",
    category: "user",
  });
  expect(stored.success).toBe(true);

  const recalled = await tool.execute({ action: "recall", query: "terminal dark mode" });
  expect(recalled.success).toBe(true);
  expect(recalled.output).toContain("dark mode");
});

test("remember dedups exact duplicates", async () => {
  await tool.execute({ action: "remember", content: "The build uses Bun", category: "project" });
  const dup = await tool.execute({ action: "remember", content: "The build uses Bun", category: "project" });
  expect(dup.output.toLowerCase()).toContain("already known");
});

test("list filters by category", async () => {
  await tool.execute({ action: "remember", content: "Deploy via make release", category: "convention" });
  await tool.execute({ action: "remember", content: "User lives in France", category: "user" });
  const r = await tool.execute({ action: "list", category: "user" });
  expect(r.output).toContain("France");
  expect(r.output).not.toContain("make release");
});

test("forget removes a fact", async () => {
  await tool.execute({ action: "remember", content: "Temporary fact to forget", category: "lesson" });
  const forgotten = await tool.execute({ action: "forget", old_text: "Temporary fact to forget" });
  expect(forgotten.output.toLowerCase()).toContain("forgotten");
  const list = await tool.execute({ action: "list" });
  expect(list.output).not.toContain("Temporary fact to forget");
});

test("update supersedes the old fact", async () => {
  await tool.execute({ action: "remember", content: "Server runs on port 3000", category: "environment" });
  const updated = await tool.execute({
    action: "update",
    old_text: "Server runs on port 3000",
    content: "Server runs on port 8080",
  });
  expect(updated.success).toBe(true);
  const list = await tool.execute({ action: "list" });
  expect(list.output).toContain("8080");
  expect(list.output).not.toContain("3000");
});
