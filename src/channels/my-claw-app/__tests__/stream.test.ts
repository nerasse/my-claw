/** @file Streamer tests: live spawn-card frames (`chat.spawn.start` / `chat.spawn.end`). */

import { describe, test, expect } from "bun:test";
import { MyClawAppStreamer } from "../stream.ts";
import type { MyClawAppServerFrame } from "../types.ts";

function makeStreamer() {
  const frames: MyClawAppServerFrame[] = [];
  const streamer = new MyClawAppStreamer({
    id: "turn-1",
    threadId: "thread-1",
    send: (frame) => {
      frames.push(frame);
    },
  });
  return { streamer, frames };
}

describe("MyClawAppStreamer live spawn cards", () => {
  test("appendSpawnStart sends chat.spawn.start with the tool card id", async () => {
    const { streamer, frames } = makeStreamer();
    await streamer.appendSpawnStart({
      subagentId: "subagent/run-123",
      displayName: "researcher",
      type: "research",
      mode: "run",
      toolCallId: "model-tool-1",
    });
    expect(frames).toHaveLength(1);
    const frame = frames[0] as Extract<MyClawAppServerFrame, { type: "chat.spawn.start" }>;
    expect(frame.type).toBe("chat.spawn.start");
    expect(frame.subagentId).toBe("subagent/run-123");
    expect(frame.displayName).toBe("researcher");
    expect(frame.mode).toBe("run");
    // No tool start recorded yet: the fallback card id is the subagent id.
    expect(frame.id).toBe("subagent/run-123");
  });

  test("appendSpawnStart links to the tool-start card once the model tool_use id is known", async () => {
    const { streamer, frames } = makeStreamer();
    // The tool start opened a card and recorded model tool_use id -> card id.
    await streamer["toolStartInternal"]([{ id: "model-tool-1", name: "spawn", arguments: {} }]);
    await streamer.appendSpawnStart({
      subagentId: "subagent/run-456",
      displayName: "coder",
      type: "general",
      mode: "session",
      toolCallId: "model-tool-1",
    });
    const frame = frames.find((f) => f.type === "chat.spawn.start") as
      | Extract<MyClawAppServerFrame, { type: "chat.spawn.start" }>
      | undefined;
    expect(frame?.id).toBe("turn-1:tool:1");
    expect(frame?.subagentId).toBe("subagent/run-456");
  });

  test("appendSpawnEnd settles the card started by appendSpawnStart", async () => {
    const { streamer, frames } = makeStreamer();
    await streamer.appendSpawnStart({
      subagentId: "subagent/run-789",
      displayName: "researcher",
      type: "research",
      mode: "run",
    });
    await streamer.appendSpawnEnd({
      subagentId: "subagent/run-789",
      status: "complete",
      resultLength: 42,
    });
    const end = frames.find((f) => f.type === "chat.spawn.end") as
      | Extract<MyClawAppServerFrame, { type: "chat.spawn.end" }>
      | undefined;
    expect(end?.status).toBe("complete");
    expect(end?.resultLength).toBe(42);
    expect(end?.id).toBe("subagent/run-789");
  });

  test("spawn frames are dropped after the stream is finished", async () => {
    const { streamer, frames } = makeStreamer();
    await streamer.finish("done");
    await streamer.appendSpawnStart({
      subagentId: "subagent/run-999",
      displayName: "x",
      type: "general",
      mode: "run",
    });
    expect(frames.filter((f) => f.type === "chat.spawn.start")).toHaveLength(0);
  });
});
