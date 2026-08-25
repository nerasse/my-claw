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
      mode: "run", action: "spawn",
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
      mode: "session", action: "spawn",
      toolCallId: "model-tool-1",
    });
    const frame = frames.find((f) => f.type === "chat.spawn.start") as
      | Extract<MyClawAppServerFrame, { type: "chat.spawn.start" }>
      | undefined;
    // The card is keyed on the model's call id so history rebuilds this same card after a reload.
    expect(frame?.id).toBe("t-model-tool-1");
    expect(frame?.subagentId).toBe("subagent/run-456");
  });

  test("a tool call with no model id falls back to the turn counter", async () => {
    const { streamer, frames } = makeStreamer();
    await streamer["toolStartInternal"]([{ id: "", name: "bash", arguments: {} }]);
    const frame = frames.find((f) => f.type === "chat.tool.start") as
      | Extract<MyClawAppServerFrame, { type: "chat.tool.start" }>
      | undefined;
    expect(frame?.id).toBe("turn-1:tool:1");
  });

  test("appendSpawnEnd settles the card started by appendSpawnStart", async () => {
    const { streamer, frames } = makeStreamer();
    await streamer.appendSpawnStart({
      subagentId: "subagent/run-789",
      displayName: "researcher",
      type: "research",
      mode: "run", action: "spawn",
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
      mode: "run", action: "spawn",
    });
    expect(frames.filter((f) => f.type === "chat.spawn.start")).toHaveLength(0);
  });
});

describe("one card, one id", () => {
  test("live output is addressed by the card id, even from a streamer that never opened it", async () => {
    // A mid-run injection replaces the streamer. The replacement never saw the tool start, so its
    // model-id table is empty: a lookup fell back to the raw `toolu_...` and the output went to a
    // card that does not exist -- invisible live output, and a journal that never forgot it.
    const { streamer, frames } = makeStreamer();
    await streamer.appendToolProgress("toolu_abc", { stdout: "une ligne\n" });

    const delta = frames.find((f) => f.type === "chat.tool.delta");
    expect(delta && "id" in delta ? delta.id : undefined).toBe("t-toolu_abc");
  });

  test("the start of that same call names the same card", async () => {
    const { streamer, frames } = makeStreamer();
    await streamer.appendToolStart([{ id: "toolu_abc", name: "bash", arguments: { command: "ls" } }]);
    await streamer.appendToolProgress("toolu_abc", { stdout: "sortie\n" });

    const ids = frames.filter((f) => f.type === "chat.tool.start" || f.type === "chat.tool.delta").map((f) => ("id" in f ? f.id : ""));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("t-toolu_abc");
  });
});
