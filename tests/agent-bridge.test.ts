import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { setupSessionLog } from "./helpers/session-log.ts";
import { AgentBridge } from "../src/agent/bridge.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import type { SessionLog } from "../src/sessions/log.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";
import type { LegacySessionData } from "../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
};

function createMessage(): UnifiedMessage {
  return {
    id: "m1",
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

const SESSION_ID = "test-bridge";

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

let sharedLog: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  const setup = await setupSessionLog(SESSION_ID);
  sharedLog = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
});

test("AgentBridge returns plain LLM response", async () => {
  const registry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi back" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "hi back");
    // Verify the log has the entries (1 user + 1 phase = 2 prompt entries)
    await sharedLog.flush();
    const entries = sharedLog.entries();
    assert.equal(entries.filter(e => e.prompt).length, 2);
    assert.equal(entries[0]!.type, "user");
    assert.equal(entries[1]!.type, "phase");
  } finally {
    fetchMock.restore();
  }
});

test("AgentBridge executes tool calls and supports model override", async () => {
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
  const seenModels: string[] = [];
  let callCount = 0;

  const fetchMock = mockFetch(async (_input?: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    seenModels.push(body.model ?? "");

    if (callCount++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc1",
                    function: { name: "demo", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "done" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    session.modelOverride = "override-model";
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "done");
    assert.deepEqual(seenModels, ["override-model", "override-model"]);
    // Verify tool entry exists in the log
    await sharedLog.flush();
    const entries = sharedLog.entries();
    assert.equal(entries.some(e => e.type === "tool"), true);
  } finally {
    fetchMock.restore();
  }
});

test("AgentBridge includes reply thread and attachment context in user content", async () => {
  const registry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const bridge = new AgentBridge(config, registry, skillRegistry);
  let capturedBody = "";

  const fetchMock = mockFetch(async (_input?: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(
      {
        ...createMessage(),
        platform: "my-claw-app",
        replyToId: "$reply",
        replyToSender: "@alice:example.org",
        replyToText: "quoted text",
        threadId: "$thread-root",
        threadRootText: "Matrix thread root from @alice:example.org:\nthread start",
        roomContext: "[Recent Room Context]\n@bob:example.org: earlier line",
        attachments: [
          {
            type: "image",
            path: "/tmp/test.png",
            mimeType: "image/png",
            filename: "test.png",
            sizeBytes: 123,
            width: 50,
            height: 40,
          },
        ],
      },
      session,
    );

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const userMessage = parsed.messages.find((message) => message.role === "user");
    assert.ok(userMessage?.content.includes("[Reply from @alice:example.org]"));
    assert.ok(userMessage?.content.includes("[Thread Root]"));
    assert.ok(userMessage?.content.includes("[Recent Room Context]"));
    assert.ok(userMessage?.content.includes("[Attachments]"));
    assert.ok(userMessage?.content.includes("123 bytes"));
  } finally {
    fetchMock.restore();
  }
});
