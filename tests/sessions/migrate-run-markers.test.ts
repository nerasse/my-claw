import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { migrateRunMarkers, migrateRunMarkersForSession } from "../../src/sessions/migrate-run-markers.ts";
import { ENTRIES_FILE, openSessionLog, parseEntryLine, pathOf, sessionDir, type Entry } from "../../src/sessions/log.ts";
import { writeMeta, metaOf } from "../../src/sessions/meta.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const SESSION = "my-claw-app/thread/owner/t1";

let seq = 0;
interface Input {
  type: string;
  prompt: boolean;
  text?: string;
  input?: string;
  output?: string;
  callId?: string;
  name?: string;
  error?: string;
  runId?: string;
}

/** Writes a session file whose entries chain linearly, the way runs actually wrote them. */
async function writeSession(bodies: Input[]): Promise<string[]> {
  const dir = sessionDir(SESSION);
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  let parent: string | null = null;
  for (const body of bodies) {
    const n = seq++;
    const id = `e${n}`;
    const entry = { ...body, id, seq: n, parentId: parent, ts: 1_800_000_000_000 + n * 1000 };
    lines.push(JSON.stringify(entry));
    parent = id;
  }
  await writeFile(join(dir, ENTRIES_FILE), `${lines.join("\n")}\n`, "utf-8");
  const meta = metaOf({ id: SESSION, platform: "my-claw-app", chatType: "thread", createdAt: "x", lastActiveAt: "x" }, parent);
  await writeMeta(SESSION, meta);
  return lines;
}

async function readEntries(): Promise<Entry[]> {
  const raw = await readFile(join(sessionDir(SESSION), ENTRIES_FILE), "utf-8");
  const out: Entry[] = [];
  raw.split("\n").forEach((line, i) => {
    const entry = parseEntryLine(line, SESSION, i);
    if (entry) out.push(entry);
  });
  return out;
}

const user = (text: string): Input => ({ type: "user", prompt: true, text });
const phase = (text: string): Input => ({ type: "phase", prompt: true, text, runId: "r" });
const tool = (callId: string): Input => ({ type: "tool", prompt: true, callId, name: "bash", runId: "r" });
const failure = (error: string): Input => ({ type: "failure", prompt: false, error });
const command = (input: string): Input => ({ type: "command", prompt: false, input, output: "ok" });

beforeEach(async () => {
  await rm(SESSIONS_DIR, { recursive: true, force: true });
  await mkdir(SESSIONS_DIR, { recursive: true });
  seq = 0;
});

describe("migrateRunMarkersForSession", () => {
  test("wraps each run's work in markers, trigger stay outside", async () => {
    await writeSession([user("q1"), phase("think"), tool("c1"), phase("answer"), user("q2"), tool("c2"), phase("done")]);
    expect(await migrateRunMarkersForSession(SESSION)).toBe(true);
    const entries = await readEntries();
    const types = entries.map((e) => e.type);
    expect(types).toEqual(["user", "run_start", "phase", "tool", "phase", "run_end", "user", "run_start", "tool", "phase", "run_end"]);
    // The trigger stays outside: the run_start hangs off it, the work chains under the marker.
    expect(entries[1]!.parentId).toBe(entries[0]!.id);
    expect(entries[2]!.parentId).toBe(entries[1]!.id);
    expect(entries[4]!.parentId).toBe(entries[3]!.id);
    expect(entries[5]!.parentId).toBe(entries[4]!.id);
    expect(entries[6]!.parentId).toBe(entries[5]!.id);
  });

  test("the branch walked from the leaf crosses every marker", async () => {
    const lines = await writeSession([user("q1"), phase("a"), user("q2"), tool("c1"), phase("b")]);
    await migrateRunMarkersForSession(SESSION);
    const log = await openSessionLog(SESSION);
    const path = pathOf(log.entries(), log.leaf());
    expect(path.map((e) => e.type)).toEqual(["user", "run_start", "phase", "run_end", "user", "run_start", "tool", "phase", "run_end"]);
    // Every entry keeps the id it had before the pass (cursors into the file still resolve).
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: string };
      expect(log.get(parsed.id)).toBeDefined();
    }
  });

  test("an injection between tool calls stays inside its run", async () => {
    await writeSession([user("q1"), tool("c1"), user("steer"), phase("answer"), user("q2"), phase("next")]);
    await migrateRunMarkersForSession(SESSION);
    const entries = await readEntries();
    const firstRun = entries.findIndex((e) => e.type === "run_start");
    const firstEnd = entries.findIndex((e) => e.type === "run_end");
    // The steer sits between the two markers of run 1 (exclusive of the trigger).
    const inside = entries.slice(firstRun + 1, firstEnd);
    expect(inside.map((e) => e.type)).toEqual(["tool", "user", "phase"]);
  });

  test("a user after a phase closes the previous run and opens the next", async () => {
    await writeSession([user("q1"), phase("a"), phase("b"), user("q2"), phase("c")]);
    await migrateRunMarkersForSession(SESSION);
    const entries = await readEntries();
    expect(entries.filter((e) => e.type === "run_start")).toHaveLength(2);
    expect(entries.filter((e) => e.type === "run_end")).toHaveLength(2);
  });

  test("a failure closes its run as error", async () => {
    await writeSession([user("q1"), phase("a"), tool("c1"), failure("boom"), user("q2"), phase("b")]);
    await migrateRunMarkersForSession(SESSION);
    const entries = await readEntries();
    const end = entries.find((e) => e.type === "run_end")!;
    expect((end as { reason: string }).reason).toBe("error");
    // The failure itself is not run content: it stays between the end marker and the next run.
    const types = entries.map((e) => e.type);
    expect(types.indexOf("failure")).toBe(types.indexOf("run_end") + 1);
  });

  test("a user turn with no work is left alone", async () => {
    await writeSession([user("q1"), failure("nothing happened"), user("q2"), phase("work")]);
    expect(await migrateRunMarkersForSession(SESSION)).toBe(true);
    const entries = await readEntries();
    expect(entries.filter((e) => e.type === "run_start")).toHaveLength(1);
    // The run_start belongs to q2's run: it sits between q2 and its phase, before the run_end.
    const q2 = entries.find((e) => e.type === "user" && (e as { text?: string }).text === "q2")!;
    expect(entries[entries.length - 1]!.type).toBe("run_end");
    const work = entries[entries.length - 2]!;
    expect(work.type).toBe("phase");
    expect(entries[entries.indexOf(work) - 1]!.type).toBe("run_start");
    expect(entries[entries.indexOf(work) - 1]!.parentId).toBe(q2.id);
  });

  test("already migrated sessions are skipped untouched", async () => {
    await writeSession([user("q1"), phase("a")]);
    await migrateRunMarkersForSession(SESSION);
    const before = await readFile(join(sessionDir(SESSION), ENTRIES_FILE), "utf-8");
    expect(await migrateRunMarkersForSession(SESSION)).toBe(false);
    const after = await readFile(join(sessionDir(SESSION), ENTRIES_FILE), "utf-8");
    expect(after).toBe(before);
  });

  test("a conversation without work is not rewritten", async () => {
    await writeSession([user("q1"), command("/status")]);
    expect(await migrateRunMarkersForSession(SESSION)).toBe(false);
  });

  test("the original file is backed up before the rewrite", async () => {
    await writeSession([user("q1"), phase("a")]);
    await migrateRunMarkersForSession(SESSION);
    const names = await readdir(sessionDir(SESSION));
    const backup = names.find((n) => n.startsWith(`${ENTRIES_FILE}.runmarkers-`) && n.endsWith(".bak"));
    expect(backup).toBeDefined();
    const original = await readFile(join(sessionDir(SESSION), backup!), "utf-8");
    // The backup is the untouched pre-marker file: one line per original entry, none new.
    const types = original.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(["user", "phase"]);
  });

  test("seq numbers stay dense and ordered across markers", async () => {
    await writeSession([user("q1"), phase("a"), phase("b")]);
    await migrateRunMarkersForSession(SESSION);
    const entries = await readEntries();
    expect(entries.map((e) => e.seq)).toEqual([...entries.keys()]);
  });

  test("an interrupted trailing run closes as done", async () => {
    await writeSession([user("q1"), phase("a"), tool("c1")]);
    await migrateRunMarkersForSession(SESSION);
    const entries = await readEntries();
    expect(entries.map((e) => e.type)).toEqual(["user", "run_start", "phase", "tool", "run_end"]);
    expect((entries[entries.length - 1] as { reason: string }).reason).toBe("done");
  });
});

describe("migrateRunMarkers", () => {
  test("walks nested sessions and reports nothing on an empty tree", async () => {
    await migrateRunMarkers();
    expect(true).toBe(true);
  });

  test("migrates a cron session nested one level deep", async () => {
    const dir = join(SESSIONS_DIR, "cron/job1/run-abc");
    await mkdir(dir, { recursive: true });
    const bodies = [user("q"), phase("a")];
    let parent: string | null = null;
    const lines: string[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const entry = { ...bodies[i]!, id: `c${i}`, seq: i, parentId: parent, ts: 1_800_000_000_000 + i * 1000 };
      lines.push(JSON.stringify(entry));
      parent = `c${i}`;
    }
    await writeFile(join(dir, ENTRIES_FILE), `${lines.join("\n")}\n`, "utf-8");
    const meta = metaOf({ id: "cron/job1/run-abc", platform: "my-claw-app", chatType: "thread", createdAt: "x", lastActiveAt: "x" }, "c1");
    await writeMeta("cron/job1/run-abc", meta);
    await migrateRunMarkers();
    const raw = await readFile(join(dir, ENTRIES_FILE), "utf-8");
    expect(raw.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["user", "run_start", "phase", "run_end"]);
  });
});