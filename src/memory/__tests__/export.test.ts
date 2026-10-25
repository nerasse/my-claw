import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { addEntry, getAllActive, countActive, closeMemoryDb, clearAllEntries } from "../db.ts";
import { hashContent } from "../dedup.ts";
import { exportToMarkdown, importHandEdits, migrateLegacyFiles, memoryFilePath } from "../export.ts";

const DB = join(tmpdir(), `mc-export-${process.pid}-${Date.now()}.db`);
let workspace: string;
let claw: string;
let savedWs: string | undefined;
let savedDb: string | undefined;

beforeAll(() => {
  savedWs = process.env["MY_CLAW_WORKSPACE"];
  savedDb = process.env["MY_CLAW_MEMORY_DB"];
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  workspace = mkdtempSync(join(tmpdir(), "mc-ws-"));
  process.env["MY_CLAW_WORKSPACE"] = workspace;
  closeMemoryDb();
});
afterAll(() => {
  closeMemoryDb();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  rmSync(workspace, { recursive: true, force: true });
  if (savedDb === undefined) delete process.env["MY_CLAW_MEMORY_DB"];
  else process.env["MY_CLAW_MEMORY_DB"] = savedDb;
  if (savedWs === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = savedWs;
});
beforeEach(() => clearAllEntries());

test("exportToMarkdown groups entries by category", async () => {
  addEntry("User lives in France", "user", {}, hashContent("User lives in France"));
  addEntry("Deploy via make release", "convention", {}, hashContent("Deploy via make release"));
  await exportToMarkdown();
  const md = readFileSync(memoryFilePath(), "utf-8");
  expect(md).toContain("## User");
  expect(md).toContain("- User lives in France");
  expect(md).toContain("## Conventions");
  expect(md).toContain("- Deploy via make release");
});

test("importHandEdits adds new bullets under category headings", async () => {
  const md = ["# Memory", "", "## User", "- Hand written preference", "", "## Lessons", "- A learned lesson"].join("\n");
  writeFileSync(memoryFilePath(), md);
  const n = await importHandEdits();
  expect(n).toBe(2);
  const entries = getAllActive();
  const user = entries.find((e) => e.content === "Hand written preference");
  expect(user?.category).toBe("user");
  const lesson = entries.find((e) => e.content === "A learned lesson");
  expect(lesson?.category).toBe("lesson");
});

test("importHandEdits is idempotent", async () => {
  const md = ["## User", "- Repeated fact"].join("\n");
  writeFileSync(memoryFilePath(), md);
  expect(await importHandEdits()).toBe(1);
  expect(await importHandEdits()).toBe(0);
  expect(countActive()).toBe(1);
});

test("export then import round-trips without duplicating", async () => {
  addEntry("Project uses Bun runtime", "project", {}, hashContent("Project uses Bun runtime"));
  await exportToMarkdown();
  expect(await importHandEdits()).toBe(0);
  expect(countActive()).toBe(1);
});

test("migrateLegacyFiles imports prompt-dir files and renames them", async () => {
  claw = mkdtempSync(join(tmpdir(), "mc-legacy-"));
  mkdirSync(claw, { recursive: true });
  writeFileSync(join(claw, "USER.md"), ["# User", "- User is called Neras", "User works on MyClaw"].join("\n"));
  writeFileSync(join(claw, "MEMORY.md"), ["## Self", "*(placeholder)*", "Learned that consolidation beats eviction"].join("\n"));

  const migrated = await migrateLegacyFiles(undefined, claw);
  expect(migrated).toBe(3);

  const entries = getAllActive();
  expect(entries.find((e) => e.content === "User is called Neras")?.category).toBe("user");
  expect(entries.find((e) => e.content === "User works on MyClaw")?.category).toBe("user");
  expect(entries.find((e) => e.content.includes("consolidation beats eviction"))?.category).toBe("lesson");

  // Idempotent: files renamed to .migrated, second run imports nothing.
  expect(await migrateLegacyFiles(undefined, claw)).toBe(0);
  rmSync(claw, { recursive: true, force: true });
});
