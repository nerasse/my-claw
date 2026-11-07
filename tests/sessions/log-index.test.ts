/**
 * The byte map beside a session log -- docs/session-index.md.
 *
 * What is proven here is the pair of promises the whole change stands on: the index never disagrees
 * with the log (it is derived and repaired), and reading through it never turns into reading the
 * log.
 */

import { describe, expect, test } from "bun:test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  entriesPath,
  openSessionLog,
  sessionDir,
  type CompactionEntry,
  type PhaseEntry,
  type UserEntry,
} from "../../src/sessions/log.ts";
import { INDEX_FILE, RECORD_BYTES } from "../../src/sessions/log-index.ts";
import { promptOf } from "../../src/sessions/projection.ts";

let counter = 0;
const freshId = (): string => `test-index-${process.pid}-${counter++}`;

function seed(id: string, texts: string[]): Promise<UserEntry[]> {
  return openSessionLog(id).then(async (log) => {
    const written = texts.map((text) => log.append<UserEntry>({ type: "user", prompt: true, text }));
    await log.flush();
    return written;
  });
}

describe("session index", () => {
  test("an index is built on the first open and reused by the next one", async () => {
    const id = freshId();
    await seed(id, ["un", "deux"]);
    await rm(join(sessionDir(id), INDEX_FILE), { force: true });

    const first = await openSessionLog(id);
    expect(first.count()).toBe(2);
    const bytes = (await readFile(join(sessionDir(id), INDEX_FILE))).length;
    expect(bytes).toBe(2 * RECORD_BYTES);

    // A second open reads those records rather than the log: same entries, same leaf.
    const second = await openSessionLog(id);
    expect(second.count()).toBe(2);
    expect(second.pathRecords().map((record) => record.id)).toEqual(first.pathRecords().map((record) => record.id));
    expect(second.isMaterialized()).toBe(false);
  });

  test("a parent is a position, so the branch walk never reads an entry", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const a = log.append<UserEntry>({ type: "user", prompt: true, text: "question" });
    const b = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "reponse", runId: "r1" });
    await log.flush();

    const reopened = await openSessionLog(id);
    const path = reopened.pathRecords();
    expect(path.map((record) => record.id)).toEqual([a.id, b.id]);
    expect(path[1]!.parent).toBe(0);
    expect(path[0]!.parent).toBe(0xffffffff);
    expect(reopened.isMaterialized()).toBe(false);
  });

  test("an index pointing past the end of the log is dropped, and the tail rescanned", async () => {
    const id = freshId();
    await seed(id, ["un", "deux", "trois"]);

    // Half the index, as a write that reached the index and never the log would leave it.
    const indexPath = join(sessionDir(id), INDEX_FILE);
    const whole = await readFile(indexPath);
    await writeFile(indexPath, whole.subarray(0, RECORD_BYTES));

    const log = await openSessionLog(id);
    expect(log.count()).toBe(3);
  });

  test("a log written by another handle is picked up before a prompt is built", async () => {
    // Two handles on one session is not production's shape (the manager holds one), but it is a
    // test's, and a prompt that missed the turn just written would be answered on stale words.
    const id = freshId();
    const writer = await openSessionLog(id);
    const first = writer.append<UserEntry>({ type: "user", prompt: true, text: "un" });
    await writer.flush();

    const reader = await openSessionLog(id);
    expect(reader.count()).toBe(1);

    writer.append<UserEntry>({ type: "user", prompt: true, text: "deux" });
    await writer.flush();

    const context = await reader.context();
    expect(context.map((entry) => (entry.type === "user" ? entry.text : entry.type))).toEqual(["un", "deux"]);
    expect(reader.leaf()).not.toBe(first.id);
  });

  test("a context stops at the newest compaction boundary, and reads nothing above it", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "vieux" });
    const kept = log.append<UserEntry>({ type: "user", prompt: true, text: "garde" });
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "resume",
      firstKeptEntryId: kept.id,
      tokensBefore: 10,
      count: 1,
    });
    log.append<UserEntry>({ type: "user", prompt: true, text: "apres" });
    await log.flush();

    const reopened = await openSessionLog(id);
    const context = await reopened.context();
    // The slice is the floor downwards; the prompt is what puts the boundary in front of it.
    expect(context.map((entry) => (entry.type === "user" ? entry.text : entry.type))).toEqual(["garde", "compaction", "apres"]);
    const prompt = promptOf(context, reopened.leaf());
    // The boundary travels as the wrapped summary turn the model reads, then the kept tail.
    expect(prompt).toHaveLength(3);
    expect(String(prompt[0]!.content)).toContain("resume");
    expect(String(prompt[1]!.content)).toBe("garde");
    expect(String(prompt[2]!.content)).toBe("apres");
    // The branch is still every entry: only the prompt is bounded.
    expect(reopened.count()).toBe(4);
  });

  test("a malformed last line costs that line, and the index follows the truncation", async () => {
    const id = freshId();
    await seed(id, ["un", "deux"]);
    await appendFile(entriesPath(id), '{"type":"user","prompt":true,"text":"troi', "utf-8");

    const log = await openSessionLog(id);
    expect(log.count()).toBe(2);
    expect(await log.entriesIn(log.pathRecords())).toHaveLength(2);
  });

  test("ids that are not UUIDs are looked up exactly, never approximately", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "court" }, "m-court");
    log.append<UserEntry>({ type: "user", prompt: true, text: "long" }, "m-long");
    await log.flush();

    const reopened = await openSessionLog(id);
    expect(reopened.recordOf("m-court")?.index).toBe(0);
    expect(reopened.recordOf("m-long")?.index).toBe(1);
    expect(reopened.recordOf("m-cour")).toBeUndefined();
    expect((await reopened.entryById("m-long"))?.type).toBe("user");
  });

  test("the index does not make history read the whole log", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    for (let i = 0; i < 2000; i++) {
      log.append<UserEntry>({ type: "user", prompt: true, text: `tour ${i} ${"remplissage ".repeat(20)}` });
    }
    await log.flush();

    const reopened = await openSessionLog(id);
    const path = reopened.pathRecords();
    const page = path.slice(-50);
    const entries = await reopened.entriesIn(page);
    expect(entries).toHaveLength(50);
    expect(reopened.isMaterialized()).toBe(false);
  });
});
