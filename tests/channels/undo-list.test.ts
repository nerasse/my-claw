import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listUndoTurns, renderUndoTurns, UNDO_LIST_DEFAULT, UNDO_LIST_MAX } from "../../src/channels/branch-commands.ts";
import { openSessionLog, type SessionLog } from "../../src/sessions/log.ts";
import { recordRunStart } from "../../src/snapshots/store.ts";

let ws: string;
let log: SessionLog;
const SID = "test-undo-list";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "undo-list-"));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** A conversation of `n` user turns, each with one run. */
async function conversation(n: number, withSnapshots: number[] = []): Promise<SessionLog> {
  const log = await openSessionLog(SID);
  for (let i = 1; i <= n; i++) {
    log.append({ type: "user", prompt: true, text: `message ${i}` });
    log.append({ type: "run_start", prompt: false, runId: `r${i}` });
    log.append({ type: "phase", prompt: true, text: `answer ${i}`, runId: `r${i}` });
    log.append({ type: "run_end", prompt: false, reason: "done" });
  }
  await log.flush();
  for (const i of withSnapshots) await recordRunStart(SID, ws, `r${i}`);
  return log;
}

test("the list is newest first, and n counts from the end", async () => {
  log = await conversation(5);
  const rows = await listUndoTurns({ sessionId: SID, log }, 3);
  expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
  expect(rows.map((r) => r.preview)).toEqual(["message 5", "message 4", "message 3"]);
});

test("hard is true exactly where a snapshot still exists", async () => {
  log = await conversation(5, [5, 4]);
  const rows = await listUndoTurns({ sessionId: SID, log }, 5);
  expect(rows.map((r) => [r.n, r.hard])).toEqual([[1, true], [2, true], [3, false], [4, false], [5, false]]);
});

test("a long message is one clipped line, never the body", async () => {
  log = await openSessionLog(SID);
  log.append({ type: "user", prompt: true, text: "a".repeat(500) + "\nsecond line" });
  await log.flush();
  const rows = await listUndoTurns({ sessionId: SID, log }, 1);
  expect(rows[0]!.preview.length).toBeLessThanOrEqual(73);
  expect(rows[0]!.preview).not.toContain("\n");
});

test("attachments and voice notes are counted, not inlined", async () => {
  log = await openSessionLog(SID);
  log.append({
    type: "user",
    prompt: true,
    text: "regarde",
    attachments: [
      { type: "image", path: "/a.png" },
      { type: "image", path: "/b.png" },
    ],
    transcripts: { "/c.wav": "ce que j'ai dit" },
  });
  await log.flush();
  const rows = await listUndoTurns({ sessionId: SID, log }, 1);
  expect(rows[0]!.attachments).toBe(2);
  expect(rows[0]!.transcripts).toBe(1);
  const text = renderUndoTurns(rows);
  expect(text).toContain("2 fichiers");
  expect(text).toContain("1 vocal");
  expect(text).not.toContain("ce que j'ai dit");
});

test("the limit is bounded, and the default is the documented one", async () => {
  log = await conversation(UNDO_LIST_MAX + 20);
  expect((await listUndoTurns({ sessionId: SID, log }, 5)).length).toBe(5);
  expect(UNDO_LIST_DEFAULT).toBe(10);
  expect(UNDO_LIST_MAX).toBe(100);
});

test("an empty conversation says so rather than answering a blank list", async () => {
  log = await openSessionLog(SID);
  const rows = await listUndoTurns({ sessionId: SID, log }, 10);
  expect(rows).toEqual([]);
  expect(renderUndoTurns(rows)).toContain("Rien à annuler");
});
