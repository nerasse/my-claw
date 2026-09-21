import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseResponse } from "../helpers/sse.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, ToolEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-parallel-tools";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(): LegacySessionData {
  return {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
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

test("parallel tool calls: multiple tools run concurrently", async () => {
  const executionLog: Array<{ tool: string; event: "start" | "end"; time: number }> = [];
  const registry = new ToolRegistry();

  registry.register({
    name: "slow_a",
    description: "slow tool A",
    parameters: {},
    async execute() {
      executionLog.push({ tool: "slow_a", event: "start", time: Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      executionLog.push({ tool: "slow_a", event: "end", time: Date.now() });
      return { success: true, output: "a done" };
    },
  });

  registry.register({
    name: "slow_b",
    description: "slow tool B",
    parameters: {},
    async execute() {
      executionLog.push({ tool: "slow_b", event: "start", time: Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      executionLog.push({ tool: "slow_b", event: "end", time: Date.now() });
      return { success: true, output: "b done" };
    },
  });

  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [
                { id: "tc1", function: { name: "slow_a", arguments: "{}" } },
                { id: "tc2", function: { name: "slow_b", arguments: "{}" } },
              ],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const startTime = Date.now();
    const response = await bridge.handleMessage(createMessage(), session, signal);
    const totalMs = Date.now() - startTime;

    assert.equal(response, "done");
    assert.equal(callCount, 2);

    // Both tools should have started before either finished (parallel)
    const starts = executionLog.filter((e) => e.event === "start");
    const ends = executionLog.filter((e) => e.event === "end");
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);

    // In parallel: both start before any end
    const latestStart = Math.max(...starts.map((s) => s.time));
    const earliestEnd = Math.min(...ends.map((e) => e.time));
    assert.ok(latestStart <= earliestEnd, "Both tools should start before either finishes (parallel execution)");
  } finally {
    fetchMock.restore();
    end();
  }
});

test("parallel tool calls: results are in correct order", async () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "fast",
    description: "fast tool",
    parameters: {},
    async execute() {
      return { success: true, output: "fast result" };
    },
  });

  registry.register({
    name: "slow",
    description: "slow tool",
    parameters: {},
    async execute() {
      await new Promise((r) => setTimeout(r, 30));
      return { success: true, output: "slow result" };
    },
  });

  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      // slow is first, fast is second — results must match tool_call order
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [
                { id: "tc1", function: { name: "slow", arguments: "{}" } },
                { id: "tc2", function: { name: "fast", arguments: "{}" } },
              ],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(createMessage(), session, signal);

    // Check log entries: tool results should be in tc1, tc2 order
    await log.flush();
    const toolEntries = log.entries().filter((e): e is ToolEntry => e.type === "tool");
    assert.equal(toolEntries.length, 2);
    assert.equal(toolEntries[0]!.callId, "tc1");
    assert.equal(toolEntries[1]!.callId, "tc2");
    assert.equal(toolEntries[0]!.output, "slow result");
    assert.equal(toolEntries[1]!.output, "fast result");
  } finally {
    fetchMock.restore();
    end();
  }
});

test("parallel tool calls: a fast tool settles while a slow one is still running", async () => {
  // What the owner saw: three one-second searches beside a five-minute browser sub-agent, every
  // card spinning for 1m41s with an empty output. The batch was one flush, so the slowest tool
  // held its siblings' cards -- and their timer measured the wait, not the work (2026-09-16).
  const registry = new ToolRegistry();
  let slowEnd = 0;
  registry.register({
    name: "slow",
    description: "slow tool",
    parameters: {},
    async execute() {
      await new Promise((r) => setTimeout(r, 80));
      slowEnd = Date.now();
      return { success: true, output: "slow result" };
    },
  });
  registry.register({
    name: "fast",
    description: "fast tool",
    parameters: {},
    async execute() {
      return { success: true, output: "fast result" };
    },
  });

  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      // Streaming, because this test drives the streaming entry point: the path that carries
      // onToolUse is the one the channel uses, so the frames have to be shapes it can read.
      const frames = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "slow", arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "tc2", function: { name: "fast", arguments: "{}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as never;
    }
    return sseResponse("done") as never;
  });

  const flushed: Array<{ name: string; output: string; at: number }> = [];
  try {
    const session = createSession();
    const response = await bridge.handleMessageStreaming(
      createMessage(),
      session,
      async () => {},
      async (tools) => {
        for (const tool of tools) flushed.push({ name: tool.name, output: tool.output ?? "", at: Date.now() });
      },
      signal,
    );
    assert.equal(response, "done");

    // One card per tool, and the fast one left before the slow one was back.
    assert.equal(flushed.length, 2);
    const fast = flushed.find((f) => f.name === "fast")!;
    const slow = flushed.find((f) => f.name === "slow")!;
    assert.equal(fast.output, "fast result");
    assert.ok(fast.at < slowEnd, "the fast card settled while the slow tool was still running");
    assert.ok(slow.at >= slowEnd);

    // The order the log reads in is still the order the model asked in: the prompt depends on it,
    // and a replay should read like the request.
    await log.flush();
    const toolEntries = log.entries().filter((e): e is ToolEntry => e.type === "tool");
    assert.deepEqual(toolEntries.map((e) => e.callId), ["tc1", "tc2"]);
    assert.deepEqual(toolEntries.map((e) => e.output), ["slow result", "fast result"]);
  } finally {
    fetchMock.restore();
    end();
  }
});

test("parallel tool calls: single tool call still works (no Promise.all)", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "demo",
    description: "demo",
    parameters: {},
    async execute() {
      return { success: true, output: "ok" };
    },
  });
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "demo", arguments: "{}" } }],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session, signal);
    assert.equal(response, "done");
    assert.equal(callCount, 2);
    await log.flush();
    const toolEntries = log.entries().filter((e): e is ToolEntry => e.type === "tool");
    assert.equal(toolEntries.length, 1);
  } finally {
    fetchMock.restore();
    end();
  }
});

test("parallel tool calls: one failure does not block others", async () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "good",
    description: "good tool",
    parameters: {},
    async execute() {
      return { success: true, output: "good result" };
    },
  });

  registry.register({
    name: "bad",
    description: "bad tool",
    parameters: {},
    async execute() {
      return { success: false, output: "", error: "tool failed" };
    },
  });

  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [
                { id: "tc1", function: { name: "good", arguments: "{}" } },
                { id: "tc2", function: { name: "bad", arguments: "{}" } },
              ],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "handled" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session, signal);
    assert.equal(response, "handled");

    await log.flush();
    const toolEntries = log.entries().filter((e): e is ToolEntry => e.type === "tool");
    assert.equal(toolEntries.length, 2);
    assert.equal(toolEntries[0]!.output, "good result");
    assert.ok(toolEntries[1]!.output.includes("tool failed"));
  } finally {
    fetchMock.restore();
    end();
  }
});

test("a batch is waited for in full: a run that ends leaves none of its own calls in flight", async () => {
  // `Promise.all` settled on the first rejection and abandoned the rest of the batch. Measured
  // 2026-09-21: two sub-agents of the same batch ran 5 and 9 minutes past their parent's end and
  // wrote into its log after `run_end` (which then needed a dead-branch repair). The batch is now
  // waited for in full, so what a run started is over before the run is.
  let unstoppableFinished = false;
  const registry = new ToolRegistry();

  // The stop is issued from inside the batch, which is where it lands in the real thing: the run
  // is stopped while its calls are in flight, not before the first turn.
  registry.register({
    name: "honours_stop",
    description: "rejects as soon as the run is stopped",
    parameters: {},
    async execute(args) {
      const signal = args["__signal"] as AbortSignal;
      runRegistry.stop(SESSION_ID);
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      throw new AbortedError();
    },
  });

  registry.register({
    name: "ignores_stop",
    description: "ploughs on whatever the signal says",
    parameters: {},
    async execute() {
      await new Promise((r) => setTimeout(r, 150));
      unstoppableFinished = true;
      return { success: true, output: "done anyway" };
    },
  });

  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [
              { id: "tc1", function: { name: "honours_stop", arguments: "{}" } },
              { id: "tc2", function: { name: "ignores_stop", arguments: "{}" } },
            ],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    // The first call rejects at once (its own stop), the second only finishes 150ms later.
    const call = bridge.handleMessage(createMessage(), createSession(), signal);
    await assert.rejects(() => call);
    assert.equal(
      unstoppableFinished,
      true,
      "the abandoned call must have landed before the run did",
    );
  } finally {
    end();
    fetchMock.restore();
  }
}, 30_000);
