import { describe, expect, test } from "bun:test";
import { MyClawAppStreamer } from "../../src/channels/my-claw-app/stream.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";
import { REASONING_LIMIT } from "../../src/sessions/store.ts";

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

  test("a token estimate alone opens the bubble too, for a redacted engine", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoningTokens(512);
    expect(types(frames)).toEqual(["chat.stream.start", "chat.reasoning.tokens"]);
    const frame = frames[1] as MyClawAppServerFrame & { type: "chat.reasoning.tokens"; tokens: number };
    expect(frame.tokens).toBe(512);
  });

  test("a zero or negative estimate is not sent at all", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoningTokens(0);
    await streamer.pushReasoningTokens(-3);
    expect(frames).toHaveLength(0);
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

    expect(reasoningOf(frames, "s1")).toBe("first thought");
    expect(reasoningOf(frames, "s1#1")).toBe("second thought");
  });

  test("the reasoning cap is per segment, so a long first thought does not mute the second", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("x".repeat(REASONING_LIMIT + 10));
    await streamer.appendToolUse([{ name: "bash", arguments: {}, output: "ok", ok: true }], true);
    await streamer.pushReasoning("still heard");
    await streamer.finish();

    expect(reasoningOf(frames, "s1").endsWith("[reasoning truncated]")).toBe(true);
    expect(reasoningOf(frames, "s1#1")).toBe("still heard");
  });

  test("reasoning past the cap stops being sent rather than flooding the socket", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("y".repeat(REASONING_LIMIT));
    await streamer.pushReasoning("this must not be sent");
    const text = reasoningOf(frames);
    expect(text).not.toContain("this must not be sent");
    expect(text.length).toBeLessThanOrEqual(REASONING_LIMIT + 32);
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
    await streamer.pushReasoningTokens(10);
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
  expect(reasoningOf(frames)).toBe("r1r2");
});
