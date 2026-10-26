import { describe, expect, test } from "bun:test";
import { runReasoningSink } from "../run-sink.ts";
import { MyClawAppStreamer } from "../stream.ts";
import type { MyClawAppServerFrame } from "../types.ts";

/**
 * What the app draws of a run's own thinking.
 *
 * The wait before a call's first token went through a global hook first: a message folded into a
 * run in flight has a sink too, both heard the hook, and every call after it opened two bubbles
 * (2026-10-01). The sink is per run, and read through the streamer that is open now.
 */
function streamerFor(frames: MyClawAppServerFrame[]): MyClawAppStreamer {
  return new MyClawAppStreamer({
    id: "run-bubble",
    threadId: "run-thread",
    send: (frame) => {
      frames.push(frame);
    },
  });
}

function types(frames: MyClawAppServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

describe("a run's reasoning sink", () => {
  test("carries the thinking, the count, and the wait before a call", async () => {
    const frames: MyClawAppServerFrame[] = [];
    const streamer = streamerFor(frames);
    const sink = runReasoningSink(() => streamer);
    await sink.onCallStart!();
    await sink.onText!("weighing");
    await sink.onCount!({ tokens: 120 });
    expect(types(frames)).toEqual([
      "chat.stream.start",
      "chat.turn.thinking",
      "chat.reasoning.delta",
      "chat.reasoning.tokens",
    ]);
  });

  test("follows the streamer that is open now: a folded message swaps it mid-run", async () => {
    const first: MyClawAppServerFrame[] = [];
    const second: MyClawAppServerFrame[] = [];
    let current = streamerFor(first);
    const sink = runReasoningSink(() => current);
    await sink.onCallStart!();
    current = streamerFor(second);
    await sink.onCallStart!();
    expect(types(first)).toEqual(["chat.stream.start", "chat.turn.thinking"]);
    expect(types(second)).toEqual(["chat.stream.start", "chat.turn.thinking"]);
  });
});
