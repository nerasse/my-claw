/**
 * What a short write leaves behind, and what reopening a log does with it -- docs/session-log.md.
 *
 * The disk filled on 2026-09-12 at 15:04 (`ENOSPC: no space left on device, write`, twice) and
 * two conversations lost every ancestor of their leaf. The fixtures are synthetic logs carrying
 * the two shapes it produced; `tests/fixtures/sessions/README.md` describes them.
 */

import { describe, test, expect } from "bun:test";
import { appendFile, copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repairBranches } from "../../src/sessions/branches.ts";
import {
  openSessionLog,
  parseEntryLine,
  pathOf,
  entriesPath,
  type Entry,
  type FailureEntry,
  type PhaseEntry,
  type ToolEntry,
  type UserEntry,
} from "../../src/sessions/log.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sessions");

let counter = 0;
const freshId = (): string => `test/torn/${process.pid}-${counter++}`;

/** The fixture, copied where a session log lives. Returns the path the log will be read from. */
async function plant(sessionId: string, fixture: string): Promise<string> {
  const file = entriesPath(sessionId);
  await mkdir(dirname(file), { recursive: true });
  await copyFile(join(FIXTURES, fixture), file);
  return file;
}

const linesOf = async (file: string): Promise<string[]> => (await readFile(file, "utf-8")).split("\n");

const backupsOf = async (file: string): Promise<string[]> =>
  (await readdir(dirname(file))).filter((name) => name.startsWith("entries.jsonl.bak-"));

describe("a write that stopped short", () => {
  test("the next entries start their own lines instead of gluing themselves to the stump", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const first = log.append<UserEntry>({ type: "user", prompt: true, text: "avant" });
    await log.flush();

    // What ENOSPC left: an entry that stops mid-token, with no newline after it. Written behind
    // the log's back, because that is exactly what a failed write is -- bytes the log thinks it
    // never wrote.
    const stump = '{"type":"tool","prompt":true,"callId":"call-1","name":"bash","args":{"command":"grep -rn \\"nee';
    await appendFile(entriesPath(id), stump, "utf-8");

    const second = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "apres", runId: "r1" });
    const third = log.append<UserEntry>({ type: "user", prompt: true, text: "encore" });
    await log.flush();

    const lines = await linesOf(entriesPath(id));
    expect(lines).toHaveLength(5); // three entries, the stump, and the empty tail after the last newline
    expect(lines[4]).toBe("");
    expect(lines[1]).toBe(stump);
    expect((JSON.parse(lines[0]!) as Entry).id).toBe(first.id);
    expect((JSON.parse(lines[2]!) as Entry).id).toBe(second.id);
    expect((JSON.parse(lines[3]!) as Entry).id).toBe(third.id);

    // The stump costs itself and nothing else: the three entries come back, chained.
    const reopened = await openSessionLog(id, third.id);
    expect(reopened.path().map((entry) => entry.id)).toEqual([first.id, second.id, third.id]);
  });
});

describe("parseEntryLine", () => {
  const whole = (id: string): string =>
    JSON.stringify({ type: "phase", prompt: true, text: "ok", runId: "r1", id, seq: 7, parentId: "p", ts: 1 });

  test("the entry glued behind a stump is read, a stump on its own is still nothing", () => {
    const stump = '{"type":"tool","prompt":true,"callId":"c1","name":"bash","args":{"command":"grep -rn nee';
    const entry = parseEntryLine(stump + whole("glued-1"), "test/torn/parse", 4521);
    expect(entry?.id).toBe("glued-1");
    expect(entry?.seq).toBe(7);
    // Nothing whole behind it: the line costs itself, as it always did.
    expect(parseEntryLine(stump, "test/torn/parse", 124)).toBeNull();
  });

  test("an object start inside a tool output is not mistaken for the boundary", () => {
    // A tool that printed JSONL: the output carries `{"type":"` twice, and neither can end the
    // line, so the only start the rest of the line parses from is the real one.
    const tool = JSON.stringify({
      type: "tool", prompt: true, callId: "c2", name: "bash",
      args: { command: "cat entries.jsonl" },
      output: '{"type":"user","id":"inner-1"}\n{"type":"phase","id":"inner-2"}',
      truncated: false, ok: true, runId: "r1", id: "outer", seq: 9, parentId: "p", ts: 2,
    });
    const entry = parseEntryLine('{"type":"spawn_state","prompt":false,"callId":"c1","subagentId":"sub","ts":178' + tool, "test/torn/parse", 7089);
    expect(entry?.id).toBe("outer");
    expect((entry as ToolEntry).output).toContain("inner-2");
  });
});

describe("an entry whose parent no line holds", () => {
  const build = (spec: string[]): Entry[] =>
    spec.map((line, i) => {
      const [id, type, parent] = line.split(":");
      return {
        id, seq: i, ts: 1_000 + i, parentId: parent === "-" ? null : parent, type, prompt: type === "user",
        ...(type === "user" ? { text: `q${i}` } : { text: `a${i}`, runId: "r" }),
      } as unknown as Entry;
    });

  test("is put behind the entry written just before it, in file order, unless nothing was", () => {
    const entries = build(["u1:user:-", "p1:phase:u1", "w:phase:ghost", "p2:phase:w"]);
    const out = repairBranches(entries, "p2");
    expect(out.reparented).toEqual(["w"]);
    expect(out.entries[2]!.parentId).toBe("p1");
    expect(out.relinked).toEqual([]);
    expect(out.bugForks).toBe(0);
    // The chain is whole again: the leaf reaches the root.
    expect(pathOf(out.entries, out.leafId).map((entry) => entry.id)).toEqual(["u1", "p1", "w", "p2"]);
    expect(entries[2]!.parentId).toBe("ghost"); // the input is never mutated

    // At the head of the file there is nothing to go behind, and a walk that stops there stops
    // on a root: the entry keeps the parent it names.
    const headless = repairBranches(build(["w:phase:ghost", "p1:phase:w"]), "p1");
    expect(headless.reparented).toEqual([]);
    expect(headless.entries[0]!.parentId).toBe("ghost");
  });
});

describe("a log a short write tore, reopened", () => {
  test("a stump with no identity: the entry behind it comes back and the branch is whole", async () => {
    const id = freshId();
    const file = await plant(id, "stump-without-identity.jsonl");

    const log = await openSessionLog(id);
    const entries = log.entries();
    const path = log.path();

    // Eighteen lines in the file, one of them holding a stump and an entry: the stump is not an
    // entry, the one behind it is.
    expect(entries).toHaveLength(18);
    expect(log.repaired).toEqual({ relinked: 0, reparented: 1, adoptedTail: false });

    // The whole branch, root to leaf, named. `a-11` is the recovered entry: it named `a-10`, the
    // id the stump never got to carry, and sits behind `a-09`, the line written before it.
    expect(path.map((entry) => entry.id)).toEqual([
      "a-01", "a-02", "a-03", "a-04", "a-05", "a-06", "a-07", "a-08", "a-09",
      "a-11", "a-12", "a-13", "a-14", "a-15", "a-19",
    ]);
    expect(path[0]!.parentId).toBeNull();
    expect((path[0] as UserEntry).type).toBe("user");
    const leaf = path[path.length - 1] as FailureEntry;
    expect(leaf.type).toBe("failure");
    expect(leaf.error).toBe("provider stream error: internal server error");

    // Counted apart: the run that died of an error and rewound to its question is a deliberate
    // fork, and stays off the branch. The repair heals the hole without swallowing that.
    const offBranch = entries.filter((entry) => !path.some((onPath) => onPath.id === entry.id));
    expect(offBranch.map((entry) => entry.id)).toEqual(["a-16", "a-17", "a-18"]);

    // The file was healed in place: every line of it parses now, and the bytes of the stump are
    // in the copy kept beside it.
    const lines = (await linesOf(file)).filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(18);
    for (const line of lines) expect(parseEntryLine(line, id, 0)).not.toBeNull();
    expect(await backupsOf(file)).toHaveLength(1);
    expect((await readdir(dirname(file))).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);

    // And it stays healed: a second open finds nothing to do.
    const before = await readFile(file, "utf-8");
    const again = await openSessionLog(id);
    expect(again.repaired).toBeNull();
    expect(again.path().map((entry) => entry.id)).toEqual(path.map((entry) => entry.id));
    expect(await readFile(file, "utf-8")).toBe(before);
    expect(await backupsOf(file)).toHaveLength(1);
  });

  test("a stump that carries an identity: the last boundary wins, and the log is one branch", async () => {
    const id = freshId();
    const file = await plant(id, "stump-with-identity.jsonl");

    const log = await openSessionLog(id);
    const entries = log.entries();
    const path = log.path();

    expect(entries).toHaveLength(14);
    expect(log.repaired).toEqual({ relinked: 0, reparented: 1, adoptedTail: false });
    // Every entry of this log is on one branch: the path is the log.
    expect(path).toHaveLength(14);
    expect(path.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(path[0]!.parentId).toBeNull();

    // The stump looks like an entry -- it has an id, a seq and a parent -- but it stops inside
    // its `ts`, so the suffix that parses whole is the one behind it.
    expect(entries.some((entry) => entry.id === "b-08")).toBe(false);
    const recovered = entries.findIndex((entry) => entry.id === "b-10");
    expect(recovered).toBeGreaterThan(0);
    expect((entries[recovered] as ToolEntry).type).toBe("tool");
    // Its own parent was never written: the seq jumps over the stump (7) and over the entry that
    // never reached the disk (8). What is left before it in the file is seq 6.
    expect(entries[recovered]!.seq).toBe(9);
    expect(entries[recovered]!.parentId).toBe(entries[recovered - 1]!.id);
    expect(entries[recovered - 1]!.seq).toBe(6);
    // The output it carries holds two object starts of its own, and neither won.
    expect((entries[recovered] as ToolEntry).output).toContain('"printed-2"');

    expect(await backupsOf(file)).toHaveLength(1);
    expect((await readdir(dirname(file))).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  test("a log nothing broke is opened and left exactly as it was", async () => {
    const id = freshId();
    const file = entriesPath(id);
    await mkdir(dirname(file), { recursive: true });
    const seed = await openSessionLog(id);
    const user = seed.append<UserEntry>({ type: "user", prompt: true, text: "question" });
    seed.append<PhaseEntry>({ type: "phase", prompt: true, text: "reponse", runId: "r1" });
    const tool = seed.append<ToolEntry>({
      type: "tool", prompt: true, callId: "c1", name: "bash", args: { command: "ls" },
      output: "a", truncated: false, ok: true, runId: "r1",
    });
    await seed.flush();
    const before = await readFile(file, "utf-8");

    const log = await openSessionLog(id, tool.id);
    expect(log.repaired).toBeNull();
    expect(log.path().map((entry) => entry.id)).toEqual([user.id, log.entries()[1]!.id, tool.id]);
    expect(await readFile(file, "utf-8")).toBe(before);
    expect(await backupsOf(file)).toHaveLength(0);
    expect((await readdir(dirname(file))).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });
});
