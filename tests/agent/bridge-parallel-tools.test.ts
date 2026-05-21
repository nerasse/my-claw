import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
};

function createMessage(): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(): SessionData {
  return {
    id: "telegram/dm/u1",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "done" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const startTime = Date.now();
    const response = await bridge.handleMessage(createMessage(), session);
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(createMessage(), session);

    // Check session messages: tool results should be in tc1, tc2 order
    const toolMessages = session.messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.equal((toolMessages[0] as { toolCallId: string }).toolCallId, "tc1");
    assert.equal((toolMessages[1] as { toolCallId: string }).toolCallId, "tc2");
    assert.equal(toolMessages[0]!.content, "slow result");
    assert.equal(toolMessages[1]!.content, "fast result");
  } finally {
    fetchMock.restore();
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "done" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "done");
    assert.equal(callCount, 2);
    const toolMessages = session.messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 1);
  } finally {
    fetchMock.restore();
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "handled" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "handled");

    const toolMessages = session.messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.equal(toolMessages[0]!.content, "good result");
    assert.ok(toolMessages[1]!.content.includes("tool failed"));
  } finally {
    fetchMock.restore();
  }
});
