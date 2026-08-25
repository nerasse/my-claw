import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { saveSession, deleteSession, type SessionData } from "../../src/sessions/store.ts";
import type { SessionLog, ToolEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-truncated-tool-calls";

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
function createSession(): SessionData {
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await saveSession(SESSION_ID, createSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

// A turn cut off on `length` carries tool calls whose JSON arguments stop mid-value. A permissive
// parse "repairs" them into something shorter but valid, and the side effect goes through with a
// truncated payload. The calls must come back as errors instead.
test("bridge: tool calls from a turn cut off by the output limit are refused, not executed", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "write_thing",
    description: "writes",
    parameters: { type: "object", properties: { content: { type: "string" } } },
    async execute() {
      executions++;
      return { success: true, output: "written" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let call = 0;
  const fetchMock = mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: {
                content: "writing it now",
                tool_calls: [{ id: "tc1", function: { name: "write_thing", arguments: '{"content":"half of the fi' } }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok, reissuing smaller" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(createMessage(), session, signal);
    assert.equal(executions, 0, "the truncated call never reached the tool");
    await log.flush();
    const toolEntry = log.entries().find((e): e is ToolEntry => e.type === "tool" && e.callId === "tc1");
    assert.ok(toolEntry, "the model still gets a result for the call it made");
    assert.match(toolEntry.output, /cut off by the output limit/i);
  } finally {
    fetchMock.restore();
    end();
  }
});

test("bridge: the same call runs normally when the turn finished cleanly", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "write_thing",
    description: "writes",
    parameters: { type: "object", properties: { content: { type: "string" } } },
    async execute() {
      executions++;
      return { success: true, output: "written" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let call = 0;
  const fetchMock = mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: "", tool_calls: [{ id: "tc1", function: { name: "write_thing", arguments: '{"content":"all of it"}' } }] },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });

  try {
    await bridge.handleMessage(createMessage(), createSession(), signal);
    assert.equal(executions, 1);
  } finally {
    fetchMock.restore();
    end();
  }
});
