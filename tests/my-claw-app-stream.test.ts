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

  test("a result settles its own card, not the first one asked for", async () => {
    // Tools are flushed as they finish, so results arrive in the order the work ended. Settling by
    // the start queue's order gave the first card the second tool's output, and left the card of
    // the tool that had actually answered spinning until the run ended (2026-09-16).
    const { streamer, frames } = collect();
    await streamer.appendToolStart([
      { id: "tu_browser", name: "browser", arguments: { mission: "tiktok" } },
      { id: "tu_search", name: "web_search", arguments: { q: "bars" } },
    ]);
    await streamer.appendToolUse(
      [{ id: "tu_search", name: "web_search", arguments: { q: "bars" }, durationMs: 1000, output: "results", ok: true }],
      true,
    );

    const starts = frames.filter((f): f is typeof f & { type: "chat.tool.start"; id: string; name: string } => f.type === "chat.tool.start");
    const idOf = (name: string) => starts.find((f) => f.name === name)!.id;
    const settled = frames.filter((f): f is typeof f & { type: "chat.tool"; id: string; output: string } => f.type === "chat.tool");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.id).toBe(idOf("web_search"));
    expect(settled[0]!.output).toBe("results");

    // The tool still running is the one a stop has to settle, with its own id.
    await streamer.finish();
    const after = frames.filter((f): f is typeof f & { type: "chat.tool"; id: string; output: string } => f.type === "chat.tool");
    expect(after).toHaveLength(2);
    expect(after[1]!.id).toBe(idOf("browser"));
    expect(after[1]!.output).toBe("interrupted");
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
    expect(starts[0]!.id).toBe(ends[0]!.id);
    expect(ends[0]!.output).toBe("file.txt");
  });

  test("a tool end with the model id present still reuses the start card id (no duplicate cards)", async () => {
    // Regression: when both a start (card id turn:tool:N) and an end carrying the model tool_use
    // id reach the streamer, the end must settle the SAME card the start opened. Using the model
    // id as the card id made the app stack a second card (double bash cards on screen).
    const { streamer, frames } = collect();
    await streamer.appendToolStart([{ id: "tu_1", name: "bash", arguments: { command: "ls" } }]);
    await streamer.appendToolUse([{ id: "tu_1", name: "bash", arguments: { command: "ls" }, durationMs: 12, output: "file.txt", ok: true }], true);
    await streamer.finish();
    const starts = frames.filter((f) => f.type === "chat.tool.start") as { type: "chat.tool.start"; id: string }[];
    const ends = frames.filter((f) => f.type === "chat.tool") as { type: "chat.tool"; id: string; output: string }[];
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.id).toBe(starts[0]!.id);
    expect(ends[0]!.output).toBe("file.txt");
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
    expect(deltas[0]!.stdout).toBe("line 1\n");
    expect(deltas[1]!.stderr).toBe("warn");
    // The delta carries the card's id (mapped from the model id), not the model id itself.
    expect(start).toBeDefined();
    expect(deltas[0]!.id).toBe(start!.id);
  });
  test("abort settles open tool cards and spawn cards instead of leaving them spinning", async () => {
    const { streamer, frames } = collect();
    await streamer.appendToolStart([{ id: "tu_1", name: "bash", arguments: { command: "sleep 30" } }]);
    await streamer.appendSpawnStart({ subagentId: "subagent/sleep-probe", displayName: "sleep-probe", type: "general", mode: "run", action: "spawn", toolCallId: "tu_1" });
    await streamer.abort("stopped by owner");

    const toolEnds = frames.filter((f) => f.type === "chat.tool") as { id: string; name: string; ok: boolean; output: string }[];
    const spawnEnds = frames.filter((f) => f.type === "chat.spawn.end") as { id: string; status: string; error?: string }[];
    const aborts = frames.filter((f) => f.type === "chat.stream.abort");

    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]!.name).toBe("bash");
    expect(toolEnds[0]!.ok).toBe(false);
    expect(toolEnds[0]!.output).toContain("stopped by owner");
    expect(spawnEnds).toHaveLength(1);
    expect(spawnEnds[0]!.status).toBe("aborted");
    expect(aborts).toHaveLength(1);
  });

  // One `/stop` used to print "Run aborted by user" once per message folded into the run: each of
  // those messages carries a streamer of its own that never paints, because the run answers them
  // in its own bubbles, and every one of them sent an abort the app turned into an empty bubble.
  test("a streamer that never painted anything says nothing when the run is stopped", async () => {
    const { streamer, frames } = collect();
    await streamer.abort();
    expect(frames).toHaveLength(0);
  });

  test("a run that dies before its first token still reports: that bubble is the only place it can", async () => {
    const { streamer, frames } = collect();
    await streamer.abort("LLM call failed: 401");
    const aborts = frames.filter((f) => f.type === "chat.stream.abort") as { error?: string }[];
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.error).toBe("LLM call failed: 401");
  });

  // The failure entry is journalled by the run's own error path, which is nowhere near this
  // object: what it needs from here is the id, or the entry becomes a second identity for one
  // error and the next page draws it twice -- docs/bubble-identity.md.
  test("the bubble an error was painted in is readable afterwards, and is the one the frame carried", async () => {
    const { streamer, frames } = collect();
    expect(streamer.errorBubble()).toBeUndefined();
    await streamer.abort("LLM call failed: 401");
    const abort = frames.find((f) => f.type === "chat.stream.abort") as { id: string };
    expect(streamer.errorBubble()).toBe(abort.id);
  });

  test("a run that painted an answer before dying reports in the bubble it was writing", async () => {
    const { streamer, frames } = collect();
    await streamer.push("je regarde");
    await streamer.abort("LLM call failed: 529");
    const deltaFrames = frames.filter((f) => f.type === "chat.stream.delta") as { id: string }[];
    expect(streamer.errorBubble()).toBe(deltaFrames[0]!.id);
  });

  test("a streamer that never painted anything has no error bubble to offer", async () => {
    const { streamer } = collect();
    await streamer.abort();
    expect(streamer.errorBubble()).toBeUndefined();
  });

  test("a bubble that was painted is settled by the stop, silently", async () => {
    const { streamer, frames } = collect();
    await streamer.push("partial answer");
    await streamer.abort();
    const aborts = frames.filter((f) => f.type === "chat.stream.abort") as { error?: string }[];
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.error).toBeUndefined();
  });

  test("finish settles cards left open by a silent stop instead of leaving the spinner", async () => {
    const { streamer, frames } = collect();
    await streamer.appendToolStart([{ id: "tu_1", name: "bash", arguments: { command: "sleep" } }]);
    await streamer.finish();

    const toolEnds = frames.filter((f) => f.type === "chat.tool") as { id: string; name: string; ok: boolean; output: string }[];
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]!.name).toBe("bash");
    expect(toolEnds[0]!.ok).toBe(false);
    expect(toolEnds[0]!.output).toBe("interrupted");
  });

  test("finish with no open cards still sends stream.done only", async () => {
    const { streamer, frames } = collect();
    await streamer.push("hello");
    await streamer.finish();
    expect(frames.filter((f) => f.type === "chat.tool")).toHaveLength(0);
    expect(frames.filter((f) => f.type === "chat.stream.done")).toHaveLength(1);
  });
});

describe("MyClawAppStreamer restart", () => {
  /** The bubble's text as the app reconstructs it: a replay delta replaces, the others append. */
  function bubble(frames: MyClawAppServerFrame[]): string {
    let text = "";
    for (const frame of frames) {
      if (frame.type !== "chat.stream.delta") continue;
      text = frame.replay ? frame.text : text + frame.text;
    }
    return text;
  }

  test("a replayed call replaces the bubble instead of adding to it", async () => {
    const { streamer, frames } = collect();
    await streamer.push("half an ans");
    await streamer.restart();
    await streamer.push("the answer");
    await streamer.finish();
    expect(bubble(frames)).toBe("the answer");
  });

  test("the thinking of the dead attempt is taken back with its words", async () => {
    const { streamer, frames } = collect();
    await streamer.pushReasoning("thinking about it");
    await streamer.restart();
    await streamer.pushReasoning("thinking again");
    await streamer.push("answer");
    await streamer.finish();
    let reasoning = "";
    for (const frame of frames) {
      if (frame.type !== "chat.reasoning.delta") continue;
      reasoning = frame.replay ? frame.text : reasoning + frame.text;
    }
    expect(reasoning).toBe("thinking again");
    expect(bubble(frames)).toBe("answer");
  });

  test("a restart after a tool card leaves the sealed bubble alone", async () => {
    const { streamer, frames } = collect();
    await streamer.push("first call");
    await streamer.appendToolUse([{ id: "c1", name: "bash", arguments: {}, durationMs: 1, output: "ok", ok: true }], true);
    await streamer.push("second call");
    await streamer.restart();
    await streamer.push("replayed");
    await streamer.finish();
    const byBubble = new Map<string, string>();
    for (const frame of frames) {
      if (frame.type !== "chat.stream.delta") continue;
      const current = byBubble.get(frame.id) ?? "";
      byBubble.set(frame.id, frame.replay ? frame.text : current + frame.text);
    }
    // Two bubbles: the sealed one keeps what it said, the open one is replaced.
    expect([...byBubble.values()]).toEqual(["first call", "replayed"]);
  });
});

describe("a notice closes the bubble it interrupts", () => {
  test("sealing separates the prose before it from the prose after", async () => {
    // A provider note (a retry, a wall, a model the run left) belongs where the run stood still.
    // Appended beside a bubble still streaming, it was dragged to the bottom of the turn and read
    // as stuck there (owner, 2026-11-14).
    const { streamer, frames } = collect();
    await streamer.push("oui, je regarde");
    await streamer.seal();
    await streamer.push("voila");
    await streamer.finish();

    const shape = frames.map((frame) =>
      frame.type === "chat.stream.start" ? `start:${frame.id}`
        : frame.type === "chat.stream.delta" ? `delta:${frame.text}`
          : frame.type === "chat.stream.done" ? `done:${frame.id}`
            : frame.type,
    );
    const first = frames.find((frame) => frame.type === "chat.stream.start")!;
    const done = frames.findIndex((frame) => frame.type === "chat.stream.done");
    const startAgain = frames.findIndex((frame) => frame.type === "chat.stream.start" && frame.id !== first.id);
    expect(shape.filter((label) => label.startsWith("start:"))).toHaveLength(2);
    // The first bubble is closed before the second one opens, and the after-prose is the second's.
    expect(done).toBeGreaterThan(-1);
    expect(startAgain).toBeGreaterThan(done);
    expect(frames.at(-1)).toMatchObject({ type: "chat.stream.done" });
    expect(deltas(frames)).toBe("oui, je regardevoila");
  });

  test("sealing a streamer that wrote nothing is a no-op", async () => {
    const { streamer, frames } = collect();
    await streamer.seal();
    await streamer.push("premier mot");
    await streamer.finish();
    expect(frames.filter((frame) => frame.type === "chat.stream.start")).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === "chat.stream.done")).toHaveLength(1);
  });
});
