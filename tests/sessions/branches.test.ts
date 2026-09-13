import { describe, test, expect } from "bun:test";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { repairBranches } from "../../src/sessions/branches.ts";
import { openSessionLog, entriesPath, type Entry } from "../../src/sessions/log.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { readMeta } from "../../src/sessions/meta.ts";

/**
 * Builds a log from a compact spec: `id:type:parent`. `seq` and `ts` follow file order, which is
 * what the repair sorts orphans by.
 */
function build(spec: string[], extra: Record<string, Partial<Entry>> = {}): Entry[] {
  return spec.map((line, i) => {
    const [id, type, parent] = line.split(":");
    const base = { id, seq: i, ts: 1_000 + i, parentId: parent === "-" ? null : parent, type, prompt: type === "user" };
    const fields =
      type === "user" ? { text: `q${i}` }
      : type === "phase" ? { text: `a${i}`, runId: "t" }
      : type === "tool" ? { name: "bash", callId: `c${i}`, args: {}, ok: true, output: "", runId: "t" }
      : type === "run_end" ? { reason: "done" }
      : type === "command" ? { input: "/x", output: "" }
      : type === "failure" ? { error: "boom" }
      : {};
    return { ...base, ...fields, ...(extra[id!] ?? {}) } as unknown as Entry;
  });
}

const path = (entries: Entry[], leaf: string | null): string[] => {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: string[] = [];
  let cur = leaf ? byId.get(leaf) : undefined;
  while (cur) {
    out.unshift(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
};

describe("repairBranches", () => {
  test("a clean log is returned as it is", () => {
    const entries = build(["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "e1:run_end:p1"]);
    const out = repairBranches(entries, "e1");
    expect(out.relinked).toEqual([]);
    expect(out.bugForks).toBe(0);
    expect(out.leafId).toBe("e1");
    expect(out.entries[0]).toBe(entries[0]);
  });

  test("what a second instance appended at a stale leaf is spliced back, in file order, before it", () => {
    // The run wrote u2..e2 past p1 while a second instance, still on p1, appended a compaction
    // and the owner's next question: u3 hangs off p1, and the run is a dead branch.
    const entries = build([
      "u1:user:-", "s1:run_start:u1", "p1:phase:s1",
      "u2:user:p1", "s2:run_start:u2", "t2:tool:s2", "p2:phase:t2", "e2:run_end:p2",
      "c3:compaction:p1", "u3:user:c3",
    ]);
    const out = repairBranches(entries, "u3");
    expect(out.bugForks).toBe(1);
    expect(out.deliberateForks).toBe(0);
    expect(out.adoptedTail).toBe(false);
    expect(path(out.entries, out.leafId)).toEqual(["u1", "s1", "p1", "u2", "s2", "t2", "p2", "e2", "c3", "u3"]);
    // Only the survivor's link moved: the orphans were already chained to each other.
    expect(out.relinked).toEqual(["c3"]);
    // The originals are untouched; the relinked entry is a copy.
    expect(entries[8]!.parentId).toBe("p1");
  });

  test("a dead tail at the end of the file becomes the leaf", () => {
    // The meta was one entry behind: the run_end written after the last persist.
    const entries = build(["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "e1:run_end:p1"]);
    const out = repairBranches(entries, "p1");
    expect(out.adoptedTail).toBe(true);
    expect(out.leafId).toBe("e1");
    expect(out.relinked).toEqual([]);
    expect(out.bugForks).toBe(1);
  });

  test("a rewind command heading the surviving branch is deliberate", () => {
    const entries = build(
      ["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "e1:run_end:p1", "k:command:u1", "u2:user:k"],
      { k: { input: "/undo", output: "rewound" } as Partial<Entry> },
    );
    const out = repairBranches(entries, "u2");
    expect(out.deliberateForks).toBe(1);
    expect(out.bugForks).toBe(0);
    expect(out.relinked).toEqual([]);
    expect(out.leafId).toBe("u2");
  });

  test("a rewind command heading the abandoned branch is deliberate too: that is what /redo leaves", () => {
    // /undo wrote k1 under u1; /redo moved back to the original tip and wrote k2 there.
    const entries = build(
      ["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "e1:run_end:p1", "k1:command:u1", "k2:command:e1"],
      { k1: { input: "/undo", output: "" } as Partial<Entry>, k2: { input: "/redo", output: "" } as Partial<Entry> },
    );
    const out = repairBranches(entries, "k2");
    expect(out.deliberateForks).toBe(1);
    expect(out.relinked).toEqual([]);
  });

  test("/branches and /retry and /fork count as rewinds", () => {
    for (const input of ["/branches 2", "/retry", "/fork", "/Undo"]) {
      const entries = build(
        ["u1:user:-", "p1:phase:u1", "k:command:u1", "u2:user:k"],
        { k: { input, output: "" } as Partial<Entry> },
      );
      expect(repairBranches(entries, "u2").deliberateForks).toBe(1);
    }
  });

  test("a run that died of an error left its work off the branch: it goes back on, markers included", () => {
    // What the rewind on error wrote until it was removed: the run's own entries hanging off the
    // question, the failure filed on the question, the next turn under the failure. Nothing marked
    // it, nobody asked for it, and the tool call it settled was invisible on reload.
    const entries = build(
      ["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "t1:tool:p1", "e1:run_end:t1", "f1:failure:u1", "u2:user:f1"],
      { e1: { reason: "error" } as Partial<Entry> },
    );
    const out = repairBranches(entries, "u2");
    expect(out.bugForks).toBe(1);
    expect(out.deliberateForks).toBe(0);
    expect(path(out.entries, out.leafId)).toEqual(["u1", "s1", "p1", "t1", "e1", "f1", "u2"]);
  });

  test("a log from before the run markers, where only the filed failure names the error, goes back too", () => {
    const entries = build(["u1:user:-", "p1:phase:u1", "t1:tool:p1", "f1:failure:u1", "u2:user:f1"]);
    const out = repairBranches(entries, "u2");
    expect(out.bugForks).toBe(1);
    expect(out.deliberateForks).toBe(0);
    expect(path(out.entries, out.leafId)).toEqual(["u1", "p1", "t1", "f1", "u2"]);
  });

  test("an owner rewind over a run that died of an error is still deliberate, and stays abandoned", () => {
    // The trap: both marks on one fork. `/undo` moved back over an attempt that had died of an
    // error, so the fork carries the error shape *and* the command. The command wins -- a branch
    // the owner walked away from is never put back, however it died.
    const entries = build(
      ["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "t1:tool:p1", "e1:run_end:t1", "k:command:u1", "u2:user:k"],
      { e1: { reason: "error" } as Partial<Entry>, k: { input: "/undo", output: "rewound" } as Partial<Entry> },
    );
    const out = repairBranches(entries, "u2");
    expect(out.deliberateForks).toBe(1);
    expect(out.bugForks).toBe(0);
    expect(out.relinked).toEqual([]);
    expect(path(out.entries, out.leafId)).toEqual(["u1", "k", "u2"]);
  });

  test("several forks and a nested one are all put back, oldest first", () => {
    const entries = build([
      "u1:user:-", "p1:phase:u1",
      "a1:phase:p1", "a2:tool:a1", "b1:phase:a1", // a2 and b1 both hang off a1: a nested fork inside the orphans
      "x1:phase:p1", "u2:user:x1",
      "y1:phase:u2", "y2:phase:y1",
      "z1:phase:u2", "u3:user:z1",
    ]);
    const out = repairBranches(entries, "u3");
    expect(out.bugForks).toBe(2);
    expect(path(out.entries, out.leafId)).toEqual(["u1", "p1", "a1", "a2", "b1", "x1", "u2", "y1", "y2", "z1", "u3"]);
  });

  test("an entry whose parent is not in the log is put behind the line before it, not treated as a fork", () => {
    // The parent's line was lost to a short write -- tests/sessions/torn-line.test.ts has the
    // measured case. File order is what is left to say where the entry belongs.
    const entries = build(["u1:user:-", "p1:phase:u1", "w:phase:ghost"]);
    const out = repairBranches(entries, "w");
    expect(out.reparented).toEqual(["w"]);
    expect(path(out.entries, out.leafId)).toEqual(["u1", "p1", "w"]);
    expect(out.bugForks).toBe(0);
    expect(out.relinked).toEqual([]);
  });

  test("an unknown leaf falls back to the last entry, as the log itself does", () => {
    const entries = build(["u1:user:-", "p1:phase:u1"]);
    const out = repairBranches(entries, "nope");
    expect(out.leafId).toBe("p1");
    expect(out.bugForks).toBe(0);
  });
});

describe("openSessionLog repairs at open", () => {
  const write = async (sessionId: string, entries: Entry[]): Promise<string> => {
    const file = entriesPath(sessionId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    return file;
  };

  test("a dead branch is on the branch once the log is open, the file is rewritten and a copy is kept", async () => {
    const id = "test/branches/open-repair";
    const entries = build([
      "u1:user:-", "p1:phase:u1",
      "u2:user:p1", "p2:phase:u2",
      "c3:compaction:p1", "u3:user:c3",
    ]);
    const file = await write(id, entries);
    const log = await openSessionLog(id, "u3");
    expect(log.path().map((e) => e.id)).toEqual(["u1", "p1", "u2", "p2", "c3", "u3"]);
    expect(log.leaf()).toBe("u3");
    expect(log.repaired?.relinked).toBe(1);

    const onDisk = (await readFile(file, "utf-8")).trim().split("\n").map((l) => JSON.parse(l) as Entry);
    expect(onDisk.find((e) => e.id === "c3")?.parentId).toBe("p2");
    const siblings = await readdir(dirname(file));
    expect(siblings.filter((name) => name.startsWith("entries.jsonl.bak-branches-"))).toHaveLength(1);

    // Idempotent: the second open finds nothing to do and keeps no second copy.
    const again = await openSessionLog(id, "u3");
    expect(again.repaired).toBeNull();
    expect((await readdir(dirname(file))).filter((name) => name.startsWith("entries.jsonl.bak-branches-"))).toHaveLength(1);
  });

  test("a leaf behind the file adopts the tail without rewriting anything", async () => {
    const id = "test/branches/open-tail";
    const entries = build(["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "e1:run_end:p1"]);
    const file = await write(id, entries);
    const log = await openSessionLog(id, "p1");
    expect(log.leaf()).toBe("e1");
    expect(log.repaired?.adoptedTail).toBe(true);
    expect((await readdir(dirname(file))).filter((name) => name.startsWith("entries.jsonl.bak-"))).toHaveLength(0);
  });

  test("a deliberate rewind opens exactly as it was", async () => {
    const id = "test/branches/open-undo";
    const entries = build(
      ["u1:user:-", "p1:phase:u1", "k:command:u1", "u2:user:k"],
      { k: { input: "/undo", output: "" } as Partial<Entry> },
    );
    await write(id, entries);
    const log = await openSessionLog(id, "u2");
    expect(log.repaired).toBeNull();
    expect(log.path().map((e) => e.id)).toEqual(["u1", "k", "u2"]);
  });

  test("the manager carries an adopted tail to the meta, so the next open starts there", async () => {
    const manager = new SessionManager();
    const id = "test/branches/manager-tail";
    await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    await manager.persist(id);
    const entries = build(["u1:user:-", "s1:run_start:u1", "p1:phase:s1", "e1:run_end:p1"]);
    await write(id, entries);
    const meta = await readMeta(id);
    // The meta says p1, as a run persisted before writing its run_end would have left it.
    await writeFile(`${dirname(entriesPath(id))}/meta.json`, JSON.stringify({ ...meta, leafId: "p1" }), "utf-8");
    manager.drop(id);

    const log = await manager.logOf(id);
    expect(log.leaf()).toBe("e1");
    expect((await readMeta(id))?.leafId).toBe("e1");
  });
});
