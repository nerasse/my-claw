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

  // Reported from the app: a second thinking phase rendered above the answer already on screen,
  // and the words that came after it continued that same bubble.
  test("thinking that follows an answer seals it and opens the next bubble", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("first thought");
    await streamer.push("first answer");
    await streamer.pushReasoning("second thought");
    await streamer.push("second answer");
    await streamer.finish();

    expect(reasoningOf(frames, "s1")).toBe("first thought");
    expect(reasoningOf(frames, "s1#1")).toBe("second thought");
    expect(textOf(frames, "s1")).toBe("first answer");
    expect(textOf(frames, "s1#1")).toBe("second answer");
    // The first bubble closes before the second opens, so the app renders them in order.
    expect(types(frames).filter((t) => t === "chat.stream.start")).toHaveLength(2);
    expect(types(frames).indexOf("chat.stream.done")).toBeLessThan(types(frames).lastIndexOf("chat.stream.start"));
  });

  test("a token estimate after an answer seals it too, for a redacted engine", async () => {
    const { streamer, frames } = collect();
    await streamer.push("first answer");
    await streamer.pushReasoningTokens(512);
    await streamer.push("second answer");
    await streamer.finish();

    expect(textOf(frames, "s1")).toBe("first answer");
    expect(textOf(frames, "s1#1")).toBe("second answer");
    const tokens = frames.find((f) => f.type === "chat.reasoning.tokens");
    expect(tokens && "id" in tokens ? tokens.id : undefined).toBe("s1#1");
  });

  test("a thinking phase that never answered is not split in two", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("still weighing");
    await streamer.pushReasoningTokens(64);
    await streamer.pushReasoning(" and weighing");
    expect(types(frames).filter((t) => t === "chat.stream.start")).toHaveLength(1);
    expect(reasoningOf(frames)).toBe("still weighing and weighing");
  });

  test("a long thought is sent whole, and the next segment still gets its own", async () => {
    const { streamer, frames } = collect();
    const long = "x".repeat(50_000);
    await streamer.pushReasoning(long);
    await streamer.appendToolUse([{ name: "bash", arguments: {}, output: "ok", ok: true }], true);
    await streamer.pushReasoning("still heard");
    await streamer.finish();

    // No ceiling and no marker: the reader gets the sentence the model finished.
    expect(reasoningOf(frames, "s1")).toBe(long);
    expect(reasoningOf(frames, "s1#1")).toBe("still heard");
  });

  test("nothing stops being sent, however long the thinking runs", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("y".repeat(100_000));
    await streamer.pushReasoning("this must still be sent");
    expect(reasoningOf(frames)).toContain("this must still be sent");
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
  // r2 arrives after t1 is on screen, so it belongs to the next bubble, not to the one the
  // reader is already looking at.
  expect(reasoningOf(frames, "s1")).toBe("r1");
  expect(reasoningOf(frames, "s1#1")).toBe("r2");
  expect(textOf(frames, "s1")).toBe("t1");
  expect(textOf(frames, "s1#1")).toBe("t2");
});
