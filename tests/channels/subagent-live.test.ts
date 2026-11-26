/**
 * A child's stream outlives the turn that launched it.
 *
 * A launch never waits: the spawning turn answers in milliseconds and the child carries on by
 * design (docs/subagents.md, "Background"). The stream was opened and torn down with that turn, so
 * the moment the parent answered, the child's thread went silent and its run was announced
 * `aborted` while it was still working -- the chat then read "stopped" under a Stop button that
 * never finished turning, and a window opened mid-run was replayed nothing (owner, 2026-11-26).
 *
 * What is pinned here is the contract: one stream per child run, opened with it, closed with its
 * own end, at any depth; the launch card still lands on the parent's bubble; and nothing in this
 * module can be ended by the parent's turn, because the parent's turn is not an input it has.
 */

import { describe, expect, test } from "bun:test";
import { SubAgentLive, type SubAgentLiveDeps } from "../../src/channels/my-claw-app/subagent-live.ts";
import type { MyClawAppStreamer } from "../../src/channels/my-claw-app/stream.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const PARENT = "my-claw-app/thread/owner/thread-1";
const CHILD = "subagent/probe-1";
const CHILD_THREAD = "sub-0f0f0f0f0f0f0f0f";
const GRANDCHILD = "subagent/probe-1/deep-1";
const GRANDCHILD_THREAD = "sub-deadbeefdeadbeef";

interface Recorder {
  calls: string[];
  messages: UnifiedMessage[];
}

function fakeStreamer(rec: Recorder, name: string): MyClawAppStreamer {
  const note = (call: string, extra?: unknown): void => {
    rec.calls.push(`${name}.${call}${extra === undefined ? "" : `:${JSON.stringify(extra)}`}`);
  };
  return {
    appendSpawnStart: async (info: unknown) => note("appendSpawnStart", info),
    appendSpawnEnd: async (info: unknown) => note("appendSpawnEnd", info),
    appendToolProgress: async (id: string, chunk: unknown) => note("appendToolProgress", { id, chunk }),
    finish: async () => note("finish"),
    abort: async (error?: string) => note("abort", error ?? null),
    take: () => [],
    errorBubble: () => undefined,
    seal: async () => undefined,
  } as unknown as MyClawAppStreamer;
}

function harness() {
  const rec: Recorder = { calls: [], messages: [] };
  const runs: { owner: string; threadId: string; active: boolean; reason?: string }[] = [];
  const deps: SubAgentLiveDeps = {
    createStreamer: (message) => {
      rec.messages.push(message);
      return fakeStreamer(rec, `child-${rec.messages.length}`);
    },
    notifyRun: (owner, threadId, active, reason) => {
      runs.push({ owner, threadId, active, ...(reason ? { reason } : {}) });
      rec.calls.push(`run:${active ? "start" : "end"}`);
    },
    appSessionOf: (sessionId) => (sessionId.startsWith("my-claw-app/thread/") ? { owner: "owner", threadId: "thread-1" } : null),
    threadOf: (id) => (id === CHILD ? CHILD_THREAD : id === GRANDCHILD ? GRANDCHILD_THREAD : null),
    onInjected: () => {},
  };
  const live = new SubAgentLive();
  live.attach(deps);
  return { live, rec, runs };
}

const spawnEvent = (id: string, parentSessionId: string) => ({
  id,
  displayName: "probe",
  type: "general",
  mode: "session",
  parentSessionId,
  action: "spawn" as const,
});

describe("a sub-agent's live stream", () => {
  test("opens with the child's run and hands the runner a stream for it", () => {
    const { live, runs, rec } = harness();
    live.spawn(spawnEvent(CHILD, PARENT));

    expect(runs).toEqual([{ owner: "owner", threadId: CHILD_THREAD, active: true }]);
    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0]!.chatId).toBe("owner");
    expect(rec.messages[0]!.threadId).toBe(CHILD_THREAD);
    expect(live.streamOf(CHILD)).toBeDefined();
  });

  test("a child of another channel gets no stream: there is no thread to paint in", () => {
    const { live, runs } = harness();
    live.spawn(spawnEvent("subagent/cron-1", "cron/0123456789ab/1790571620919"));
    expect(runs).toEqual([]);
    expect(live.streamOf("subagent/cron-1")).toBeUndefined();
  });

  test("the launch card lands on the parent run's bubble, not on the child's", () => {
    const { live, rec } = harness();
    const cards: string[] = [];
    const parent = { appendSpawnStart: async (info: unknown) => cards.push(`start:${JSON.stringify(info)}`) } as unknown as MyClawAppStreamer;
    live.registerRun(PARENT, () => parent);

    live.spawn({ ...spawnEvent(CHILD, PARENT), toolCallId: "call_spawn_1" });

    expect(cards).toHaveLength(1);
    const info = JSON.parse(cards[0]!.slice("start:".length)) as Record<string, unknown>;
    expect(info["subagentId"]).toBe(CHILD);
    expect(info["toolCallId"]).toBe("call_spawn_1");
    // The child's own streamer was created, but nothing was drawn on it by the launch.
    expect(rec.calls.filter((call) => call.includes("appendSpawnStart"))).toEqual([]);
  });

  test("a sub-agent of a sub-agent paints on its own parent's bubble", () => {
    const { live, rec, runs } = harness();
    const cards: string[] = [];
    live.spawn(spawnEvent(CHILD, PARENT));
    const childStreamer = {
      appendSpawnStart: async (info: unknown) => cards.push(`child-start:${JSON.stringify(info)}`),
      appendSpawnEnd: async () => undefined,
    } as unknown as MyClawAppStreamer;
    // The child's streamer is the one the module opened; swap it for a spy the way a steered
    // child's own stream would answer.
    (live as unknown as { streamers: Map<string, MyClawAppStreamer> }).streamers.set(CHILD, childStreamer);

    live.spawn(spawnEvent(GRANDCHILD, CHILD));

    expect(cards).toHaveLength(1);
    expect(live.streamOf(GRANDCHILD)).toBeDefined();
    expect(rec.messages).toHaveLength(2);
    expect(rec.messages[1]!.threadId).toBe(GRANDCHILD_THREAD);
    // The owner is inherited from the level above: a grandchild's parent is a sub-agent, which
    // has no app session of its own to name one.
    expect(rec.messages[1]!.chatId).toBe("owner");
    expect(runs.at(-1)).toEqual({ owner: "owner", threadId: GRANDCHILD_THREAD, active: true });
  });

  test("a completing child closes its stream, settles its card and ends its own run", async () => {
    const { live, runs, rec } = harness();
    const cards: string[] = [];
    live.registerRun(PARENT, () => ({
      appendSpawnStart: async () => undefined,
      appendSpawnEnd: async (info: unknown) => cards.push(JSON.stringify(info)),
    } as unknown as MyClawAppStreamer));
    live.spawn(spawnEvent(CHILD, PARENT));
    await live.settle({ id: CHILD, parentSessionId: PARENT, resultLength: 42 }, "complete");

    expect(rec.calls).toContain("child-1.finish");
    expect(cards).toHaveLength(1);
    expect(runs.at(-1)).toEqual({ owner: "owner", threadId: CHILD_THREAD, active: false, reason: "done" });
    expect(live.streamOf(CHILD)).toBeUndefined();
  });

  test("a stopped child ends its run too: that end is the only thing that lifts its Stop button", async () => {
    const { live, runs, rec } = harness();
    live.spawn(spawnEvent(CHILD, PARENT));
    await live.settle({ id: CHILD, parentSessionId: PARENT }, "aborted");

    expect(rec.calls).toContain("child-1.abort:null");
    expect(runs.at(-1)).toEqual({ owner: "owner", threadId: CHILD_THREAD, active: false, reason: "aborted" });
    expect(live.streamOf(CHILD)).toBeUndefined();
  });

  test("a failed child says why in both places: the bubble and the thread's run", async () => {
    const { live, runs, rec } = harness();
    live.spawn(spawnEvent(CHILD, PARENT));
    await live.settle({ id: CHILD, parentSessionId: PARENT, error: "provider said no" }, "error");

    expect(rec.calls).toContain('child-1.abort:"provider said no"');
    expect(runs.at(-1)).toEqual({ owner: "owner", threadId: CHILD_THREAD, active: false, reason: "error" });
  });

  test("a second run of the same child opens a second stream", async () => {
    const { live, runs, rec } = harness();
    live.spawn(spawnEvent(CHILD, PARENT));
    await live.settle({ id: CHILD, parentSessionId: PARENT }, "complete");
    live.spawn({ ...spawnEvent(CHILD, PARENT), action: "send" });

    expect(rec.messages).toHaveLength(2);
    expect(runs.filter((run) => run.active)).toHaveLength(2);
    expect(live.streamOf(CHILD)).toBeDefined();
  });

  test("a child's live output reaches its own card, and nothing else's", () => {
    const { live, rec } = harness();
    live.spawn(spawnEvent(CHILD, PARENT));
    live.progress("toolu_1", CHILD, { stdout: "hello\n" });
    live.progress("toolu_1", "subagent/other", { stdout: "lost\n" });
    expect(rec.calls.filter((call) => call.includes("appendToolProgress"))).toHaveLength(1);
  });

  test("the run end is the last frame of the run, never before the abort it reports", async () => {
    // The app opens a synthetic run for any item it meets outside one, and a synthetic run has no
    // end to come: a `chat.tool` settling the interrupted card after `chat.run.end` left the
    // composer showing a Stop button for good (measured 2026-11-26).
    const { live, rec } = harness();
    live.spawn(spawnEvent(CHILD, PARENT));
    await live.settle({ id: CHILD, parentSessionId: PARENT }, "aborted");

    expect(rec.calls.at(-1)).toBe("run:end");
    expect(rec.calls.indexOf("child-1.abort:null")).toBeLessThan(rec.calls.indexOf("run:end"));
  });

  test("an unregistered run gets no card, and the child's own stream still opens", () => {
    const { live, rec, runs } = harness();
    live.spawn(spawnEvent(CHILD, "my-claw-app/thread/owner/thread-2"));
    expect(rec.calls.filter((call) => call.includes("appendSpawnStart"))).toEqual([]);
    expect(runs).toEqual([{ owner: "owner", threadId: CHILD_THREAD, active: true }]);
  });

  test("a run that released its bubble leaves no card behind", () => {
    const { live } = harness();
    const cards: string[] = [];
    const release = live.registerRun(PARENT, () => ({ appendSpawnStart: async () => cards.push("stale") } as unknown as MyClawAppStreamer));
    release();
    live.spawn(spawnEvent(CHILD, PARENT));
    expect(cards).toEqual([]);
  });
});
