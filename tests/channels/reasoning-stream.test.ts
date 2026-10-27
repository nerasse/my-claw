import { describe, expect, test } from "bun:test";
import { MyClawAppStreamer } from "../../src/channels/my-claw-app/stream.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";

function collect(minCharsBeforeDelta?: number) {
  const frames: MyClawAppServerFrame[] = [];
  const streamer = new MyClawAppStreamer({
    id: "s1",
    threadId: "t1",
    ...(minCharsBeforeDelta === undefined ? {} : { minCharsBeforeDelta }),
    send: (frame) => {
      frames.push(frame);
    },
  });
  return { streamer, frames };
}

/**
 * The id of the nth bubble, read off the stream rather than guessed. A bubble id used to be
 * derived from the run's (`s1#1`); it is now minted per bubble, because the phase the log keeps of
 * that bubble is appended under it -- docs/bubble-identity.md.
 */
function bubbleId(frames: MyClawAppServerFrame[], index: number): string {
  const starts = frames.filter((f): f is MyClawAppServerFrame & { type: "chat.stream.start"; id: string } => f.type === "chat.stream.start");
  const start = starts[index];
  if (!start) throw new Error(`no bubble ${index} in ${starts.length} started`);
  return start.id;
}

function types(frames: MyClawAppServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

function reasoningOf(frames: MyClawAppServerFrame[], id = "s1"): string {
  return frames
    .filter((f): f is MyClawAppServerFrame & { type: "chat.reasoning.delta"; text: string; id: string } => f.type === "chat.reasoning.delta")
    .filter((f) => f.id === id)
    .map((f) => f.text)
    .join("");
}

function textOf(frames: MyClawAppServerFrame[], id = "s1"): string {
  return frames
    .filter((f): f is MyClawAppServerFrame & { type: "chat.stream.delta"; text: string; id: string } => f.type === "chat.stream.delta")
    .filter((f) => f.id === id)
    .map((f) => f.text)
    .join("");
}

describe("reasoning opens the bubble", () => {
  // The thinking phase is exactly the silence the owner stares at, so the bubble has to exist
  // before the first word of the answer. See docs/reasoning-visibility.md.
  test("a reasoning delta with no text yet starts the stream", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("weighing options");
    expect(types(frames)).toEqual(["chat.stream.start", "chat.reasoning.delta"]);
  });

  test("the bubble is opened once, not per delta", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("a");
    await streamer.pushReasoning("b");
    await streamer.push("answer");
    expect(types(frames).filter((t) => t === "chat.stream.start")).toHaveLength(1);
    expect(reasoningOf(frames)).toBe("ab");
  });

  test("a count alone opens the bubble, for a call that thought and kept the words", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoningCount({ tokens: 512, ms: 9_000 });
    expect(types(frames)).toEqual(["chat.stream.start", "chat.reasoning.tokens"]);
    const frame = frames[1] as MyClawAppServerFrame & { type: "chat.reasoning.tokens"; tokens: number; ms?: number };
    expect(frame.tokens).toBe(512);
    expect(frame.ms).toBe(9_000);
  });

  test("a zero or negative count is not sent at all", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoningCount({ tokens: 0 });
    await streamer.pushReasoningCount({ tokens: -3 });
    expect(frames).toHaveLength(0);
  });

  test("a span of nothing is not sent beside a count", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoningCount({ tokens: 12, ms: 0 });
    expect(frames[1]).not.toHaveProperty("ms");
  });

  test("minCharsBeforeDelta never withholds reasoning", async () => {
    const { streamer, frames } = collect(50);
    await streamer.pushReasoning("thinking hard");
    expect(reasoningOf(frames)).toBe("thinking hard");
  });

  test("short text alone still opens nothing, so the threshold keeps its job", async () => {
    const { streamer, frames } = collect(50);
    await streamer.push("short");
    expect(frames).toHaveLength(0);
  });

  test("once reasoning opened the bubble, short text is no longer withheld", async () => {
    // The threshold gates the *opening* of the bubble ("the full text length at which the first
    // delta is pushed"), not throughput. Once the bubble is on screen there is nothing left to
    // protect, so withholding the answer would only delay it.
    const { streamer, frames } = collect(50);
    await streamer.pushReasoning("thinking hard");
    await streamer.push("short");
    expect(types(frames)).toContain("chat.stream.delta");
  });
});

describe("reasoning belongs to its segment", () => {
  test("a tool seals the bubble and the next thought lands on the next one", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("first thought");
    await streamer.push("before tool");
    await streamer.appendToolUse([{ name: "bash", arguments: {}, output: "ok", ok: true }], true);
    await streamer.pushReasoning("second thought");
    await streamer.push("after tool");
    await streamer.finish();

    expect(reasoningOf(frames, bubbleId(frames, 0))).toBe("first thought");
    expect(reasoningOf(frames, bubbleId(frames, 1))).toBe("second thought");
  });

  // Reported from the app: a second thinking phase rendered above the answer already on screen,
  // and the words that came after it continued that same bubble.
  test("thinking that follows an answer seals it and opens the next bubble", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("first thought");
    await streamer.push("first answer");
    await streamer.pushReasoning("second thought");
    await streamer.push("second answer");
    await streamer.finish();

    expect(reasoningOf(frames, bubbleId(frames, 0))).toBe("first thought");
    expect(reasoningOf(frames, bubbleId(frames, 1))).toBe("second thought");
    expect(textOf(frames, bubbleId(frames, 0))).toBe("first answer");
    expect(textOf(frames, bubbleId(frames, 1))).toBe("second answer");
    // The first bubble closes before the second opens, so the app renders them in order.
    expect(types(frames).filter((t) => t === "chat.stream.start")).toHaveLength(2);
    expect(types(frames).indexOf("chat.stream.done")).toBeLessThan(types(frames).lastIndexOf("chat.stream.start"));
  });

  // The count only exists once the call has answered, so it always arrives after the words. Sealing
  // on it, the way a thought sealing an answer does, gave it a bubble of its own under the reply.
  test("a count after an answer lands on that answer's bubble, without sealing it", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("weighing");
    await streamer.push("the answer");
    await streamer.pushReasoningCount({ tokens: 512 });
    await streamer.finish();

    expect(types(frames).filter((t) => t === "chat.stream.start")).toHaveLength(1);
    const tokens = frames.find((f) => f.type === "chat.reasoning.tokens");
    expect(tokens && "id" in tokens ? tokens.id : undefined).toBe(bubbleId(frames, 0));
    expect(types(frames).at(-1)).toBe("chat.stream.done");
  });

  test("a call that thought silently and went to a tool keeps its bubble, the count in it", async () => {
    const { streamer, frames } = collect();
    await streamer.beginWait();
    await streamer.pushReasoningCount({ tokens: 516, ms: 4_200 });
    await streamer.appendToolStart([{ id: "call_1", name: "read", arguments: { path: "/x" } }]);

    const tokens = frames.find((f) => f.type === "chat.reasoning.tokens");
    expect(tokens && "id" in tokens ? tokens.id : undefined).toBe(bubbleId(frames, 0));
    // The bubble is closed before the card opens, so the count reads above the tool it led to.
    const order = types(frames);
    expect(order.indexOf("chat.reasoning.tokens")).toBeLessThan(order.indexOf("chat.tool.start"));
  });

  test("the next call's count goes to the next call's bubble", async () => {
    const { streamer, frames } = collect();
    await streamer.beginWait();
    await streamer.push("first answer");
    await streamer.pushReasoningCount({ tokens: 10 });
    await streamer.beginWait();
    await streamer.pushReasoningCount({ tokens: 20 });

    const counts = frames.filter(
      (f): f is MyClawAppServerFrame & { type: "chat.reasoning.tokens"; id: string; tokens: number } => f.type === "chat.reasoning.tokens",
    );
    expect(counts.map((f) => [f.id, f.tokens])).toEqual([
      [bubbleId(frames, 0), 10],
      [bubbleId(frames, 1), 20],
    ]);
  });

  test("a long thought is sent whole, and the next segment still gets its own", async () => {
    const { streamer, frames } = collect();
    const long = "x".repeat(50_000);
    await streamer.pushReasoning(long);
    await streamer.appendToolUse([{ name: "bash", arguments: {}, output: "ok", ok: true }], true);
    await streamer.pushReasoning("still heard");
    await streamer.finish();

    // No ceiling and no marker: the reader gets the sentence the model finished.
    expect(reasoningOf(frames, bubbleId(frames, 0))).toBe(long);
    expect(reasoningOf(frames, bubbleId(frames, 1))).toBe("still heard");
  });

  test("nothing stops being sent, however long the thinking runs", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("y".repeat(100_000));
    await streamer.pushReasoning("this must still be sent");
    expect(reasoningOf(frames)).toContain("this must still be sent");
  });
});

describe("a call that has produced nothing yet", () => {
  // The wait before a first token is the whole screen on the engines that think before they
  // write, and the thread looked dead through it (2026-09-30).
  test("opens the bubble the turn will write into, and dates the wait", async () => {
    const { streamer, frames } = collect();
    await streamer.beginWait();
    expect(types(frames)).toEqual(["chat.stream.start", "chat.turn.wait"]);
    const thinking = frames[1] as MyClawAppServerFrame & { type: "chat.turn.wait"; id: string; since: string };
    expect(thinking.id).toBe(bubbleId(frames, 0));
    expect(Number.isFinite(Date.parse(thinking.since))).toBe(true);
  });

  test("the first token lands on that same bubble, so the line sits where the words arrive", async () => {
    const { streamer, frames } = collect();
    await streamer.beginWait();
    await streamer.push("Bonjour");
    expect(types(frames)).toEqual(["chat.stream.start", "chat.turn.wait", "chat.stream.delta"]);
    expect((frames[2] as MyClawAppServerFrame & { id: string }).id).toBe(bubbleId(frames, 0));
  });

  test("a thought and its estimate land on it too, rather than opening a second bubble", async () => {
    const { streamer, frames } = collect();
    await streamer.beginWait();
    await streamer.pushReasoning("weighing");
    expect(types(frames)).toEqual(["chat.stream.start", "chat.turn.wait", "chat.reasoning.delta"]);
    expect((frames[2] as MyClawAppServerFrame & { id: string }).id).toBe(bubbleId(frames, 0));
  });

  test("the call that follows a tool announces its own bubble", async () => {
    const { streamer, frames } = collect();
    await streamer.beginWait();
    await streamer.appendToolStart([{ id: "call-1", name: "bash", arguments: {} }]);
    await streamer.beginWait();
    const announced = frames.filter((f): f is MyClawAppServerFrame & { type: "chat.turn.wait"; id: string } => f.type === "chat.turn.wait");
    expect(announced).toHaveLength(2);
    expect(announced[0]!.id).toBe(bubbleId(frames, 0));
    expect(announced[1]!.id).toBe(bubbleId(frames, 1));
  });

  test("a call that follows prose opens its own bubble, instead of landing under the answer", async () => {
    const { streamer, frames } = collect();
    await streamer.push("the answer");
    await streamer.beginWait();
    const announced = frames.filter((f): f is MyClawAppServerFrame & { type: "chat.turn.wait"; id: string } => f.type === "chat.turn.wait");
    expect(announced).toHaveLength(1);
    expect(announced[0]!.id).toBe(bubbleId(frames, 1));
  });

  test("a run that is over announces nothing: the wait it described has no end to show", async () => {
    const { streamer, frames } = collect();
    await streamer.finish();
    const settled = frames.length;
    await streamer.beginWait();
    expect(frames.length).toBe(settled);
  });
});

describe("a reasoning-only bubble", () => {
  test("finish still closes it, so the app has a done to act on", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("thought, then called a tool without prose");
    await streamer.finish();
    expect(types(frames)).toEqual(["chat.stream.start", "chat.reasoning.delta", "chat.stream.done"]);
  });

  test("reasoning after finish is dropped, never resurrecting a closed bubble", async () => {
    const { streamer, frames } = collect();
    await streamer.push("done");
    await streamer.finish();
    const before = frames.length;
    await streamer.pushReasoning("late thought");
    await streamer.pushReasoningCount({ tokens: 10 });
    expect(frames).toHaveLength(before);
  });
});

test("reasoning and text keep their order under interleaved pushes", async () => {
  const { streamer, frames } = collect();
  await Promise.all([
    streamer.pushReasoning("r1"),
    streamer.push("t1"),
    streamer.pushReasoning("r2"),
    streamer.push("t2"),
  ]);
  await streamer.finish();
  // One queue owns every frame, so start is first and done is last no matter the call order.
  expect(frames[0]!.type).toBe("chat.stream.start");
  expect(frames[frames.length - 1]!.type).toBe("chat.stream.done");
  // r2 arrives after t1 is on screen, so it belongs to the next bubble, not to the one the
  // reader is already looking at.
  expect(reasoningOf(frames, bubbleId(frames, 0))).toBe("r1");
  expect(reasoningOf(frames, bubbleId(frames, 1))).toBe("r2");
  expect(textOf(frames, bubbleId(frames, 0))).toBe("t1");
  expect(textOf(frames, bubbleId(frames, 1))).toBe("t2");
});

/**
 * The counter used to restart at zero whenever a window reloaded mid-thought: the frame carried no
 * instant, so the client had nothing to date the span from but its own arrival.
 * See docs/reasoning-visibility.md.
 */
describe("the thinking span carries the instant it opened", () => {
  function sinces(frames: MyClawAppServerFrame[]): Array<string | undefined> {
    return frames
      .filter((f) => f.type === "chat.reasoning.delta" || f.type === "chat.reasoning.tokens")
      .map((f) => ("since" in f ? f.since : undefined));
  }

  test("the first delta of a phase dates it, and the ones that follow do not", async () => {
    const before = Date.now();
    const { streamer, frames } = collect();
    await streamer.pushReasoning("weighing ");
    await streamer.pushReasoning("options");

    const [first, second, ...rest] = sinces(frames);
    expect(rest).toHaveLength(0);
    expect(Date.parse(first!)).toBeGreaterThanOrEqual(before);
    // A second instant would move the start of a span that is still running.
    expect(second).toBeUndefined();
  });

  test("the next phase opens its own span, so a second thought is not dated by the first", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("first thought");
    await streamer.push("first answer");
    await streamer.pushReasoning("second thought");
    await streamer.finish();

    const dated = frames.filter(
      (f): f is MyClawAppServerFrame & { type: "chat.reasoning.delta"; id: string; since?: string } =>
        f.type === "chat.reasoning.delta",
    );
    // Two bubbles, each dated: the seal closes the span, so the thought after the answer is timed
    // from itself. Held undated, the client would date the second phase from the first one's start
    // and report the answer in between as thinking.
    expect(dated.map((f) => f.id)).toEqual([bubbleId(frames, 0), bubbleId(frames, 1)]);
    expect(dated.every((f) => typeof f.since === "string")).toBe(true);
  });

  test("a count opens no span: it is a figure about a thought that is over", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoningCount({ tokens: 128 });
    expect(sinces(frames)).toEqual([undefined]);
  });

  test("a count does not close the open span either, so the next thought of the bubble is not re-dated", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("still weighing");
    await streamer.pushReasoningCount({ tokens: 64 });
    await streamer.pushReasoning(" and weighing");
    expect(sinces(frames).filter((since) => since !== undefined)).toHaveLength(1);
  });
});
