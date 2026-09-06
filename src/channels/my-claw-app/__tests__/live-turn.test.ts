import { describe, expect, test } from "bun:test";
import { LiveTurnJournal } from "../live-turn.ts";
import type { MyClawAppServerFrame } from "../types.ts";

const OWNER = "owner-1";
const THREAD = "thread-1";

function streamStart(id: string): MyClawAppServerFrame {
  return { type: "chat.stream.start", id, threadId: THREAD };
}

function delta(id: string, text: string): MyClawAppServerFrame {
  return { type: "chat.stream.delta", id, threadId: THREAD, text };
}

function toolStart(id: string): MyClawAppServerFrame {
  return { type: "chat.tool.start", id, threadId: THREAD, turnId: "turn-1", name: "bash", args: { command: "ls" }, ts: "2026-01-01T00:00:00.000Z" };
}

function toolDelta(id: string, stdout: string): MyClawAppServerFrame {
  return { type: "chat.tool.delta", id, threadId: THREAD, turnId: "turn-1", stdout, stderr: "", ts: "2026-01-01T00:00:00.000Z" };
}

function toolSettled(id: string): MyClawAppServerFrame {
  return { type: "chat.tool", id, threadId: THREAD, turnId: "turn-1", name: "bash", args: { command: "ls" }, ok: true, output: "done", truncated: false, ts: "2026-01-01T00:00:01.000Z" };
}

function types(frames: MyClawAppServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

describe("live turn journal", () => {
  test("replays the bubble being written into, so a reload mid-answer is not a hole", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    live.record(OWNER, THREAD, streamStart("s1"));
    live.record(OWNER, THREAD, delta("s1", "Bon"));
    live.record(OWNER, THREAD, delta("s1", "jour"));

    // One delta, not two. The window asking for this is usually the one that was already
    // watching: it still holds the bubble, `chat.stream.start` on a known id is a no-op, and
    // replaying the chunks made it append the answer to itself. `replay` says the text is whole
    // so the client replaces -- and a window that never saw the run gets the same result, since
    // replacing an empty bubble is setting it.
    const replay = live.replay(OWNER, THREAD);
    expect(types(replay)).toEqual(["chat.stream.start", "chat.stream.delta"]);
    expect(replay.map((frame) => ("text" in frame ? frame.text : "")).join("")).toBe("Bonjour");
    expect(replay.some((frame) => "replay" in frame && frame.replay === true)).toBe(true);
  });

  test("coalesces each subject on its own, at the place its first chunk held", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    live.record(OWNER, THREAD, streamStart("s1"));
    live.record(OWNER, THREAD, delta("s1", "avant "));
    live.record(OWNER, THREAD, streamStart("s2"));
    live.record(OWNER, THREAD, delta("s2", "autre "));
    live.record(OWNER, THREAD, delta("s1", "apres"));
    live.record(OWNER, THREAD, delta("s2", "bulle"));

    // Order is the turn's order, so the merged delta sits where the first chunk was rather than
    // at the end: a bubble must not jump over the one that followed it.
    const replay = live.replay(OWNER, THREAD);
    expect(types(replay)).toEqual([
      "chat.stream.start",
      "chat.stream.delta",
      "chat.stream.start",
      "chat.stream.delta",
    ]);
    expect(replay.map((frame) => ("text" in frame ? frame.text : ""))).toEqual([
      "",
      "avant apres",
      "",
      "autre bulle",
    ]);
  });

  test("forgets a bubble the moment it closes: the session serves it from there", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    live.record(OWNER, THREAD, streamStart("s1"));
    live.record(OWNER, THREAD, delta("s1", "premier tour"));
    live.record(OWNER, THREAD, { type: "chat.stream.done", id: "s1", threadId: THREAD });
    live.record(OWNER, THREAD, streamStart("s2"));
    live.record(OWNER, THREAD, delta("s2", "en cours"));

    // A phase entry and its live bubble do not share an id, so replaying a closed bubble beside
    // the delta that already carries it would print the run's prose twice, permanently.
    const replay = live.replay(OWNER, THREAD);
    expect(replay.every((frame) => !("id" in frame) || frame.id === "s2")).toBe(true);
  });

  test("replays a running tool card, and forgets it when it settles", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    live.record(OWNER, THREAD, toolStart("t1"));
    live.record(OWNER, THREAD, toolDelta("t1", "line\n"));
    expect(types(live.replay(OWNER, THREAD))).toEqual(["chat.tool.start", "chat.tool.delta"]);

    live.record(OWNER, THREAD, toolSettled("t1"));
    expect(live.replay(OWNER, THREAD)).toEqual([]);
  });

  test("caps live output and says so, instead of replaying a card that reads complete", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    live.record(OWNER, THREAD, toolStart("t1"));
    // A bash printing megabytes: the journal is memory, and the budget is what bounds it.
    for (let i = 0; i < 40; i += 1) live.record(OWNER, THREAD, toolDelta("t1", "x".repeat(16 * 1024)));

    const replay = live.replay(OWNER, THREAD);
    const output = replay.filter((frame) => frame.type === "chat.tool.delta");
    expect(output.length).toBeLessThan(40);
    // Flagged, so the card shows the cap and can ask for the rest once the call settles. A card
    // silently missing its head would read as a complete, short output.
    expect(output.every((frame) => frame.type === "chat.tool.delta" && frame.clipped === true)).toBe(true);
  });

  test("replays a pending approval, which is otherwise asked once and lost", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    const request: MyClawAppServerFrame = {
      type: "approval.request",
      id: "a1",
      threadId: THREAD,
      toolName: "bash",
      args: { command: "rm -rf /" },
      expiresAt: Date.now() + 60_000,
      allowSessionOffered: true,
    };
    live.recordApproval(OWNER, THREAD, "a1", request);
    live.record(OWNER, THREAD, streamStart("s1"));

    // Last: the sheet belongs on top of the thread it interrupted.
    expect(types(live.replay(OWNER, THREAD))).toEqual(["chat.stream.start", "approval.request"]);

    // Answered: asking again would be a question with no answer left.
    live.resolveApproval(OWNER, THREAD, "a1");
    expect(types(live.replay(OWNER, THREAD))).toEqual(["chat.stream.start"]);
  });

  test("holds nothing for a thread with no run in flight", () => {
    const live = new LiveTurnJournal();
    // No open journal: a frame arriving outside a run has nowhere to go, and must not create one.
    live.record(OWNER, THREAD, streamStart("s1"));
    expect(live.replay(OWNER, THREAD)).toEqual([]);

    live.open(OWNER, THREAD);
    live.record(OWNER, THREAD, streamStart("s1"));
    expect(live.size(OWNER, THREAD)).toBe(1);

    // The run ended: the session owns the turn now, and a journal past the end is a second writer.
    live.close(OWNER, THREAD);
    expect(live.replay(OWNER, THREAD)).toEqual([]);
  });

  test("keeps one thread's turn out of another's", () => {
    const live = new LiveTurnJournal();
    live.open(OWNER, THREAD);
    live.open(OWNER, "thread-2");
    live.record(OWNER, THREAD, streamStart("s1"));
    expect(live.size(OWNER, "thread-2")).toBe(0);
    expect(live.size("owner-2", THREAD)).toBe(0);
  });
});
