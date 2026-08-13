import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { getSessionModelUsage } from "../../src/analytics/usage-db.ts";
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

function createMessage(text = "hello"): UnifiedMessage {
  return {
    id: `m-${Date.now()}`,
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text,
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

test("E2E: simple response records usage in session.tokenUsage", async () => {
  const registry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi back" } }],
        usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "hi back");

    // Session has usage accumulated
    assert.ok(session.tokenUsage);
    assert.equal(session.tokenUsage!.promptTokens, 150);
    assert.equal(session.tokenUsage!.completionTokens, 30);
    assert.equal(session.tokenUsage!.totalTokens, 180);
    assert.equal(session.tokenUsage!.apiCalls, 1);
  } finally {
    fetchMock.restore();
  }
});

test("E2E: tool call loop accumulates usage from multiple API calls", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "demo",
    description: "demo tool",
    parameters: {},
    async execute() {
      return { success: true, output: "tool ok" };
    },
  });
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      // First call: tool call
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "demo", arguments: "{}" } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    // Second call: final response
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "done" } }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "done");
    assert.equal(callCount, 2);

    // Usage accumulated from both API calls
    assert.ok(session.tokenUsage);
    assert.equal(session.tokenUsage!.promptTokens, 300); // 100 + 200
    assert.equal(session.tokenUsage!.completionTokens, 60); // 20 + 40
    assert.equal(session.tokenUsage!.totalTokens, 360); // 120 + 240
    assert.equal(session.tokenUsage!.apiCalls, 2);
  } finally {
    fetchMock.restore();
  }
});

test("E2E: usage persists across multiple messages in same session", async () => {
  const registry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const session = createSession();

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    await bridge.handleMessage(createMessage("msg1"), session);
    await bridge.handleMessage(createMessage("msg2"), session);
    await bridge.handleMessage(createMessage("msg3"), session);

    assert.ok(session.tokenUsage);
    assert.equal(session.tokenUsage!.promptTokens, 150); // 50 * 3
    assert.equal(session.tokenUsage!.completionTokens, 30); // 10 * 3
    assert.equal(session.tokenUsage!.apiCalls, 3);
  } finally {
    fetchMock.restore();
  }
});

test("E2E: no crash when provider returns no usage", async () => {
  const registry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        // no usage field
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "hello");
    // tokenUsage should be undefined — not initialized since no usage was returned
    assert.equal(session.tokenUsage, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("E2E: a run through a tag records the model actually called, not the tag id", async () => {
  const registry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const tagged: MyClawConfig = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: {
      provider: "x",
      baseUrl: "https://example.com",
      model: "test-model",
      tags: { zsmart: { model: "deep-model" } },
    },
    agents: {},
  };
  const bridge = new AgentBridge(tagged, registry, skillRegistry);

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi back" } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const session = createSession();
    session.id = "telegram/dm/tag-run";
    session.modelOverride = "tag:zsmart";
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "hi back");

    // The row snapshots the run-time model, so a later tag edit never rewrites the history.
    const rows = getSessionModelUsage(session.id, "own");
    assert.ok(rows.some((r) => r.model === "deep-model"));
    assert.ok(!rows.some((r) => r.model.includes("tag:")));
  } finally {
    fetchMock.restore();
  }
});
