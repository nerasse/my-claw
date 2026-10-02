/**
 * The hook a channel hangs its "the model is working" line on.
 *
 * `llm:call:start` carried no session, so a channel could not address what it draws about the
 * call: the app's line for the wait before a first token has to reach the thread that is waiting
 * (2026-09-30).
 */
import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { hooks } from "../../src/hooks/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const SESSION_ID = "my-claw-app/thread/u1/call-start";
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

let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  cleanupLog = (await setupSessionLog(SESSION_ID)).cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

test("every model call of a streamed run is announced on the run's own sink, before its first token", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const order: string[] = [];

  const fetchMock = mockFetch(async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\ndata: [DONE]\n`;
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
  });

  try {
    await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => { order.push("token"); },
      undefined,
      signal,
      undefined,
      undefined,
      { onCallStart: async () => { order.push("call"); } },
    );
    assert.deepEqual(order.slice(0, 2), ["call", "token"]);
    assert.equal(order.filter((step) => step === "call").length, 1);
  } finally {
    fetchMock.restore();
    end();
  }
});

test("a sink that throws on the announcement does not take the run down", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const fetchMock = mockFetch(async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\ndata: [DONE]\n`;
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
  });
  try {
    const out = await bridge.handleMessageStreaming(
      createMessage(),
      createSession(),
      async () => {},
      undefined,
      signal,
      undefined,
      undefined,
      { onCallStart: async () => { throw new Error("socket gone"); } },
    );
    assert.equal(out, "done");
  } finally {
    fetchMock.restore();
    end();
  }
});

test("a model call announces the session it belongs to", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const seen: Array<{ sessionId: string; model: string }> = [];
  const onStart = (payload: { sessionId: string; model: string }): void => {
    seen.push({ sessionId: payload.sessionId, model: payload.model });
  };
  hooks.on("llm:call:start", onStart);

  const fetchMock = mockFetch(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never,
  );

  try {
    await bridge.handleMessage(createMessage(), createSession(), signal);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.sessionId, SESSION_ID);
    assert.equal(seen[0]!.model, "base-model");
  } finally {
    hooks.off("llm:call:start", onStart);
    fetchMock.restore();
    end();
  }
});
