import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { saveSession, deleteSession, subagentSessionToThread, type SessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { AgentBackend } from "../../src/agent/backend.ts";

const config: MyClawConfig = {
  whitelist: ["owner"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: { research: { llm: { defaultModel: "research-model" } } },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);

function subSession(id: string, over: { visibility?: "global" | "private"; parentSessionId?: string } = {}): SessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    meta: {
      displayName: "digger",
      type: "research",
      parentSessionId: over.parentSessionId ?? "my-claw-app/thread/owner/main",
      visibility: over.visibility ?? "global",
      createdAt: new Date().toISOString(),
    },
  };
}

function appMessage(threadId: string, text = "how far are you?"): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "owner",
    chatId: "owner",
    chatType: "dm",
    threadId,
    text,
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

/** A backend that must never be reached for a sub-agent session. */
function trapBackend(): AgentBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    preprocessMessage: async () => {},
    getEchoMessages: () => [],
    getResponseAttachments: () => undefined,
    hadAudioInbound: () => false,
    transcriptsOf: () => [],
    setApprovalHandler: () => {},
    handleMessage: async (_m, session) => {
      calls.push(`handleMessage:${session.id}`);
      return "reached the normal path";
    },
    handleMessageStreaming: async (_m, session) => {
      calls.push(`handleMessageStreaming:${session.id}`);
      return "reached the normal path";
    },
  };
}

test("the router refuses to run a sub-agent session when no sender is wired", async () => {
  const id = "subagent/digger-a1b2";
  await saveSession(id, subSession(id));
  const agent = trapBackend();
  const router = new MessageRouter(new SessionManager(), agent, config);
  try {
    const out = await router.route(appMessage(subagentSessionToThread(id)!));
    assert.match(out?.text ?? "", /cannot be driven from here/);
    // The point of the guard: the normal engine, at depth 0 with the spawn tools, is never reached.
    assert.deepEqual(agent.calls, []);
  } finally {
    await deleteSession(id);
  }
});

test("a normal conversation still reaches the engine", async () => {
  const agent = trapBackend();
  const router = new MessageRouter(new SessionManager(), agent, config);
  const out = await router.route(appMessage("main"));
  assert.equal(out?.text, "reached the normal path");
  assert.deepEqual(agent.calls, ["handleMessage:my-claw-app/thread/owner/main"]);
});

test("a sub-agent thread is delegated to the sender, with the run stoppable while it lasts", async () => {
  const id = "subagent/digger-c3d4";
  await saveSession(id, subSession(id));
  const agent = trapBackend();
  const router = new MessageRouter(new SessionManager(), agent, config);
  let sawSignal: AbortSignal | undefined;
  let runningDuringSend = false;
  router.onSubAgentSend(async (sessionId, message, options) => {
    sawSignal = options.signal;
    runningDuringSend = runRegistry.isRunning(sessionId);
    return `answered ${sessionId} for "${message.text}"`;
  });
  try {
    const out = await router.route(appMessage(subagentSessionToThread(id)!, "status?"));
    assert.equal(out?.text, `answered ${id} for "status?"`);
    assert.deepEqual(agent.calls, []);
    assert.ok(sawSignal, "the sender must get a signal, or /stop cannot reach the sub-agent");
    // Registered while it runs so the app's Stop button lights up, and released afterwards.
    assert.equal(runningDuringSend, true);
    assert.equal(runRegistry.isRunning(id), false);
  } finally {
    await deleteSession(id);
  }
});

test("the app's sink reaches the sub-agent: tokens stream and the run is queued per agent", async () => {
  const id = "subagent/streamer-e5f6";
  await saveSession(id, subSession(id));
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const tokens: string[] = [];
  let order: string[] = [];

  // Answers in the shape the caller asked for: the first send streams, the queued one does not,
  // and that difference is the contract under test.
  const fetchMock = mockFetch(async (_input, init) => {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
    order.push(asked.stream ? "llm:stream" : "llm:plain");
    if (!asked.stream) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "second answer" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never;
    }
    const parts = [
      { choices: [{ delta: { content: "dug up " } }] },
      { choices: [{ delta: { content: "three things" } }] },
    ];
    const body = parts.map((p) => `data: ${JSON.stringify(p)}\n`).join("") + "data: [DONE]\n";
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
  });

  try {
    const first = runner.send(id, "go", undefined, appMessage("main"), reg, "my-claw-app/thread/owner/main", undefined, {
      onToken: async (t) => {
        tokens.push(t);
      },
    });
    // A second send while the first is in flight must wait for it: that is the per-agent queue,
    // and it is what stops two runs racing on one session file.
    const second = first.then(() => order.push("between")).then(() =>
      runner.send(id, "again", undefined, appMessage("main"), reg, "my-claw-app/thread/owner/main"),
    );
    const [a] = await Promise.all([first, second]);

    assert.equal(a, "dug up three things");
    assert.ok(tokens.join("").includes("dug up three things"), `no tokens streamed: ${JSON.stringify(tokens)}`);
    // The queued send only starts once the first has finished, and it asked for no stream.
    assert.deepEqual(order, ["llm:stream", "between", "llm:plain"]);
  } finally {
    fetchMock.restore();
    await deleteSession(id);
  }
});

test("a parent-driven send stays non-streaming", async () => {
  const id = "subagent/quiet-a7b8";
  await saveSession(id, subSession(id));
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never,
  );
  try {
    // No sink argument at all: this is what the `send` tool passes, and the contract that keeps
    // spawn/send from the model unchanged.
    const out = await runner.send(id, "go", undefined, appMessage("main"), reg, "my-claw-app/thread/owner/main");
    assert.equal(out, "done");
    const session = await Bun.file(`${process.env["MY_CLAW_DIR"]}/sessions/subagent/quiet-a7b8.json`).json();
    assert.equal(session.messages.at(-1).role, "assistant");
  } finally {
    fetchMock.restore();
    await deleteSession(id);
  }
});

test("a private sub-agent of another platform is not drivable, a global one is", async () => {
  // This mirrors the ownership rule wired in index.ts. Kept as a unit on isReachableFrom's
  // observable behaviour: a caller that is not the creator gets the same "not found" as a
  // non-existent agent (docs/subagent-visibility.md).
  const priv = "subagent/tg-private-b1c2";
  const glob = "subagent/tg-global-d3e4";
  await saveSession(priv, subSession(priv, { visibility: "private", parentSessionId: "telegram/dm/someone" }));
  await saveSession(glob, subSession(glob, { visibility: "global", parentSessionId: "telegram/dm/someone" }));
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never,
  );
  try {
    const refused = await runner.send(priv, "hi", undefined, appMessage("main"), reg, "my-claw-app/thread/owner/main");
    assert.match(refused, /not found/);
    const allowed = await runner.send(glob, "hi", undefined, appMessage("main"), reg, "my-claw-app/thread/owner/main");
    assert.equal(allowed, "ok");
  } finally {
    fetchMock.restore();
    await deleteSession(priv);
    await deleteSession(glob);
  }
});
