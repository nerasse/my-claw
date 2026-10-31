/**
 * The run survives its provider: the waits it owes, then another provider -- without replaying.
 *
 * This is the case that took a whole research pass down (2026-09-21). A sub-agent died on its
 * ninth call, its two siblings kept working, and nobody was left to finish the aggregator sweep
 * but the parent. The failure handling used to live in the dispatcher, which only serves routed
 * messages and could only replay a run from its first token: a sub-agent never saw it, and a run
 * that had already done work could not use it.
 *
 * It lives where the call is made now, so a failure *between* two calls costs the wait and nothing
 * else -- the messages, the tool results and the log are intact, and the run continues on another
 * provider.
 */

import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseResponse } from "../helpers/sse.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { openSessionLog } from "../../src/sessions/log.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const SESSION_ID = "test-provider-fallback";

function config(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      // Two plain OpenAI-compatible endpoints on purpose: an anthropic pin needs a subscription
      // token, and a model that cannot run at all would test the resolver, not the fallback.
      providers: {
        alpha: { baseUrl: "https://alpha.local/v1" },
        beta: { baseUrl: "https://beta.local/v1" },
      },
      models: [
        { id: "beta-1", label: "Beta", provider: "beta" },
        { id: "alpha-1", label: "Alpha", provider: "alpha" },
        { id: "alpha-2", label: "Alpha 2", provider: "alpha" },
      ],
      defaultProvider: "beta",
      defaultModel: "beta-1",
      // Milliseconds: the schedule has its own test, and thirty seconds of waiting proves nothing
      // the assertions do not.
      providerRetry: { delaysMs: [1] },
    },
    agents: {}, memory: { enabled: false },
  };
}

function createMessage(): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "go",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(modelOverride?: string): LegacySessionData {
  const now = new Date().toISOString();
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [], modelOverride };
}

/** The model each request asked for, in order: the whole story of a fallback. */
function modelOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
  return body.model ?? "unknown";
}

function failure(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * The non-streaming path reads a JSON body, the streaming one an SSE stream -- and the provider
 * layer retries a 503 three times on its own, which would blur every model sequence asserted
 * here. The failures below are therefore 402 (outage-class, never retried by the transport) or a
 * 400 (never retried either), so one call is one request.
 */
function jsonAnswer(text: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: { content: "", tool_calls: [{ id: `tc-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function answer(text: string): Response {
  return sseResponse(text);
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

async function run(
  bridge: AgentBridge,
  session: LegacySessionData,
  signal: AbortSignal,
  onToken?: (token: string) => Promise<void>,
): Promise<string> {
  return onToken
    ? bridge.handleMessageStreaming(createMessage(), session, onToken, undefined, signal)
    : bridge.handleMessage(createMessage(), session, signal);
}

test("a run on a failing provider waits, then finishes on the configured default", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    // The session's own choice fails twice: once, then once more after the wait.
    if (model === "alpha-1") return failure(402, "upstream unavailable");
    return jsonAnswer("fini sur le defaut");
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("alpha-1");

  try {
    const text = await run(bridge, session, signal);
    assert.match(text, /\[retry\] alpha-1/, text);
    assert.match(text, /trying again in 0s/, text);
    assert.match(text, /\[fallback\] alpha-1/, text);
    assert.match(text, /This run used beta-1 instead \(configured default\)/, text);
    assert.match(text, /fini sur le defaut/, text);
    // The same model once more after the wait, then the default: the schedule first, the target
    // second, and never the other way round.
    assert.deepEqual(models, ["alpha-1", "alpha-1", "beta-1"]);
    assert.equal(session.modelOverride, "alpha-1", "the session's own choice survives the run");
  } finally {
    end();
    mock.restore();
  }
});

test("a failure between two calls costs the wait, not the work: the run continues where it was", async () => {
  // The owner's case: a sub-agent that has already used its tools must not start over. Its tool
  // result is in the log and in the prompt, and the run picks up from there on another provider.
  const models: string[] = [];
  let call = 0;
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    call += 1;
    // First turn: a real tool call, answered by the session's own provider.
    if (call === 1) return toolCall("bash", { command: "echo hello" });
    // Then that provider falls: once, and once more after the wait.
    if (model === "alpha-1") return failure(402, "upstream unavailable");
    return jsonAnswer("termine sur le defaut");
  });
  const registry = new ToolRegistry();
  registry.register(bashTool);
  const bridge = new AgentBridge(config(), registry, new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    const text = await run(bridge, createSession("alpha-1"), signal);
    assert.match(text, /termine sur le defaut/, text);
    // alpha-1: the tool turn, then two failures (the second after the wait); beta-1: the answer.
    assert.deepEqual(models, ["alpha-1", "alpha-1", "alpha-1", "beta-1"]);
    const log = await openSessionLog(SESSION_ID);
    const bashCalls = log.entries().filter((entry) => entry.type === "tool" && entry.name === "bash");
    assert.equal(bashCalls.length, 1, "the tool ran once: a fallback continues the run, it does not replay it");
  } finally {
    end();
    mock.restore();
  }
});

test("a policy refusal is the provider's own, so the run moves on", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") {
      return failure(400, "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Content Exists Risk");
    }
    return jsonAnswer("passe par un autre provider");
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    const text = await run(bridge, createSession("alpha-1"), signal);
    assert.match(text, /\[fallback\]/, text);
    assert.match(text, /passe par un autre provider/, text);
    assert.deepEqual(models, ["alpha-1", "alpha-1", "beta-1"]);
  } finally {
    end();
    mock.restore();
  }
});

test("a 400 that names a shape we sent wrong is our bug and surfaces as itself", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    models.push(modelOf(init));
    return failure(400, '{"error":{"type":"invalid_request_error","message":"4 request validation errors: Input should be a valid string, field: \'messages[0].content.str\'"}}');
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    await assert.rejects(() => run(bridge, createSession("alpha-1"), signal), /validation errors/);
    assert.deepEqual(models, ["alpha-1"], "no reroute, no retry: the request is ours to fix");
  } finally {
    end();
    mock.restore();
  }
});

test("a failure after the call wrote something is not reroutable", async () => {
  // The text is on screen: replaying it on another provider would say it twice. The run fails
  // where it stands, and the owner keeps what they already read.
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    models.push(modelOf(init));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "moitie de ph" } }] })}\n\n`));
        // The delta has to be read before the failure lands: enqueuing and erroring in the same
        // tick reads as a stream that never said anything, which is a different test.
        setTimeout(() => controller.error(new Error("LLM stream request failed: HTTP 503 — upstream unavailable")), 20);
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const tokens: string[] = [];

  try {
    await assert.rejects(() => run(bridge, createSession("alpha-1"), signal, async (token) => void tokens.push(token)));
    assert.ok(tokens.join("").includes("moitie de ph"), tokens.join(""));
    assert.deepEqual(models, ["alpha-1"], "one call: nothing is retried once it has spoken");
  } finally {
    end();
    mock.restore();
  }
});

test("a route walks what is left of it, then the tag's global default", async () => {
  const cfg = config();
  cfg.tags = {
    Cheap: {
      // The route does not contain the global default on purpose: it is reached only because the
      // tag says `fallbackToGlobalDefault`, which is the branch this test is about.
      route: [{ model: "alpha-1" }, { model: "alpha-2" }],
      fallbackToGlobalDefault: true,
    },
  };
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "beta-1") return jsonAnswer("le defaut global");
    return failure(402, "upstream unavailable");
  });
  const bridge = new AgentBridge(cfg, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("tag:Cheap");

  try {
    const text = await run(bridge, session, signal);
    assert.match(text, /le defaut global/, text);
    assert.match(text, /\(Cheap route candidate 2\)/, text);
    assert.match(text, /\(Cheap global default\)/, text);
    assert.deepEqual(models, ["alpha-1", "alpha-1", "alpha-2", "beta-1"]);
    assert.equal(session.modelOverride, "tag:Cheap", "the tag stays the session's choice");
  } finally {
    end();
    mock.restore();
  }
});

test("a spent quota is not waited for: the run moves to the next model at once", async () => {
  // The veille of 2026-09-29: mimo's quota was exhausted, and each volet spent its three waits and
  // the transport's own backoff on it before moving on. No wait refills a quota.
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") return failure(429, "litellm.RateLimitError: Custom_openaiException - quota exhausted");
    return jsonAnswer("fini ailleurs");
  });
  const cfg = config();
  cfg.llm.providerRetry = { delaysMs: [60_000] };
  const bridge = new AgentBridge(cfg, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  try {
    const text = await run(bridge, createSession("alpha-1"), signal);
    assert.match(text, /fini ailleurs/, text);
    assert.doesNotMatch(text, /\[retry\]/, text);
    assert.match(text, /\[fallback\] alpha-1/, text);
    // One request to the spent model: neither the transport nor the run tried it again.
    assert.deepEqual(models, ["alpha-1", "beta-1"]);
  } finally {
    end();
    mock.restore();
  }
});

test("the owner's turn is written once, whatever the run went through", async () => {
  const mock = mockFetch(async (_input, init) => {
    if (modelOf(init) === "alpha-1") return failure(402, "upstream unavailable");
    return jsonAnswer("ok");
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    await run(bridge, createSession("alpha-1"), signal);
    const log = await openSessionLog(SESSION_ID);
    const users = log.entries().filter((entry) => entry.type === "user");
    assert.equal(users.length, 1, "a fallback continues the run, it does not start a second one");
  } finally {
    end();
    mock.restore();
  }
});

test("nothing left to try: the run fails as it is", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    models.push(modelOf(init));
    return failure(402, "upstream unavailable");
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    await assert.rejects(() => run(bridge, createSession("beta-1"), signal), /upstream unavailable/);
    // The run was already on its default: there is no target, so the schedule is all it gets.
    assert.deepEqual(models, ["beta-1", "beta-1"]);
  } finally {
    end();
    mock.restore();
  }
});

test("the streaming path announces the fallback as it happens", async () => {
  // The note reaches the reader twice on purpose: live, so the bubble says what is going on while
  // the run is still going, and in front of the answer, so the history says the same thing.
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") return failure(402, "upstream unavailable");
    return answer("la reponse");
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const tokens: string[] = [];

  try {
    const text = await run(bridge, createSession("alpha-1"), signal, async (token) => void tokens.push(token));
    assert.ok(tokens[0]!.startsWith("[retry]"), tokens.join(""));
    assert.ok(tokens.join("").includes("la reponse"), tokens.join(""));
    assert.ok(text.startsWith("[retry]"), text);
    assert.deepEqual(models, ["alpha-1", "alpha-1", "beta-1"]);
  } finally {
    end();
    mock.restore();
  }
});

/**
 * The conversation's tag survives the hand-off to the bridge.
 *
 * Measured 2026-10-27 on `tag:CubeFlowSol` (two ChatGPT subscriptions): `chatgpt-2` hit its plan
 * limit, and the run answered on `Medium route candidate 1` -- `synthetic` -- while the tag's own
 * second account was answering fine. The dispatcher hands the bridge the concrete winner as a
 * forced model (`dispatcher.ts`, `resolved.route ? resolved.model : undefined`), a forced model
 * resolves to no tag, so `RunModel.route` was `undefined` and the walk fell through to the agent's
 * default. Eight runs that day, all of them, out of a route they had never left.
 */
test("a run forced onto its tag's first candidate still walks that tag", async () => {
  const cfg = config();
  cfg.tags = {
    TwoAccounts: { route: [{ model: "alpha-1" }, { model: "alpha-2" }], fallbackToGlobalDefault: false },
  };
  cfg.agents = { orchestrator: { llm: { defaultModel: "tag:Cheap" } } };
  cfg.tags["Cheap"] = { route: [{ model: "beta-1" }], fallbackToGlobalDefault: true };

  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") return failure(429, "usage limit exceeded");
    return jsonAnswer("le deuxieme compte");
  });
  const bridge = new AgentBridge(cfg, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    // Exactly what the dispatcher does: the concrete candidate, plus the session's own tag pick.
    const text = await bridge.handleMessage(createMessage(), createSession("tag:TwoAccounts"), signal, "alpha-1");
    assert.match(text, /le deuxieme compte/, text);
    assert.match(text, /\(TwoAccounts route candidate 2\)/, text);
    assert.deepEqual(models, ["alpha-1", "alpha-2"], "the tag's second account, never the default");
    assert.doesNotMatch(text, /beta-1/, "the agent default is not the answer to an exhausted route");
  } finally {
    end();
    mock.restore();
  }
});

/**
 * A plan limit costs one request, not twelve.
 *
 * Measured 2026-10-27, run `5602d4f5` on `chatgpt-2`: each of the four turns made three requests
 * (the transport's own backoff), then the run waited 30 s, 60 s and 120 s on top. Twelve requests
 * and 210 seconds for a wall that does not open inside a run -- the second account answered all
 * along, and the tag was not consulted because the route had been lost (test above).
 *
 * The 429 body here is the real one, so this also pins that `isQuotaSpent` reads it.
 */
test("a spent plan limit gets one request, no wait, and the next account", async () => {
  const cfg = config();
  cfg.tags = { TwoAccounts: { route: [{ model: "alpha-1" }, { model: "alpha-2" }] } };
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") {
      return failure(429, '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus"}}');
    }
    return jsonAnswer("le deuxieme compte");
  });
  const bridge = new AgentBridge(cfg, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    const text = await bridge.handleMessage(createMessage(), createSession("tag:TwoAccounts"), signal, "alpha-1");
    assert.match(text, /le deuxieme compte/, text);
    assert.doesNotMatch(text, /\[retry\]/, "nothing is waited for: no wait refills a plan");
    assert.match(text, /\[fallback\]/, text);
    // One request to the exhausted account -- the transport's three attempts are gone too.
    assert.deepEqual(models, ["alpha-1", "alpha-2"]);
  } finally {
    end();
    mock.restore();
  }
});

/**
 * Anthropic's wall has no phrase of its own, and neither does any provider that answers a full
 * bar with the same words it uses for a burst: `{"type":"rate_limit_error","message":"This
 * request would exceed your account's rate limit."}`. Measured 2026-10-31 in a career session on
 * `claude-2`: its five-hour bar read 100 % with a reset twenty-two minutes out, and the run still
 * spent three transport retries and 30 s + 60 s + 120 s of waits before moving on.
 *
 * The provider here is a Synthetic one, because it publishes a usage endpoint the test can stub
 * and the shape is the point: the refusal says "rate limit", the oracle says "the week is full".
 * One request to the refusing model, no wait, then the next account -- and the note names the bar
 * rather than the provider's own misleading sentence.
 */
function walledConfig(): MyClawConfig {
  const cfg = config();
  cfg.llm = {
    ...cfg.llm!,
    providers: {
      quenched: { baseUrl: "https://api.synthetic.new/openai/v1", apiKeyEnv: "SYNTHETIC_KEY_FOR_TEST" },
      beta: { baseUrl: "https://beta.local/v1" },
    },
    models: [
      { id: "quenched-1", label: "Quenched", provider: "quenched" },
      { id: "beta-1", label: "Beta", provider: "beta" },
    ],
    defaultProvider: "beta",
    defaultModel: "beta-1",
    providerRetry: { delaysMs: [1] },
  };
  cfg.tags = { Quenched: { route: [{ model: "quenched-1" }, { model: "beta-1" }] } };
  return cfg;
}

const SYNTHETIC_SPENT = {
  planWeeklyLimit: { percentRemaining: 0, nextRegenAt: "2026-11-04T09:43:54.000Z", nextRegenPercent: 2 },
};

test("a bare rate_limit_error on a full bar skips the waits, the retries, and names the bar", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  const models: string[] = [];
  const mock = mockFetch(async (input, init) => {
    if (String(input).includes("/v2/quotas")) {
      return new Response(JSON.stringify(SYNTHETIC_SPENT), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const model = modelOf(init);
    models.push(model);
    if (model === "quenched-1") {
      return failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}');
    }
    return jsonAnswer("le deuxieme compte");
  });
  const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    const text = await bridge.handleMessage(createMessage(), createSession("tag:Quenched"), signal, "quenched-1");
    assert.match(text, /le deuxieme compte/, text);
    // The schedule is not spent on a bar that does not move, and the transport's own three
    // attempts are gone with it: this is the "twelve requests and 210 seconds" case.
    assert.doesNotMatch(text, /\[retry\]/, "no wait on a confirmed wall");
    // The bar is named, not the provider's misleading sentence: the note reads the oracle.
    assert.match(text, /\[quota\] quenched-1 is out of its week allowance \(Week at 100%\)/, text);
    // One request to the refusing model: the transport's three attempts are gone with the waits.
    assert.deepEqual(models, ["quenched-1", "beta-1"]);
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * The owner's decision outranks the run's: a conversation told to wait out its wall waits, even
 * when another model could answer this second. Anything else makes the switch a guess.
 */
test("a conversation set to wait stops on a confirmed wall instead of falling back", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  const models: string[] = [];
  const mock = mockFetch(async (input, init) => {
    if (String(input).includes("/v2/quotas")) {
      return new Response(JSON.stringify(SYNTHETIC_SPENT), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const model = modelOf(init);
    models.push(model);
    if (model === "quenched-1") {
      return failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}');
    }
    return jsonAnswer("ne doit pas arriver");
  });
  const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("tag:Quenched");
  session.quotaRetry = { enabled: true };

  try {
    const outcome = await bridge
      .handleMessage(createMessage(), session, signal, "quenched-1")
      .then((text) => ({ text }))
      .catch((err: unknown) => ({ error: err }));
    // Either the run dies with the failure (which arms the wait in the adapter) or it refuses to
    // move; what it must never do is answer on the other account.
    if ("text" in outcome) assert.doesNotMatch(outcome.text, /ne doit pas arriver/);
    assert.ok(!models.includes("beta-1"), `the run must not leave its model, saw ${models.join(", ")}`);
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});
