/**
 * What each call spent thinking reaches the bubble it wrote into, and the log keeps it.
 *
 * The Responses API writes a summary for only part of its thoughts: the rest come back as a count
 * and nothing else, and a phase with neither words nor count was an empty step on screen
 * (2026-10-26, gpt-6.1-sol, 82 % of a day's phases) -- docs/reasoning-visibility.md.
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
import type { ReasoningCount } from "../../src/agent/backend.ts";

const SESSION_ID = "my-claw-app/thread/u1/reasoning-count";
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


/**
 * A stream that delivers one chunk per `gapMs`, so a span measured at arrival is not zero.
 *
 * Pull-based, not push-based: `start` on a ReadableStream begins filling the queue at
 * construction, so a `setTimeout` there can spend its whole delay before the consumer reads a
 * single byte -- and then every chunk arrives in one tick and the measured span is the price of a
 * scheduler tick, not the gap. This test read `16` instead of `150` about one run in six, on CI
 * as well as locally. `pull` enqueues only when the reader asks, so the gap lands between two
 * reads and the figure is real whatever the setup cost.
 */
function delayedStream(chunks: unknown[], gapMs: number): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Nothing waits before the first chunk: the gap is what a thought costs, and the thought
      // starts at the first byte.
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n`));
        return;
      }
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const usage = (reasoning: number) => ({ prompt_tokens: 10, completion_tokens: reasoning + 5, total_tokens: reasoning + 15, completion_tokens_details: { reasoning_tokens: reasoning } });

/** A call that thought without a word and asked for a tool, then one that thought aloud and answered. */
const silentToolThenAnswer = (): Response[] => [
  stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "probe", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: usage(300) },
  ]),
  stream([
    { choices: [{ delta: { reasoning_content: "the probe said ok" } }] },
    { choices: [{ delta: { content: "done" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: usage(40) },
  ]),
];

function toolsWithProbe(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "probe",
    description: "probe",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "ok" }),
  });
  return tools;
}

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

test("each call reports its count once, before its tools open their cards", async () => {
  const bridge = new AgentBridge(config, toolsWithProbe(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const replies = silentToolThenAnswer();
  const fetchMock = mockFetch(async () => replies.shift()! as never);
  const order: string[] = [];
  const counts: ReasoningCount[] = [];

  try {
    await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => { order.push("token"); },
      undefined,
      signal,
      undefined,
      undefined,
      {
        onText: async () => { order.push("thought"); },
        onCount: async (count) => {
          order.push(`count:${count.tokens}`);
          counts.push(count);
        },
      },
      async () => { order.push("tool"); },
    );
  } finally {
    fetchMock.restore();
    end();
  }

  assert.deepEqual(order, ["count:300", "tool", "thought", "token", "count:40"]);
});

/**
 * Every count carries the server's span, words or none.
 *
 * It used to travel only for a silent thought, on the argument that the client had timed the ones
 * it streamed. That argument is the defect: the app measures a wall clock across a socket, from the
 * frame that opens the phase to the first prose delta, while the server measures the same span where
 * the deltas arrive -- and its figure is the one the log stores and a reload shows. A phase read
 * `12 s` live and `4 s` after a refresh (owner, 2026-11-14: "le ms serveur c'est lui l'important").
 */
test("a count carries the span the server measured, and a thought aloud is timed too", async () => {
  const bridge = new AgentBridge(config, toolsWithProbe(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  // The span is measured where the deltas arrive, so a stream delivered in one tick measures zero
  // -- and a zero span is not a span. The gap here is what makes the figure real.
  const reply = delayedStream([
    { choices: [{ delta: { reasoning_content: "thinking about it" } }] },
    { choices: [{ delta: { content: "the answer" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: usage(40) },
  ], 150);
  const fetchMock = mockFetch(async () => reply as never);
  const counts: ReasoningCount[] = [];

  try {
    await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      { onCount: async (count) => { counts.push(count); } },
    );
  } finally {
    fetchMock.restore();
    end();
  }

  // The thought had words and the client timed them on screen: the server's figure goes anyway.
  assert.equal(counts.length, 1);
  const span = counts[0]!.ms;
  assert.equal(typeof span, "number");
  assert.ok(span! >= 25, `the span should cover the gap, got ${span}`);
});

test("the log keeps the count on the phase, so a reopened thread still shows the thought", async () => {
  const bridge = new AgentBridge(config, toolsWithProbe(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const replies = silentToolThenAnswer();
  const fetchMock = mockFetch(async () => replies.shift()! as never);

  try {
    await bridge.handleMessageStreaming(createMessage(), createSession(), async () => {}, undefined, signal);
  } finally {
    fetchMock.restore();
    end();
  }

  const phases = (await log.all()).filter((entry) => entry.type === "phase");
  assert.deepEqual(
    phases.map((phase) => ({ text: phase.text, reasoning: phase.reasoning, reasoningTokens: phase.reasoningTokens })),
    [
      { text: "", reasoning: undefined, reasoningTokens: 300 },
      { text: "done", reasoning: "the probe said ok", reasoningTokens: 40 },
    ],
  );
});

test("a sink that throws on the count does not take the run down", async () => {
  const bridge = new AgentBridge(config, toolsWithProbe(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const replies = silentToolThenAnswer();
  const fetchMock = mockFetch(async () => replies.shift()! as never);

  try {
    const out = await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      { onCount: async () => { throw new Error("socket gone"); } },
    );
    assert.equal(out, "done");
  } finally {
    fetchMock.restore();
    end();
  }
});
