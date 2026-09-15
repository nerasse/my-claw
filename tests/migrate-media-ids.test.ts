/**
 * The media-id sweep -- docs/attachments.md.
 *
 * A marker written before the ids existed named its pictures by path, and a device fetches an id.
 * The pass pairs them once, at boot, and this is what proves the pairing: the copy a marker wants,
 * the files it must not touch, and the hole it must admit when a picture was never stored.
 */

import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../src/core/config.ts";
import { ENTRIES_FILE, sessionDir, type Entry } from "../src/sessions/log.ts";
import { FILES_DIR, migrateMediaIdsForSession } from "../src/sessions/migrate-media-ids.ts";
import { randomUUID } from "node:crypto";

const OWNER = "neras";
const THREAD = "thread-1";

function line(entry: Record<string, unknown>): string {
  return JSON.stringify({ prompt: false, parentId: null, ...entry });
}

async function writeLog(sessionId: string, entries: Array<Record<string, unknown>>): Promise<string> {
  const dir = sessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, ENTRIES_FILE);
  await writeFile(file, `${entries.map(line).join("\n")}\n`);
  return file;
}

/** A copy as the store writes it: `<id>__<name>`, with a mtime of its own. */
async function storeCopy(threadId: string, name: string, secondsAgo: number): Promise<string> {
  const dir = join(FILES_DIR, OWNER, threadId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const path = join(dir, `${id}__${name}`);
  await writeFile(path, "png");
  const when = new Date(Date.now() - secondsAgo * 1000);
  await utimes(path, when, when);
  return id;
}

describe("migrateMediaIdsForSession", () => {
  const sessionId = `my-claw-app/thread/${OWNER}/${THREAD}`;
  const runTs = Date.now();

  beforeEach(async () => {
    await mkdir(join(MY_CLAW_DIR, "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(join(MY_CLAW_DIR, "sessions", sessionId.split("/")[0]!), { recursive: true, force: true });
    await rm(join(FILES_DIR, OWNER), { recursive: true, force: true });
  });

  test("a marker gets the id of the copy written when the run ended", async () => {
    // Two runs generated a file of the same name; the one this marker wants is the one written
    // around the moment it ended, not simply the newest in the tree.
    const near = await storeCopy(THREAD, "shot.png", 2);
    await storeCopy(THREAD, "shot.png", 4000);
    const file = await writeLog(sessionId, [
      { type: "user", id: "u1", ts: runTs - 5000 },
      { type: "run_start", id: "s1", ts: runTs - 4000 },
      { type: "phase", id: "p1", ts: runTs - 3000, text: "" },
      { type: "run_end", id: "e1", ts: runTs, reason: "done", media: ["/tmp/shot.png"] },
    ]);

    const report = await migrateMediaIdsForSession(sessionId, { own: [join(FILES_DIR, OWNER, THREAD)], fallback: [] });
    assert.equal(report?.markers, 1);
    assert.equal(report?.paired, 1);
    assert.equal(report?.holes, 0);
    assert.ok(report?.backup, "the original is copied beside the file before a byte changes");

    const entries = (await readFile(file, "utf-8")).trim().split("\n").map((l) => JSON.parse(l) as Entry);
    const end = entries.find((entry) => entry.type === "run_end");
    assert.deepEqual(end && end.type === "run_end" ? end.mediaIds : null, [near]);
    // Everything else about the entry is untouched: a client's cursor arithmetic reads these.
    assert.equal(end?.id, "e1");
    assert.deepEqual(entries.map((e) => e.id), ["u1", "s1", "p1", "e1"]);
  });

  test("a picture the store never received is a hole, named", async () => {
    const file = await writeLog(sessionId, [
      { type: "run_end", id: "e1", ts: runTs, reason: "done", media: ["/tmp/lost.png"] },
    ]);
    const report = await migrateMediaIdsForSession(sessionId, { own: [join(FILES_DIR, OWNER, THREAD)], fallback: [] });
    assert.equal(report?.holes, 1);
    assert.deepEqual(report?.missing, ["lost.png"]);
    const end = JSON.parse((await readFile(file, "utf-8")).trim()) as Entry;
    assert.deepEqual(end.type === "run_end" ? end.mediaIds : undefined, [null]);
  });

  test("a sub-agent's marker resolves from its parent's thread", async () => {
    // The case that made this pass worth writing: a sub-agent's run stores nothing of its own --
    // its pictures were copied into the thread of the run that asked for it.
    const parentCopy = await storeCopy(THREAD, "browser-shot.png", 1);
    await writeLog("subagent/run-abc", [
      { type: "run_end", id: "e1", ts: runTs, reason: "done", media: ["/tmp/browser-shot.png"] },
    ]);
    const report = await migrateMediaIdsForSession("subagent/run-abc", {
      own: [],
      fallback: [join(FILES_DIR, OWNER, THREAD)],
    });
    assert.equal(report?.paired, 1);
  });

  test("nothing to pair rewrites nothing, and a second pass finds nothing", async () => {
    await storeCopy(THREAD, "shot.png", 0);
    const file = await writeLog(sessionId, [
      { type: "run_end", id: "e1", ts: runTs, reason: "done", media: ["/tmp/shot.png"] },
    ]);
    assert.ok(await migrateMediaIdsForSession(sessionId, { own: [join(FILES_DIR, OWNER, THREAD)], fallback: [] }));
    const backupsAfterFirst = (await readdir(sessionDir(sessionId))).filter((n) => n.includes(".bak")).length;

    const before = await readFile(file, "utf-8");
    assert.equal(
      await migrateMediaIdsForSession(sessionId, { own: [join(FILES_DIR, OWNER, THREAD)], fallback: [] }),
      null,
    );
    assert.equal(await readFile(file, "utf-8"), before, "an already-paired file is not rewritten");
    assert.equal((await readdir(sessionDir(sessionId))).filter((n) => n.includes(".bak")).length, backupsAfterFirst);
  });

  test("a line that does not parse keeps its bytes", async () => {
    // The pass adds a field; it is not a repair. A stump another version wrote is left for the
    // code that knows how to read it.
    const file = await writeLog(sessionId, []);
    await writeFile(
      file,
      `${line({ type: "run_end", id: "e1", ts: runTs, reason: "done", media: ["/tmp/shot.png"] })}\n{"type":"phase","id"\n`,
    );
    await storeCopy(THREAD, "shot.png", 0);
    await migrateMediaIdsForSession(sessionId, { own: [join(FILES_DIR, OWNER, THREAD)], fallback: [] });
    const lines = (await readFile(file, "utf-8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '{"type":"phase","id"');
  });
});
