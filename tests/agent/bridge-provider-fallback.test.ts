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
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { hooks } from "../../src/hooks/index.ts";
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

/**
 * The provider notes a run owes the reader, in order.
 *
 * They used to ride the token stream, which made them paragraphs of the answer: a run that retried
 * twice and then fell back painted three of them above the reply, and a reload showed the answer
 * alone. They are notices now -- drawn apart, and never part of what the model wrote.
 */
let notices: string[] = [];
const collectNotice = (event: { note: string }): void => { notices.push(event.note); };

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  cleanupLog = (await setupSessionLog(SESSION_ID)).cleanup;
  notices = [];
  hooks.on("provider:notice", collectNotice);
});

afterEach(() => {
  cleanupLog();
  hooks.off("provider:notice", collectNotice);
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
    assert.match(notices.join("\n"), /\[retry\] alpha-1/, notices.join("\n"));
    assert.match(notices.join("\n"), /trying again in 0s/, notices.join("\n"));
    assert.match(notices.join("\n"), /\[fallback\] alpha-1/, notices.join("\n"));
    assert.match(notices.join("\n"), /This run used beta-1 instead \(configured default\)/, notices.join("\n"));
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
    // The run's own handle, not a second one opened from disk: an append is fire-and-forget, and a
    // fresh handle can read the file before the tool entry lands. That raced under CI load on
    // 2026-11-12 -- the tool had run (the run's log says so) and this read saw 0 of it.
    const log = await sessionLogOf(SESSION_ID);
    await log.flush();
    const bashCalls = (await log.all()).filter((entry) => entry.type === "tool" && entry.name === "bash");
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
    assert.match(notices.join("\n"), /\[fallback\]/, notices.join("\n"));
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
    // Which candidate answered is a provider note now, not the answer's own line.
    assert.match(notices.join("\n"), /\(Cheap route candidate 2\)/, notices.join("\n"));
    assert.match(notices.join("\n"), /\(Cheap global default\)/, notices.join("\n"));
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
    assert.doesNotMatch(notices.join("\n"), /\[retry\]/, notices.join("\n"));
    assert.match(notices.join("\n"), /\[fallback\] alpha-1/, notices.join("\n"));
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
    const log = await sessionLogOf(SESSION_ID);
    await log.flush();
    const users = (await log.all()).filter((entry) => entry.type === "user");
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
    // The retry is a notice now: the answer stream carries the answer and nothing else.
    assert.ok(tokens.join("").includes("la reponse"), tokens.join(""));
    assert.ok(!tokens[0]!.startsWith("[retry]"), tokens.join(""));
    assert.match(notices[0] ?? "", /^\[retry\]/, notices.join(""));
    assert.ok(!text.startsWith("[retry]"), text);
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
    assert.match(notices.join("\n"), /\(TwoAccounts route candidate 2\)/, notices.join("\n"));
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
    assert.doesNotMatch(notices.join("\n"), /\[retry\]/, "nothing is waited for: no wait refills a plan");
    assert.match(notices.join("\n"), /\[fallback\]/, notices.join("\n"));
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
    assert.doesNotMatch(notices.join("\n"), /\[retry\]/, "no wait on a confirmed wall");
    // The bar is named, not the provider's misleading sentence: the note reads the oracle.
    assert.match(notices.join("\n"), /\[quota\] quenched-1 is out of its week allowance \(Week at 100%\)/, notices.join("\n"));
    // One request to the refusing model: the transport's three attempts are gone with the waits.
    assert.deepEqual(models, ["quenched-1", "beta-1"]);
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * A conversation told to wait out its wall walks its own route first -- docs/quota-retry.md.
 *
 * The switch refuses the models the owner did not name, not the list they wrote. Measured
 * 2026-11-09 on `tag:Quota` (five accounts): the first candidate hit its five-hour bar and the
 * conversation sat four hours while the tag's second account was answering fine. A tag is the
 * model, in order; the wait is for when nothing in it is left.
 */
test("a conversation set to wait still walks its own route before it waits", async () => {
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
    return jsonAnswer("le deuxieme compte repond");
  });
  const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("tag:Quenched");
  session.quotaRetry = { enabled: true };

  try {
    const text = await bridge.handleMessage(createMessage(), session, signal, "quenched-1");
    assert.match(text, /le deuxieme compte repond/, text);
    assert.match(notices.join("\n"), /\(Quenched route candidate 2\)/, notices.join("\n"));
    assert.match(notices.join("\n"), /\[quota\] quenched-1 is out of its week allowance/, notices.join("\n"));
    assert.deepEqual(models, ["quenched-1", "beta-1"], "one request to the refusing account, then the route");
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * The wait is what happens when the route is spent -- and the tag's own global-default step is part
 * of that route: the owner wrote `fallbackToGlobalDefault` into the tag, so it is a model they
 * named.
 */
test("a spent route falls to the tag's own global default, and only then waits", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  const cfg = walledConfig();
  cfg.tags = { Quenched: { route: [{ model: "quenched-1" }], fallbackToGlobalDefault: true } };
  const models: string[] = [];
  const mock = mockFetch(async (input, init) => {
    if (String(input).includes("/v2/quotas")) {
      return new Response(JSON.stringify(SYNTHETIC_SPENT), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const model = modelOf(init);
    models.push(model);
    if (model === "quenched-1") {
      return failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}');
    }
    return jsonAnswer("le defaut global du tag");
  });
  const bridge = new AgentBridge(cfg, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("tag:Quenched");
  session.quotaRetry = { enabled: true };

  try {
    const text = await bridge.handleMessage(createMessage(), session, signal, "quenched-1");
    assert.match(text, /le defaut global du tag/, text);
    assert.match(notices.join("\n"), /\(Quenched global default\)/, notices.join("\n"));
    assert.deepEqual(models, ["quenched-1", "beta-1"]);
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * Off its route, the switch does what it always said: the run stops on the wall and the adapter arms
 * the wait. The configured default is a model the owner did not name for this run, and answering on
 * it would look exactly like a run that respected the setting.
 */
test("off its route, a conversation set to wait stops instead of falling back", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  const models: string[] = [];
  const mock = mockFetch(async (input, init) => {
    if (String(input).includes("/v2/quotas")) {
      return new Response(JSON.stringify(SYNTHETIC_SPENT), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const model = modelOf(init);
    models.push(model);
    return failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}');
  });
  const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("quenched-1");
  session.quotaRetry = { enabled: true };

  try {
    await assert.rejects(() => bridge.handleMessage(createMessage(), session, signal), /rate limit/i);
    assert.deepEqual(models, ["quenched-1"], `the run must not leave its model, saw ${models.join(", ")}`);
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * A sub-agent is the conversation's work, so the walk reads the switch where the owner set it --
 * docs/quota-retry.md, "The switch is the conversation's, at every depth".
 *
 * The bridge only ever sees the session it runs, which for a child is the child: measured
 * 2026-11-09, same thread and same minute, the root stopped at the first wall while two sub-agents
 * walked the whole route. The runner hands the root's answer down for exactly this.
 */
test("a child's walk obeys the conversation's switch, not the child's empty field", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  const models: string[] = [];
  const mock = mockFetch(async (input, init) => {
    if (String(input).includes("/v2/quotas")) {
      return new Response(JSON.stringify(SYNTHETIC_SPENT), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const model = modelOf(init);
    models.push(model);
    return failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}');
  });
  const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
  bridge.setConversationQuotaRetry(true);
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const session = createSession("quenched-1");
  assert.equal(session.quotaRetry, undefined, "the child carries no switch of its own");

  try {
    await assert.rejects(() => bridge.handleMessage(createMessage(), session, signal), /rate limit/i);
    assert.deepEqual(models, ["quenched-1"], `nothing may answer for the pinned conversation, saw ${models.join(", ")}`);
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * A refusal that already names a spent plan is a wall without asking -- but it still has to name
 * *which* bar, because that is what the adapter arms a wait on. Returning early there left every
 * explicit-phrase provider (Codex's `usage_limit_reached`, OpenCode Go's "Go usage limit
 * exceeded", Synthetic's subscription limits) with a wall the run knew about and no window: the
 * conversation's retry switch did nothing on exactly the providers whose text is clearest.
 */
for (const [name, body] of [
  ["codex", '{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus"}'],
  ["opencode-go", "Go usage limit exceeded"],
  ["synthetic", '{"error":"You\'ve exceeded your subscription rate limits. Upgrade, or try again later."}'],
] as const) {
  test(`an explicit spent-plan refusal from ${name} still names the bar it is waiting on`, async () => {
    process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
    const models: string[] = [];
    const mock = mockFetch(async (input, init) => {
      if (String(input).includes("/v2/quotas")) {
        return new Response(JSON.stringify(SYNTHETIC_SPENT), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const model = modelOf(init);
      models.push(model);
      if (model === "quenched-1") return failure(429, body);
      return jsonAnswer("le deuxieme compte");
    });
    const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    try {
      const text = await bridge.handleMessage(createMessage(), createSession("tag:Quenched"), signal, "quenched-1");
      // The run still moves on (the switch is off here), but the note proves the oracle answered:
      // it is the only thing that knows the bar, and the adapter arms off the same read.
      assert.match(notices.join("\n"), /\[quota\] quenched-1 is out of its week allowance \(Week at 100%\)/, notices.join("\n"));
      assert.doesNotMatch(notices.join("\n"), /\[retry\]/, "no wait on a spent plan");
    } finally {
      delete process.env["SYNTHETIC_KEY_FOR_TEST"];
      end();
      mock.restore();
    }
  });
}

/**
 * The wall question is asked *now*, so the answer cannot come from a reading that predates it.
 *
 * Measured 2026-11-01 on `claude-2`: the quota card had read the plan a few minutes earlier, when
 * the five-hour window was still open. The 429 arrived, `isWallFor` answered from that cached
 * reading, and the run paid three transport attempts plus 30 s, 60 s and 120 s on a bar that had
 * just filled. Four minutes later the cache expired, the same 429 was read as a wall, and the
 * wait armed -- the same provider, the same run, two different answers.
 */
test("a cached reading older than the wall does not answer the wall question", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  const { resetQuotaCache } = await import("../../src/llm/quota/index.ts");
  resetQuotaCache();
  let barsFull = false;
  let probes = 0;
  const models: string[] = [];
  const mock = mockFetch(async (input, init) => {
    if (String(input).includes("/v2/quotas")) {
      probes += 1;
      // Open at first, full afterwards: exactly a window that fills between the card and the 429.
      return new Response(
        JSON.stringify(
          barsFull
            ? SYNTHETIC_SPENT
            : { planWeeklyLimit: { percentRemaining: 60, nextRegenAt: "2026-11-04T09:43:54.000Z", nextRegenPercent: 2 } },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const model = modelOf(init);
    models.push(model);
    if (model === "quenched-1") {
      barsFull = true;
      return failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}');
    }
    return jsonAnswer("le deuxieme compte");
  });
  const bridge = new AgentBridge(walledConfig(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  try {
    // Warm the cache while the plan still has room, as the quota card would.
    const { quotaFor } = await import("../../src/llm/quota/index.ts");
    await quotaFor(walledConfig() as never, "quenched");
    const warmed = probes;
    assert.equal(warmed, 1, "one reading to warm the cache");

    const text = await bridge.handleMessage(createMessage(), createSession("tag:Quenched"), signal, "quenched-1");
    // The stale reading said "not a wall"; the forced one says otherwise, so the run moves on with
    // the bar named and no wait spent on it.
    assert.match(notices.join("\n"), /\[quota\] quenched-1 is out of its week allowance/, notices.join("\n"));
    assert.doesNotMatch(notices.join("\n"), /\[retry\]/, "no wait on a bar that is full now");
  } finally {
    resetQuotaCache();
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    end();
    mock.restore();
  }
});

/**
 * What the run is calling now, not what it was resolved to -- the answer to "which model is
 * running", which used to be the model the run started on for the whole of its life.
 *
 * The live node follows the run (so a status page or a roster row reads it), and the hook is what
 * pushes the change to the surfaces that are not the run: the header and the status page.
 */
test("a run that adopts another model moves its live node and says so", async () => {
  const { hooks } = await import("../../src/hooks/index.ts");
  const changes: Array<{ model: string; previous: string }> = [];
  const listener = ({ model, previous }: { model: string; previous: string }): void => void changes.push({ model, previous });
  hooks.on("agent:model:changed", listener);

  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") return failure(402, "upstream unavailable");
    // Read while the run is going: the live node must already name the model that answered.
    assert.equal(runRegistry.liveModelOf(SESSION_ID), "beta-1", "the run's node follows the fallback");
    return jsonAnswer("fini ailleurs");
  });
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  try {
    await run(bridge, createSession("alpha-1"), signal);
    assert.deepEqual(models, ["alpha-1", "alpha-1", "beta-1"]);
    assert.deepEqual(changes.at(-1), { model: "beta-1", previous: "alpha-1" });
    assert.equal(runRegistry.liveModelOf(SESSION_ID), undefined, "the run ended: nothing is live");
  } finally {
    hooks.off("agent:model:changed", listener);
    end();
    mock.restore();
  }
});
