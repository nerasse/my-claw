import { describe, expect, test } from "bun:test";
import { subAgentStreamFor } from "../subagent-stream.ts";
import { MyClawAppStreamer } from "../stream.ts";
import type { MyClawAppServerFrame } from "../types.ts";
import type { UnifiedMessage } from "../../types.ts";

/**
 * What a sub-agent's run forwards to the app, and where.
 *
 * The thinking was the field the type carried and nobody filled: a window watching a sub-agent
 * saw its prose and its tool cards and never a word of what it thought, while its log held every
 * summary (2026-09-30).
 */
function streamerFor(frames: MyClawAppServerFrame[]): MyClawAppStreamer {
  return new MyClawAppStreamer({
    id: "child-bubble",
    threadId: "child-thread",
    send: (frame) => {
      frames.push(frame);
    },
  });
}

function types(frames: MyClawAppServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

describe("a sub-agent's stream", () => {
  test("is absent when the child has no streamer: a parent-driven run stays quiet", () => {
    expect(subAgentStreamFor(new Map(), new Map(), "child", () => {})).toBeUndefined();
  });

  test("carries the child's thinking into the child's own thread", async () => {
    const frames: MyClawAppServerFrame[] = [];
    const streamers = new Map([["child", streamerFor(frames)]]);
    const stream = subAgentStreamFor(streamers, new Map(), "child", () => {});
    await stream!.reasoning!.onText!("weighing ");
    await stream!.reasoning!.onText!("options");
    expect(types(frames)).toEqual(["chat.stream.start", "chat.reasoning.delta", "chat.reasoning.delta"]);
    const thread = (frames[0] as MyClawAppServerFrame & { threadId: string }).threadId;
    expect(thread).toBe("child-thread");
  });

  test("announces the child's calls in the child's own bubble", async () => {
    const frames: MyClawAppServerFrame[] = [];
    const streamers = new Map([["child", streamerFor(frames)]]);
    const stream = subAgentStreamFor(streamers, new Map(), "child", () => {});
    await stream!.reasoning!.onCallStart!();
    expect(types(frames)).toEqual(["chat.stream.start", "chat.turn.wait"]);
    expect((frames[1] as MyClawAppServerFrame & { threadId: string }).threadId).toBe("child-thread");
  });

  test("carries what each call spent thinking too", async () => {
    const frames: MyClawAppServerFrame[] = [];
    const streamers = new Map([["child", streamerFor(frames)]]);
    const stream = subAgentStreamFor(streamers, new Map(), "child", () => {});
    await stream!.reasoning!.onCount!({ tokens: 120 });
    expect(types(frames)).toEqual(["chat.stream.start", "chat.reasoning.tokens"]);
  });

  test("reads the streamer of the moment: a steered child paints into its new bubble", async () => {
    const first: MyClawAppServerFrame[] = [];
    const second: MyClawAppServerFrame[] = [];
    const streamers = new Map([["child", streamerFor(first)]]);
    const renew = new Map([["child", () => streamerFor(second)]]);
    const injected: UnifiedMessage[] = [];
    const stream = subAgentStreamFor(streamers, renew, "child", (message) => injected.push(message));

    await stream!.onTurnSwitch!({ id: "m2", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "again", attachments: [], isForwarded: false, raw: {} });
    await stream!.onToken!("after the steering");
    expect(injected).toHaveLength(1);
    expect(types(first)).toEqual(["chat.stream.done"]);
    expect(types(second)).toEqual(["chat.stream.start", "chat.stream.delta"]);
  });

  test("drops the streamer when nothing can renew it, rather than painting into a sealed bubble", async () => {
    const frames: MyClawAppServerFrame[] = [];
    const streamers = new Map([["child", streamerFor(frames)]]);
    const stream = subAgentStreamFor(streamers, new Map(), "child", () => {});
    await stream!.onTurnSwitch!({ id: "m2", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "again", attachments: [], isForwarded: false, raw: {} });
    expect(streamers.has("child")).toBe(false);
    const before = frames.length;
    await stream!.onToken!("lost");
    expect(frames.length).toBe(before);
  });
});
