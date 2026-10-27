/**
 * How long a call took to put its first thing on screen, measured once server-side.
 *
 * The device could time it from the frames it receives, and that is exactly the wrong clock: the
 * queue, the socket and the app's own scheduling all sit between the provider and the pixel, and a
 * thread reopened an hour later has to show the same figure as the one that was live. So the bridge
 * times it where the call starts and where its first delta lands, and the log keeps it on the
 * phase -- docs/reasoning-visibility.md.
 */
import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog } from "../../src/sessions/log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const SESSION_ID = "my-claw-app/thread/u1/first-output";
const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function createSession(): LegacySessionData {
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

function stream(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`).join("") + "data: [DONE]\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A call that answers straight away, with no thought at all: the wait is the only figure. */
const plainAnswer = (): Response =>
  stream([
    { choices: [{ delta: { content: "done" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);

/** A call that thinks out loud first: the wait ends at the first word of reasoning, not the answer. */
const thoughtsThenAnswer = (): Response =>
  stream([
    { choices: [{ delta: { reasoning_content: "weighing" } }] },
    { choices: [{ delta: { content: "done" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

test("a call reports how long it waited before its first word, once", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const fetchMock = mockFetch(async () => plainAnswer() as never);
  const waits: number[] = [];

  try {
    await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      { onFirstOutput: async (ms) => { waits.push(ms); } },
    );
  } finally {
    fetchMock.restore();
    end();
  }

  assert.equal(waits.length, 1);
  assert.ok(Number.isFinite(waits[0]!) && waits[0]! >= 0, `expected a finite span, got ${waits[0]}`);
});

test("the wait ends at the first word of reasoning, not at the answer", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const fetchMock = mockFetch(async () => thoughtsThenAnswer() as never);
  const waits: number[] = [];
  const order: string[] = [];

  try {
    await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      {
        onText: async () => { order.push("thought"); },
        onFirstOutput: async (ms) => { order.push("wait"); waits.push(ms); },
      },
    );
  } finally {
    fetchMock.restore();
    end();
  }

  // Reported after the thought, because the thought is what ended the wait.
  assert.deepEqual(order, ["thought", "wait"]);
  assert.equal(waits.length, 1);
});

test("the log keeps the wait on the phase, so a reopened thread shows it", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const fetchMock = mockFetch(async () => plainAnswer() as never);

  try {
    await bridge.handleMessageStreaming(createMessage(), createSession(), async () => {}, undefined, signal);
  } finally {
    fetchMock.restore();
    end();
  }

  const [phase] = log.entries().filter((entry) => entry.type === "phase");
  assert.ok(phase && phase.type === "phase");
  assert.ok(phase.waitMs !== undefined, "the phase should carry the wait");
  assert.ok(phase.waitMs! >= 0);
});

test("a sink that throws on the wait does not take the run down", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const fetchMock = mockFetch(async () => plainAnswer() as never);

  try {
    const out = await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      { onFirstOutput: async () => { throw new Error("socket gone"); } },
    );
    assert.equal(out, "done");
  } finally {
    fetchMock.restore();
    end();
  }
});

test("a call that answers with nothing at all still reports its wait", async () => {
  // An empty turn is retried, and the retry answers: what the reader waited through is both calls,
  // so the figure the surviving call reports has to cover them. What matters here is that one is
  // reported at all -- a call that produced nothing is exactly where the wait is all there is.
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  let calls = 0;
  const fetchMock = mockFetch(async () => {
    calls += 1;
    return (calls === 1 ? stream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]) : plainAnswer()) as never;
  });
  const waits: number[] = [];

  try {
    await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      { onFirstOutput: async (ms) => { waits.push(ms); } },
    );
  } finally {
    fetchMock.restore();
    end();
  }

  assert.ok(waits.length >= 1);
});
