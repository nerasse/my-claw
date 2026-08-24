import { describe, test, expect } from "bun:test";
import { appendFile, mkdir, readFile, writeFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import {
  openSessionLog,
  entriesPath,
  pathOf,
  leavesOf,
  newEntryId,
  UnknownCursorError,
  type Entry,
  type UserEntry,
  type PhaseEntry,
  type ToolEntry,
} from "../../src/sessions/log.ts";

let counter = 0;
function freshId(): string {
  return `test-log-${process.pid}-${counter++}`;
}

async function seed(sessionId: string, texts: string[]): Promise<void> {
  const log = await openSessionLog(sessionId);
  for (const text of texts) log.append<UserEntry>({ type: "user", prompt: true, text });
  await log.flush();
}

describe("session log: append and read back", () => {
  test("an entry keeps its identity across a reopen", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user = log.append<UserEntry>({ type: "user", prompt: true, text: "bonjour" });
    const phase = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "salut", runId: "r1", reasoning: "je reflechis" });
    await log.flush();

    // The id the caller got back is the id on disk: that is what lets a live bubble and a
    // replayed one be the same bubble, with no sourceId to reconcile.
    const reopened = await openSessionLog(id);
    expect(reopened.entries().map((e) => e.id)).toEqual([user.id, phase.id]);
    expect(reopened.head()).toBe(phase.id);
    expect(reopened.leaf()).toBe(phase.id);
    const stored = reopened.get(phase.id) as PhaseEntry;
    expect(stored.reasoning).toBe("je reflechis");
    expect(stored.parentId).toBe(user.id);
    expect(stored.seq).toBe(1);
  });

  test("every payload type round-trips unchanged", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<ToolEntry>({
      type: "tool", prompt: true, callId: "call-1", name: "bash", args: { command: "ls" },
      output: "a\nb", truncated: false, ok: true, durationMs: 12, runId: "r1",
    });
    log.append({ type: "command", prompt: false, input: "/status", output: "tout va bien" });
    log.append({ type: "failure", prompt: false, error: "boom" });
    log.append({ type: "compaction", prompt: true, summary: "resume", firstKeptEntryId: "x", tokensBefore: 100, count: 4 });
    log.append({ type: "model_change", prompt: false, model: "opus-5" });
    log.append({ type: "note", prompt: false, text: "pour info" });
    await log.flush();

    const reopened = await openSessionLog(id);
    expect(reopened.entries().map((e) => e.type)).toEqual(["tool", "command", "failure", "compaction", "model_change", "note"]);
    const tool = reopened.entries()[0] as ToolEntry;
    expect(tool.args).toEqual({ command: "ls" });
    expect(tool.callId).toBe("call-1");
  });

  test("seq continues where the file left off", async () => {
    const id = freshId();
    await seed(id, ["un", "deux"]);
    const reopened = await openSessionLog(id);
    const next = reopened.append<UserEntry>({ type: "user", prompt: true, text: "trois" });
    expect(next.seq).toBe(2);
    await reopened.flush();
  });
});

describe("session log: damage is bounded to a line", () => {
  test("a half-written last line costs that line and nothing else", async () => {
    const id = freshId();
    await seed(id, ["un", "deux", "trois"]);
    const file = entriesPath(id);
    const raw = await readFile(file, "utf-8");

    // What a process killed mid-append leaves: the last line stops in the middle of the object.
    await truncate(file, raw.length - 20);
    const reopened = await openSessionLog(id);
    expect(reopened.entries()).toHaveLength(2);
    expect((reopened.entries()[1] as UserEntry).text).toBe("deux");

    // And the log keeps working: the next append lands after the survivors.
    const next = reopened.append<UserEntry>({ type: "user", prompt: true, text: "quatre" });
    await reopened.flush();
    expect(next.parentId).toBe(reopened.entries()[1]!.id);
    expect((await openSessionLog(id)).entries()).toHaveLength(3);
  });

  test("a broken line in the middle does not hide the ones after it", async () => {
    const id = freshId();
    const file = entriesPath(id);
    await mkdir(dirname(file), { recursive: true });
    await seed(id, ["un"]);
    await appendFile(file, "{ this is not json\n", "utf-8");
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "trois" });
    await log.flush();

    const reopened = await openSessionLog(id);
    expect(reopened.entries().map((e) => (e as UserEntry).text)).toEqual(["un", "trois"]);
  });

  test("a line that is valid JSON but not an entry is skipped", async () => {
    const id = freshId();
    await seed(id, ["un"]);
    await appendFile(entriesPath(id), `${JSON.stringify({ hello: "world" })}\n`, "utf-8");
    expect((await openSessionLog(id)).entries()).toHaveLength(1);
  });

  test("an entry of an unknown type is kept, not dropped", async () => {
    // Forward compatibility is the whole reason the type is open: an older binary reading a
    // newer file must lose display fidelity, never a turn.
    const id = freshId();
    await seed(id, ["un"]);
    await appendFile(
      entriesPath(id),
      `${JSON.stringify({ id: "future-1", seq: 1, parentId: null, ts: Date.now(), type: "hologram", prompt: false })}\n`,
      "utf-8",
    );
    const reopened = await openSessionLog(id);
    expect(reopened.entries()).toHaveLength(2);
    expect(reopened.entries()[1]!.type as string).toBe("hologram");
  });

  test("a missing file is a new conversation, not an error", async () => {
    const log = await openSessionLog(freshId());
    expect(log.entries()).toHaveLength(0);
    expect(log.head()).toBeNull();
    expect(log.leaf()).toBeNull();
    expect(log.path()).toEqual([]);
  });
});

describe("session log: the branch a leaf ends", () => {
  /** A trunk of two turns, then two branches from the first: the retry shape. */
  async function forked(): Promise<{ log: Awaited<ReturnType<typeof openSessionLog>>; a: Entry; b: Entry; c: Entry }> {
    const log = await openSessionLog(freshId());
    const a = log.append<UserEntry>({ type: "user", prompt: true, text: "question" });
    const b = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "premiere reponse", runId: "r1" });
    log.branch(a.id);
    const c = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "seconde reponse", runId: "r2" });
    await log.flush();
    return { log, a, b, c };
  }

  test("a path walks up parentId and comes back oldest first", async () => {
    const { log, a, c } = await forked();
    expect(log.path().map((e) => e.id)).toEqual([a.id, c.id]);
    await log.flush();
  });

  test("the abandoned branch is still on disk and comes back by switching to it", async () => {
    const { log, a, b, c } = await forked();
    await log.flush();
    // This is what makes a retry non-destructive: the turn that was replaced is not gone, it is
    // beside the new one.
    expect(log.entries()).toHaveLength(3);
    expect(log.path().map((e) => e.id)).toEqual([a.id, c.id]);
    log.branch(b.id);
    expect(log.path().map((e) => e.id)).toEqual([a.id, b.id]);
  });

  test("both tips are listed as leaves, the trunk is not", async () => {
    const { log, a, b, c } = await forked();
    const leaves = leavesOf(log.entries()).map((e) => e.id).sort();
    expect(leaves).toEqual([b.id, c.id].sort());
    expect(leaves).not.toContain(a.id);
    await log.flush();
  });

  test("branching to nothing empties the path without touching the entries", async () => {
    const { log } = await forked();
    log.branch(null);
    expect(log.path()).toEqual([]);
    expect(log.entries()).toHaveLength(3);
    // And the next append starts a root, exactly like a fresh conversation.
    const root = log.append<UserEntry>({ type: "user", prompt: true, text: "on repart" });
    expect(root.parentId).toBeNull();
    await log.flush();
  });

  test("branching to an id the log does not hold is refused", async () => {
    const { log } = await forked();
    expect(() => log.branch("nope")).toThrow(UnknownCursorError);
    await log.flush();
  });

  test("the leaf survives a reopen when it is handed back", async () => {
    const { log, a, b } = await forked();
    log.branch(b.id);
    await log.flush();
    const reopened = await openSessionLog(log.sessionId, b.id);
    expect(reopened.path().map((e) => e.id)).toEqual([a.id, b.id]);
  });

  test("an unknown leaf falls back to the last entry rather than an empty thread", async () => {
    const { log, c } = await forked();
    await log.flush();
    const reopened = await openSessionLog(log.sessionId, "gone");
    expect(reopened.path().map((e) => e.id)).toContain(c.id);
  });

  test("pathOf survives a parent chain that loops", async () => {
    // Not reachable through append, but a hand-edited or half-migrated file must not hang.
    const looped = [
      { id: "x", seq: 0, parentId: "y", ts: 1, type: "user", prompt: true, text: "a" },
      { id: "y", seq: 1, parentId: "x", ts: 2, type: "user", prompt: true, text: "b" },
    ] as unknown as Entry[];
    expect(pathOf(looped, "y").map((e) => e.id)).toEqual(["x", "y"]);
  });
});

describe("session log: the sync cursor", () => {
  test("a cursor at the head has nothing to hand back", async () => {
    const id = freshId();
    await seed(id, ["un", "deux"]);
    const log = await openSessionLog(id);
    expect(log.since(log.head())).toEqual([]);
    await log.flush();
  });

  test("a null cursor is the whole log", async () => {
    const id = freshId();
    await seed(id, ["un", "deux"]);
    const log = await openSessionLog(id);
    expect(log.since(null)).toHaveLength(2);
    await log.flush();
  });

  test("a cursor the log cannot place is refused out loud", async () => {
    const id = freshId();
    await seed(id, ["un"]);
    const log = await openSessionLog(id);
    // Silence here is what lets two windows drift apart with nobody noticing; the client has to
    // be told its delta was refused so it can ask for a full page.
    expect(() => log.since("compacted-away")).toThrow(UnknownCursorError);
    await log.flush();
  });

  test("a delta crosses a branch switch, because the cursor is file order", async () => {
    const log = await openSessionLog(freshId());
    const a = log.append<UserEntry>({ type: "user", prompt: true, text: "question" });
    const b = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "reponse", runId: "r1" });
    // A client that has seen everything up to `b` now watches a retry happen.
    log.branch(a.id);
    const c = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "autre reponse", runId: "r2" });
    await log.flush();

    // The entry written on the other branch still reaches it as an ordinary delta: what changed
    // is the leaf, which travels beside the entries rather than inside them.
    expect(log.since(b.id).map((e) => e.id)).toEqual([c.id]);
    expect(log.leaf()).toBe(c.id);
  });
});

describe("session log: ids", () => {
  test("ids sort by creation time", () => {
    const early = newEntryId(1_000_000_000_000);
    const late = newEntryId(1_900_000_000_000);
    expect(early < late).toBe(true);
  });

  test("ids minted in the same millisecond are still distinct", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 200 }, () => newEntryId(now)));
    expect(ids.size).toBe(200);
  });

  test("the shape is a v7 uuid", () => {
    expect(newEntryId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("session log: what it costs", () => {
  test("an append stays flat on a long conversation", async () => {
    // The measured reason for this whole format: the JSON store rewrote 12 MB on every autosave
    // tick, 41 ms of it synchronous. This test fails if an append ever grows with the history.
    const id = freshId();
    const log = await openSessionLog(id);
    for (let i = 0; i < 4000; i++) {
      log.append<ToolEntry>({
        type: "tool", prompt: true, callId: `c${i}`, name: "bash", args: { command: "x" },
        output: "y".repeat(500), truncated: false, ok: true, runId: "r1",
      });
    }
    await log.flush();

    const started = performance.now();
    log.append<UserEntry>({ type: "user", prompt: true, text: "encore" });
    const elapsed = performance.now() - started;
    await log.flush();
    expect(elapsed).toBeLessThan(5);
    expect(log.entries()).toHaveLength(4001);
  });

  test("appends queued together all land, in order", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ids = Array.from({ length: 50 }, (_, i) => log.append<UserEntry>({ type: "user", prompt: true, text: `m${i}` }).id);
    await log.flush();
    expect((await openSessionLog(id)).entries().map((e) => e.id)).toEqual(ids);
  });
});

describe("session log: paths", () => {
  test("a session id cannot climb out of the sessions directory", async () => {
    const file = entriesPath("../../escape");
    expect(file).not.toContain("..");
    // And the write still lands somewhere legal.
    const log = await openSessionLog("../../escape");
    log.append<UserEntry>({ type: "user", prompt: true, text: "hop" });
    await log.flush();
    expect((await readFile(file, "utf-8")).length).toBeGreaterThan(0);
    await writeFile(file, "", "utf-8");
  });
});

describe("session log: appendAll", () => {
  test("the chain is handed over before a byte is written", async () => {
    // The one moment a cross-reference can be resolved: an entry that must name another cannot be
    // written until that id exists, and no entry is ever rewritten.
    const log = await openSessionLog(freshId());
    let seenIds: string[] = [];
    const written = log.appendAll(
      [
        { type: "user", prompt: true, text: "un" },
        { type: "user", prompt: true, text: "deux" },
      ],
      (entries) => {
        seenIds = entries.map((e) => e.id);
        (entries[0] as { text: string }).text = `pointe vers ${entries[1]!.id}`;
      },
    );
    await log.flush();
    expect(seenIds).toEqual(written.map((e) => e.id));
    expect((written[0] as { text: string }).text).toBe(`pointe vers ${written[1]!.id}`);
  });

  test("what the patch changed is what reaches the disk", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.appendAll([{ type: "user", prompt: true, text: "avant" }], (entries) => {
      (entries[0] as { text: string }).text = "apres";
    });
    await log.flush();
    expect((await openSessionLog(id)).entries().map((e) => (e as { text: string }).text)).toEqual(["apres"]);
  });

  test("the batch chains onto what is already there and moves the leaf", async () => {
    const log = await openSessionLog(freshId());
    const first = log.append<UserEntry>({ type: "user", prompt: true, text: "avant" });
    const batch = log.appendAll([{ type: "user", prompt: true, text: "un" }, { type: "user", prompt: true, text: "deux" }]);
    await log.flush();
    expect(batch[0]!.parentId).toBe(first.id);
    expect(batch[1]!.parentId).toBe(batch[0]!.id);
    expect(log.leaf()).toBe(batch[1]!.id);
    expect(log.path()).toHaveLength(3);
  });

  test("an input keeps its own timestamp, and its id encodes it", async () => {
    // A conversation from last month must keep last month's dates, and an id sorts by the time it
    // encodes -- built from the migration's clock, an imported session would sort as brand new.
    const log = await openSessionLog(freshId());
    const ts = Date.parse("2025-01-02T03:04:05.678Z");
    const [entry] = log.appendAll([{ type: "user", prompt: true, text: "vieux", ts }]);
    await log.flush();
    expect(entry!.ts).toBe(ts);
    expect(parseInt(entry!.id.slice(0, 8) + entry!.id.slice(9, 13), 16)).toBe(ts);
  });

  test("an empty batch writes nothing and leaves the leaf alone", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const first = log.append<UserEntry>({ type: "user", prompt: true, text: "seul" });
    expect(log.appendAll([])).toEqual([]);
    await log.flush();
    expect(log.leaf()).toBe(first.id);
    expect((await openSessionLog(id)).entries()).toHaveLength(1);
  });

  test("seq stays dense across a batch, so a cursor keeps working", async () => {
    const log = await openSessionLog(freshId());
    log.append<UserEntry>({ type: "user", prompt: true, text: "a" });
    log.appendAll([{ type: "user", prompt: true, text: "b" }, { type: "user", prompt: true, text: "c" }]);
    log.append<UserEntry>({ type: "user", prompt: true, text: "d" });
    await log.flush();
    expect(log.entries().map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });
});
