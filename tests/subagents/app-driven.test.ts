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
import { saveSession, deleteSession, loadSession, subagentSessionToThread, type SessionData } from "../../src/sessions/store.ts";
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

test("kill and reset from the app obey the same rule, and differ in what survives", async () => {
  const mine = "subagent/killable-c1d2";
  const theirs = "subagent/theirs-e3f4";
  await saveSession(mine, subSession(mine, { visibility: "private", parentSessionId: "my-claw-app/thread/owner/main" }));
  await saveSession(theirs, subSession(theirs, { visibility: "private", parentSessionId: "telegram/dm/someone" }));
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const owner = "my-claw-app/thread/owner/main";

  try {
    // Not reachable from this conversation: refused, and the file is still there.
    assert.match(await runner.kill(theirs, owner), /not found/);
    assert.ok(await loadSession(theirs), "a refused kill must not delete anything");

    // reset keeps the sub-agent and its identity, and empties the transcript.
    const before = await loadSession(mine);
    before!.messages.push({ role: "user", content: "remember this", timestamp: new Date().toISOString() });
    await saveSession(mine, before!);
    assert.match(await runner.reset(mine, owner), /reset/);
    const after = await loadSession(mine);
    assert.equal(after?.messages.length, 0);
    assert.equal(after?.meta?.displayName, "digger");
    assert.equal(after?.meta?.visibility, "private");

    // kill leaves nothing behind.
    assert.match(await runner.kill(mine, owner), /deleted/);
    assert.equal(await loadSession(mine), null);
  } finally {
    await deleteSession(mine).catch(() => {});
    await deleteSession(theirs).catch(() => {});
  }
});

/**
 * The caller the app declares on the frame is what the visibility rule is applied to. These four
 * cases are the whole rule: the one existing one, reached through this path too.
 */
test("the declared parent conversation is what authorizes a private sub-agent", async () => {
  const mine = "subagent/mine-b1c2";
  const other = "subagent/other-d3e4";
  const shared = "subagent/shared-f5a6";
  await saveSession(mine, subSession(mine, { visibility: "private", parentSessionId: "my-claw-app/thread/owner/main" }));
  await saveSession(other, subSession(other, { visibility: "private", parentSessionId: "telegram/dm/someone" }));
  await saveSession(shared, subSession(shared, { visibility: "global", parentSessionId: "telegram/dm/someone" }));

  const agent = trapBackend();
  const router = new MessageRouter(new SessionManager(), agent, config);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();

  // The wiring under test, mirroring index.ts: the frame's parentThreadId becomes the caller.
  router.onSubAgentSend(async (sessionId, message, options) => {
    const frame = message.raw as { parentThreadId?: unknown } | null;
    const claimed = typeof frame?.parentThreadId === "string" ? frame.parentThreadId : null;
    const caller = claimed ? `my-claw-app/thread/${message.chatId}/${claimed}` : "";
    return runner.send(sessionId, message.text, undefined, message, reg, caller, options.signal);
  });

  const ask = async (agentId: string, parentThreadId?: string): Promise<string> => {
    const msg = appMessage(subagentSessionToThread(agentId)!, "hi");
    msg.raw = { type: "chat.send", ...(parentThreadId ? { parentThreadId } : {}) };
    return (await router.route(msg))?.text ?? "";
  };

  const fetchMock = mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );
  try {
    // Its own conversation reaches it.
    assert.equal(await ask(mine, "main"), "ok");
    // Naming a different conversation does not, even though the owner is the same: a private
    // sub-agent stays scoped to the conversation that made it.
    assert.match(await ask(mine, "other-chat"), /not found/);
    // No declared parent is an unknown caller, and an unknown caller never reaches a private one.
    assert.match(await ask(mine), /not found/);
    // A private sub-agent of another platform is out of reach whatever is declared.
    assert.match(await ask(other, "main"), /not found/);
    // Globals were always drivable from anywhere, including with no parent declared.
    assert.equal(await ask(shared), "ok");
    assert.deepEqual(agent.calls, []);
  } finally {
    fetchMock.restore();
    await deleteSession(mine);
    await deleteSession(other);
    await deleteSession(shared);
  }
});


/**
 * Mid-run steering, the thing this whole path exists for: a message sent while the sub-agent is
 * already running goes into that run instead of the per-agent queue.
 */
test("a message sent while the sub-agent runs is injected, streamed, and switches the bubble", async () => {
  const id = "subagent/steerable-9a1b";
  await saveSession(id, subSession(id));
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const agent = trapBackend();
  const router = new MessageRouter(new SessionManager(), agent, config);
  const tokens: string[] = [];
  const switched: string[] = [];
  const bodies: Array<Array<{ role: string; content: string }>> = [];

  router.onSubAgentSend(async (sessionId, message, options) =>
    runner.send(sessionId, message.text, undefined, message, reg, "my-claw-app/thread/owner/main", options.signal, {
      onToken: options.onToken ?? (async () => {}),
      onToolUse: options.onToolUse,
      onTurnSwitch: options.onTurnSwitch ?? (async (m) => {
        switched.push(m.id);
      }),
    }),
  );

  // Synchronise on the event instead of sleeping: the injection must land while the first LLM
  // call is in flight, and a fixed delay cannot know when that is on a loaded runner.
  let markFirstCall: (() => void) | undefined;
  const firstCallStarted = new Promise<void>((resolve) => {
    markFirstCall = resolve;
  });
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean; messages?: Array<{ role: string; content: string }> };
    const userTexts = (asked.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);
    if (call++ === 0) {
      markFirstCall!();
      await gate;
      const parts = [{ choices: [{ delta: { content: "first answer " } }] }];
      const body = parts.map((p) => `data: ${JSON.stringify(p)}\n`).join("") + "data: [DONE]\n";
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
    }
    bodies.push(asked.messages ?? []);
    const parts = [{ choices: [{ delta: { content: "steered answer" } }] }];
    const body = parts.map((p) => `data: ${JSON.stringify(p)}\n`).join("") + "data: [DONE]\n";
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
  });

  try {
    const thread = subagentSessionToThread(id)!;
    // The real path always carries the sink: the channel builds it per message.
    const sink = {
      onToken: async (t: string) => {
        tokens.push(t);
      },
      onTurnSwitch: async (m: { id: string }) => {
        switched.push(m.id);
      },
    };
    const first = router.route({ ...appMessage(thread, "original"), id: "first-message" }, sink);
    await firstCallStarted;
    const secondPromise = router.route({ ...appMessage(thread, "steer now"), id: "steer-message" }, sink);
    // Let the run finish its held call: it will then find the injection waiting and continue,
    // which is what resolves both routes. Awaiting the injection before releasing the run would
    // deadlock the test, not the feature.
    releaseFirst!();
    const second = await secondPromise;
    // Injected, not queued: the route resolves without producing its own run.
    assert.equal(second, undefined);
    await first;

    assert.ok(tokens.join("").includes("first answer"), `tokens: ${JSON.stringify(tokens)}`);
    assert.ok(tokens.join("").includes("steered answer"), `tokens: ${JSON.stringify(tokens)}`);
    // The bubble switched to the injected message exactly once.
    assert.deepEqual(switched, ["steer-message"]);

    // The second call carried both the original task and the injected message: assertions live
    // here, not inside the mock, where a throw would make the provider retry into the same one.
    const secondUsers = bodies[0]!.filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(secondUsers.some((t) => t.includes("original")));
    assert.ok(secondUsers.some((t) => t.includes("steer now")));

    // Both turns are on disk: reopening the sub-agent shows the whole exchange.
    const session = await loadSession(id);
    const users = session!.messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(users.some((t) => t.includes("original")));
    assert.ok(users.some((t) => t.includes("steer now")));
  } finally {
    fetchMock.restore();
    await deleteSession(id);
  }
});

test("a message sent while the parent drives the sub-agent is absorbed by that run", async () => {
  const id = "subagent/parentbusy-c3d4";
  await saveSession(id, subSession(id));
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();

  let markFirstCall: (() => void) | undefined;
  const firstCallStarted = new Promise<void>((resolve) => {
    markFirstCall = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let call = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    if (call++ === 0) {
      markFirstCall!();
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: "parent answer" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never;
    }
    const userTexts = (asked.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(userTexts.some((t) => t.includes("steer now")));
    return new Response(JSON.stringify({ choices: [{ message: { content: "after the nudge" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });

  try {
    // The parent's spawn: non-streaming, no sink. Its run opens the mailbox by itself now.
    const spawned = runner.spawn({
      displayName: "parentbusy",
      type: "research",
      mode: "session",
      task: "original task",
      parentMessage: appMessage("main"),
      existingIds: await reg.listExistingIds(),
      generateId: () => id,
      parentSessionId: "my-claw-app/thread/owner/main",
      visibility: "global",
      enqueue: (i, t) => reg.enqueue(i, t),
    });
    // Wait for the run to actually start its first call: the mailbox is opened before it, so this
    // is the event that makes canInject deterministic instead of a fixed sleep.
    await firstCallStarted;
    assert.equal(runRegistry.canInject(id), true, "a parent-driven run must open the mailbox too");

    // What the router does with an app message arriving now.
    const injected = runRegistry.enqueueInjection(id, appMessage(subagentSessionToThread(id)!, "steer now"));
    assert.ok(injected);
    release!();
    await injected;
    const { result } = await spawned;

    assert.equal(result, "after the nudge");
    const session = await loadSession(id);
    assert.ok(session!.messages.some((m) => m.role === "user" && m.content.includes("steer now")));
    // The mailbox is gone with the run: a late arrival falls back to a queued send.
    assert.equal(runRegistry.canInject(id), false);
  } finally {
    fetchMock.restore();
    await deleteSession(id);
  }
});
