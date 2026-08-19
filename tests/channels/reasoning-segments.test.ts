import { describe, expect, test } from "bun:test";
import { MyClawAppStreamer } from "../../src/channels/my-claw-app/stream.ts";
import { ReasoningSegmenter } from "../../src/llm/reasoning-segments.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";

type Event = { kind: "reasoning" | "text"; delta: string };

/** The bubbles one event order produces live, as `{ reasoning, content }` per bubble id. */
async function streamed(events: Event[]): Promise<Array<{ reasoning?: string; content: string }>> {
  const frames: MyClawAppServerFrame[] = [];
  const streamer = new MyClawAppStreamer({ id: "s", threadId: "t", send: (frame) => void frames.push(frame) });
  for (const event of events) {
    if (event.kind === "reasoning") await streamer.pushReasoning(event.delta);
    else await streamer.push(event.delta);
  }
  await streamer.finish();

  const order: string[] = [];
  const bubbles = new Map<string, { reasoning?: string; content: string }>();
  for (const frame of frames) {
    if (frame.type !== "chat.stream.delta" && frame.type !== "chat.reasoning.delta") continue;
    if (!bubbles.has(frame.id)) {
      bubbles.set(frame.id, { content: "" });
      order.push(frame.id);
    }
    const bubble = bubbles.get(frame.id)!;
    if (frame.type === "chat.stream.delta") bubble.content += frame.text;
    else bubble.reasoning = (bubble.reasoning ?? "") + frame.text;
  }
  return order.map((id) => bubbles.get(id)!);
}

/** The same order through the segmenter, which is what the replay of those bubbles reads. */
function stored(events: Event[]): Array<{ reasoning?: string; content: string }> {
  const segmenter = new ReasoningSegmenter();
  for (const event of events) {
    if (event.kind === "reasoning") segmenter.reasoning(event.delta);
    else segmenter.text(event.delta);
  }
  return segmenter.list() ?? [];
}

const reasoning = (delta: string): Event => ({ kind: "reasoning", delta });
const text = (delta: string): Event => ({ kind: "text", delta });

/**
 * The live stream and the stored cuts are two implementations of one rule: reasoning that follows
 * visible text belongs to the next bubble. They have to agree, or a reopened conversation shows a
 * different shape than the one the reader watched being written -- docs/reasoning-visibility.md.
 */
describe("what the reader saw is what the replay stores", () => {
  test("two thinking phases split the same way on both sides", async () => {
    const events = [reasoning("first thought"), text("first answer"), reasoning("second thought"), text("second answer")];
    expect(await streamed(events)).toEqual(stored(events));
  });

  test("three phases, deltas split at random points, still agree", async () => {
    const events = [
      reasoning("wei"),
      reasoning("ghing"),
      text("one"),
      reasoning("more"),
      text("two"),
      text(" and a half"),
      reasoning("last"),
      text("three"),
    ];
    expect(await streamed(events)).toEqual(stored(events));
  });

  test("a thought that answers nothing is the last phase on both sides", async () => {
    const events = [text("answer"), reasoning("about to call a tool")];
    expect(await streamed(events)).toEqual(stored(events));
  });

  test("a single phase is one bubble, and nothing to store", async () => {
    const events = [reasoning("weighing"), text("answer")];
    expect(await streamed(events)).toHaveLength(1);
    expect(stored(events)).toEqual([]);
  });
});
