import { describe, expect, test } from "bun:test";
import { MyClawAppStreamer } from "../src/channels/my-claw-app/stream.ts";
import type { MyClawAppServerFrame } from "../src/channels/my-claw-app/types.ts";

function collect() {
  const frames: MyClawAppServerFrame[] = [];
  const streamer = new MyClawAppStreamer({
    id: "s1",
    threadId: "t1",
    send: (frame) => {
      frames.push(frame);
    },
  });
  return { streamer, frames };
}

function deltas(frames: MyClawAppServerFrame[]): string {
  return frames
    .filter((frame): frame is MyClawAppServerFrame & { type: "chat.stream.delta"; text: string } => frame.type === "chat.stream.delta")
    .map((frame) => frame.text)
    .join("");
}

describe("MyClawAppStreamer media refs", () => {
  test("a MEDIA: ref never appears, even when tokens split it", async () => {
    const { streamer, frames } = collect();
    await streamer.push("voici le résultat\n\nMED");
    await streamer.push("IA:");
    await streamer.push("/tmp/x.png");
    await streamer.finish();
    expect(deltas(frames)).toBe("voici le résultat\n\n");
  });

  test("a ref split at the very end of the answer is withheld, not half-sent", async () => {
    const { streamer, frames } = collect();
    await streamer.push("fait\n\nMEDIA:/tmp/");
    await streamer.push("photo.pn");
    await streamer.finish();
    const text = deltas(frames);
    expect(text).toBe("fait\n\n");
    expect(text.includes("MEDIA")).toBe(false);
  });

  test("a tail that stops being a ref is released whole", async () => {
    const { streamer, frames } = collect();
    await streamer.push("parle de MEDIA");
    await streamer.push(" en bourse");
    await streamer.finish();
    expect(deltas(frames)).toBe("parle de MEDIA en bourse");
  });

  test("an image-only answer streams no text at all", async () => {
    const { streamer, frames } = collect();
    await streamer.push("MEDIA:/tmp/x.png");
    await streamer.finish();
    const types = frames.map((frame) => frame.type);
    expect(types).toEqual(["chat.stream.start", "chat.stream.done"]);
  });

  test("several refs in one answer are all stripped", async () => {
    const { streamer, frames } = collect();
    await streamer.push("a\nMEDIA:/tmp/a.jpg\n\nMEDIA:/tmp/b.jpg fin");
    await streamer.finish();
    const text = deltas(frames);
    expect(text.includes("MEDIA")).toBe(false);
    expect(text).toBe("a\n\n\n fin");
  });

  test("a ref split across a tool boundary never leaks into the next segment", async () => {
    const { streamer, frames } = collect();
    await streamer.push("intro");
    await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" }, durationMs: 10 }], true);
    await streamer.push("MEDIA:/x.png voilà");
    await streamer.finish();
    const text = deltas(frames);
    expect(text).toBe("intro voilà");
    expect(text.includes("MEDIA")).toBe(false);
  });

  test("a tool start frame reuses the same id as the end frame so the app can upsert", async () => {
    const { streamer, frames } = collect();
    await streamer.appendToolStart([{ id: "tu_1", name: "bash", arguments: { command: "ls" } }]);
    await streamer.appendToolUse([{ id: undefined, name: "bash", arguments: { command: "ls" }, durationMs: 12, output: "file.txt", ok: true }], true);
    await streamer.finish();
    const starts = frames.filter((f) => f.type === "chat.tool.start") as { type: "chat.tool.start"; id: string; name: string }[];
    const ends = frames.filter((f) => f.type === "chat.tool") as { type: "chat.tool"; id: string; name: string; output: string }[];
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(ends[0].output).toBe("file.txt");
  });

  test("live progress is routed to the card the start frame opened, by the model tool id", async () => {
    const { streamer, frames } = collect();
    await streamer.appendToolStart([{ id: "tu_1", name: "bash", arguments: { command: "sleep 1" } }]);
    await streamer.appendToolProgress("tu_1", { stdout: "line 1\n" });
    await streamer.appendToolProgress("tu_1", { stderr: "warn" });
    await streamer.appendToolUse([{ id: "tu_1", name: "bash", arguments: { command: "sleep 1" }, durationMs: 1000, output: "line 1\n", ok: true }], true);
    await streamer.finish();
    const start = frames.find((f) => f.type === "chat.tool.start") as { id: string } | undefined;
    const deltas = frames.filter((f) => f.type === "chat.tool.delta") as { id: string; stdout: string; stderr: string }[];
    expect(deltas).toHaveLength(2);
    expect(deltas[0].stdout).toBe("line 1\n");
    expect(deltas[1].stderr).toBe("warn");
    // The delta carries the card's id (mapped from the model id), not the model id itself.
    expect(start).toBeDefined();
    expect(deltas[0].id).toBe(start!.id);
  });
});
