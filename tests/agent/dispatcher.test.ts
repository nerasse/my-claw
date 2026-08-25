import { test } from "bun:test";
import assert from "node:assert/strict";
import { BackendDispatcher } from "../../src/agent/dispatcher.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import { PERMISSIVE_WORLD, resetAvailabilityWorld, setAvailabilityWorld } from "../../src/llm/world.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";

function mixedConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: {
        litellm: { baseUrl: "https://litellm.local/v1" },
        anthropic: { type: "anthropic", fallbackModel: "claude-haiku-4" },
      },
      models: [
        { id: "mimo", label: "Mimo", provider: "litellm" },
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
      ],
      defaultProvider: "litellm",
      defaultModel: "mimo",
    },
    agents: {}, memory: { enabled: false },
  };
}

function msg(id: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(id: string, modelOverride?: string): LegacySessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [], modelOverride };
}

test("resolver marks anthropic providers and leaves openai providers untouched", () => {
  const config = mixedConfig();
  const home = resolveLlmConfig(config.llm, "mimo");
  assert.equal(home.backend, undefined);
  assert.equal(home.baseUrl, "https://litellm.local/v1");

  const anthropic = resolveLlmConfig(config.llm, "claude-sonnet-5");
  assert.equal(anthropic.backend, "anthropic");
  assert.equal(anthropic.baseUrl, "https://api.anthropic.com");
  assert.equal(anthropic.fallbackModel, "claude-haiku-4");
});

test("dispatcher routes runs to the home engine with the session's resolved model", async () => {
  const config = mixedConfig();
  const calls: Array<string | undefined> = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push(modelId);
      return "home";
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  assert.equal(await dispatcher.handleMessage(msg("m1"), session("s1")), "home");
  assert.equal(await dispatcher.handleMessage(msg("m2"), session("s2", "claude-sonnet-5")), "home");
  assert.equal(await dispatcher.handleMessage(msg("m3"), session("s3", "mimo")), "home");
  // mimo (no override) resolves to the default with no modelId passed; the override sends the id.
  assert.deepEqual(calls, [undefined, undefined, undefined]);
});

test("setApprovalHandler reaches the home engine", () => {
  const config = mixedConfig();
  const seen: string[] = [];
  const home = { setApprovalHandler: () => { seen.push("home"); } } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  dispatcher.setApprovalHandler(async () => "allow-once");
  assert.deepEqual(seen, ["home"]);
});

// The engine runs the model that will actually run. When only the *agent* pins a model,
// resolving without the agent's config would send the run with no modelId, running the global
// default instead of the configured one.
test("dispatcher routes by the agent's configured model, not only the session's", async () => {
  const calls: Array<string | undefined> = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push(modelId);
      return "home";
    },
  } as unknown as AgentBridge;

  const pinned = mixedConfig();
  pinned.agents.orchestrator = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  const d1 = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  assert.equal(await d1.handleMessage(msg("m1"), session("s1")), "home");

  // A per-chat choice still wins over the configured default.
  assert.equal(await d1.handleMessage(msg("m2"), session("s2", "mimo")), "home");

  // A cron pin must move cron runs only.
  const cronPinned = mixedConfig();
  cronPinned.agents.cron = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  const d2 = new BackendDispatcher(cronPinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  assert.equal(await d2.handleMessage({ ...msg("m3"), platform: "cron" }, session("s3")), "home");
  assert.equal(await d2.handleMessage(msg("m4"), session("s4")), "home");

  assert.deepEqual(calls, [undefined, undefined, undefined, undefined]);
});

function outageError(status: number): Error & { status?: number } {
  const err = new Error(`LLM request failed: HTTP ${status} — out of credits`) as Error & { status?: number };
  err.status = status;
  return err;
}

interface RunCall {
  backend: string;
  modelId?: string;
}

// The fallback contract: a run on a non-default provider that dies an outage-class death is
// replayed ONCE on the default provider, with the session's own choice left untouched so the
// next message returns to it as soon as the provider recovers.
test("an outage on a non-default provider reroutes the run once and never touches the session", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  let first = true;
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "home", modelId });
      if (modelId === undefined && first) {
        first = false;
        throw outageError(429);
      }
      return `home:${modelId ?? "none"}`;
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  const sess = session("s1", "claude-sonnet-5");

  const text = await dispatcher.handleMessage(msg("m1"), sess);
  assert.ok(text.startsWith("[fallback] claude-sonnet-5 via anthropic is unavailable"), text);
  assert.ok(text.includes("This run used mimo instead"), text);
  assert.ok(text.includes("returns to claude-sonnet-5"), text);
  assert.deepEqual(calls, [
    { backend: "home", modelId: undefined },
    { backend: "home", modelId: "mimo" },
  ]);
  assert.equal(sess.modelOverride, "claude-sonnet-5");
});

// A 4xx is not an outage: it is a deterministic refusal (auth, policy, bad request). Rerouting
// would silently retry on a different model the owner never asked for, so it must surface as-is.
test("an ordered tag route falls through candidates and preserves the tag reference", async () => {
  const config = mixedConfig();
  config.tags = {
    Cheap: {
      route: [
        { model: "claude-sonnet-5", effort: "max", contextCap: 120000 },
        { model: "mimo", effort: "high", contextCap: 100000 },
      ],
    },
  };
  const calls: Array<{ modelId?: string; override?: unknown }> = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string, override?: unknown) => {
      calls.push({ modelId, override });
      if (modelId === "claude-sonnet-5") throw outageError(503);
      return `home:${modelId}`;
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  const sess = session("s-route", "tag:Cheap");
  const text = await dispatcher.handleMessage(msg("m-route"), sess);
  assert.match(text, /Cheap: claude-sonnet-5/);
  assert.match(text, /home:mimo/);
  assert.deepEqual(calls.map(call => call.modelId), ["claude-sonnet-5", "mimo"]);
  assert.deepEqual(calls[0]?.override, { effort: "max", contextCap: 120000 });
  assert.equal(sess.modelOverride, "tag:Cheap");
});

test("an ordered route can explicitly fall back to the global default", async () => {
  const config = mixedConfig();
  config.tags = {
    Cheap: {
      route: [{ model: "claude-sonnet-5" }, { model: "claude-opus-5" }],
      fallbackToGlobalDefault: true,
    },
  };
  config.llm.models!.push({ id: "claude-opus-5", label: "Opus", provider: "anthropic" });
  const calls: string[] = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push(modelId ?? "default");
      if (modelId !== "mimo") throw outageError(503);
      return "global";
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  const text = await dispatcher.handleMessage(msg("m-global"), session("s-global", "tag:Cheap"));
  assert.match(text, /claude-sonnet-5/);
  assert.match(text, /claude-opus-5/);
  assert.match(text, /using mimo \(Cheap global default\)/);
  assert.match(text, /global$/);
  assert.deepEqual(calls, ["claude-sonnet-5", "claude-opus-5", "mimo"]);
});

test("a route never replays after streaming output has started", async () => {
  const config = mixedConfig();
  config.tags = { Cheap: { route: [{ model: "claude-sonnet-5" }, { model: "mimo" }] } };
  const calls: string[] = [];
  const home = {
    handleMessageStreaming: async (
      _m: UnifiedMessage, _s: LegacySessionData, onToken: (token: string) => Promise<void>,
      _onTool?: unknown, _signal?: AbortSignal, _switch?: unknown, modelId?: string,
    ) => {
      calls.push(modelId ?? "default");
      await onToken("partial");
      throw outageError(503);
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  await assert.rejects(() => dispatcher.handleMessageStreaming(msg("m-partial"), session("s-partial", "tag:Cheap"), async () => {}), /out of credits/);
  assert.deepEqual(calls, ["claude-sonnet-5"]);
});

test("a 4xx refuses without rerouting", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "home", modelId });
      throw outageError(403);
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  await assert.rejects(() => dispatcher.handleMessage(msg("m1"), session("s1", "claude-sonnet-5")), /out of credits/);
  assert.deepEqual(calls, [{ backend: "home", modelId: undefined }]);
});

// Streaming reroute: the first attempt dies mid-stream, the run replays on the default with the
// tokens already sent to the user suppressed (the `[fallback]` prefix stands in for the
// detailed announcement). The home loop answers both: the failing model and the fallback.
test("an outage during streaming reroutes once with the [fallback] prefix", async () => {
  const config = mixedConfig();
  const tokens: string[] = [];
  const calls: RunCall[] = [];
  let first = true;
  const home = {
    handleMessageStreaming: async (
      _m: UnifiedMessage, _s: LegacySessionData,
      onToken: (t: string) => Promise<void>,
      _o?: unknown, _sig?: AbortSignal, _sw?: unknown, modelId?: string,
    ) => {
      calls.push({ backend: "home", modelId });
      if (modelId === undefined && first) {
        first = false;
        throw outageError(429);
      }
      await onToken("fallback answer");
      return "fallback answer";
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  const text = await dispatcher.handleMessageStreaming(msg("m1"), session("s1", "claude-sonnet-5"), async (t) => void tokens.push(t));
  assert.ok(text.startsWith("[fallback]"), text);
  assert.ok(tokens[0]!.startsWith("[fallback]"), tokens.join(""));
  assert.ok(tokens.join("").includes("fallback answer"), tokens.join(""));
  assert.deepEqual(calls, [
    { backend: "home", modelId: undefined },
    { backend: "home", modelId: "mimo" },
  ]);
});

// A pin that cannot run must not take the engine with it: the model falls back to the global
// default, and the engine runs the model that actually runs, not the one that was pinned.
test("a stale anthropic pin falls back to the default model, and the engine follows it", async () => {
  const calls: string[] = [];
  const home = { handleMessage: async () => { calls.push("home"); return "home"; } } as unknown as AgentBridge;

  const pinned = mixedConfig();
  pinned.agents.orchestrator = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  const dispatcher = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  // The Claude subscription is not connected: the pin cannot run, the global default (mimo, an
  // openai-compatible model) can.
  setAvailabilityWorld(() => ({ ...PERMISSIVE_WORLD, claudeAuth: false }));
  try {
    assert.equal(await dispatcher.handleMessage(msg("m1"), session("s1")), "home");
    assert.deepEqual(calls, ["home"]);
  } finally {
    resetAvailabilityWorld();
  }
});

// The self-heal above judges the reference against the catalogue, and no catalogue id carries a
// route pin: a pinned override read as a removed model and was deleted on the first message, so
// the route menus of every channel pinned a route that lasted exactly zero runs.
test("a deleted tag survives the stale-override check and falls back at resolution time", async () => {
  const home = { handleMessage: async () => "home" } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(mixedConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  const sess = session("s1", "tag:gone");

  assert.equal(await dispatcher.handleMessage(msg("m1"), sess), "home");
  assert.equal(sess.modelOverride, "tag:gone");
});

test("a pinned route survives the stale-override check", async () => {
  const calls: Array<string | undefined> = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: LegacySessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push(modelId);
      return "home";
    },
  } as unknown as AgentBridge;
  const routed = mixedConfig();
  routed.llm.providers!.openrouter = { baseUrl: "https://openrouter.ai/api/v1" };
  routed.llm.models!.push({ id: "openrouter/deepseek/flash", label: "Flash", provider: "openrouter", apiId: "deepseek/flash" });
  const dispatcher = new BackendDispatcher(routed, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  const sess = session("s1", "openrouter/deepseek/flash@streamlake/fp8");
  assert.equal(await dispatcher.handleMessage(msg("m1"), sess), "home");
  assert.equal(sess.modelOverride, "openrouter/deepseek/flash@streamlake/fp8");
  assert.deepEqual(calls, [undefined]);

  // The model under a pin is still judged: a reference whose model left the catalogue heals to
  // the default exactly as an unpinned one does.
  const gone = session("s2", "openrouter/deepseek/retired@streamlake/fp8");
  await dispatcher.handleMessage(msg("m2"), gone);
  assert.equal(gone.modelOverride, undefined);
});

test("an unavailable global default fails the run instead of substituting a model", async () => {
  const home = { handleMessage: async () => "home" } as unknown as AgentBridge;
  const config = mixedConfig();
  config.llm.defaultModel = "claude-sonnet-5";
  config.llm.defaultProvider = "anthropic";
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  setAvailabilityWorld(() => ({ ...PERMISSIVE_WORLD, claudeAuth: false }));
  try {
    // Nothing sits below the global default: picking mimo here would be inventing a model the
    // owner never named for this run.
    await assert.rejects(() => dispatcher.handleMessage(msg("m1"), session("s1")), /cannot run/);
  } finally {
    resetAvailabilityWorld();
  }
});

// "Warn once per run, not per request": a run is dozens of requests, and the resolution happens
// several times inside one (the dispatcher to pick the engine, the backend to run, a reroute).
test("a fallback is announced once per run, whatever resolves inside it", async () => {
  const events: Array<Record<string, unknown>> = [];
  hooks.on("model:fallback", (e) => void events.push(e as unknown as Record<string, unknown>));

  const pinned = mixedConfig();
  pinned.agents.orchestrator = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  // The backend resolves again on its own, exactly like the real engine does.
  const home = {
    handleMessage: async (message: UnifiedMessage, session: LegacySessionData) => {
      const dup = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, {
        home: { handleMessage: async () => "inner" } as unknown as AgentBridge,
      });
      await dup.handleMessage(message, session);
      return "home";
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });

  setAvailabilityWorld(() => ({ ...PERMISSIVE_WORLD, claudeAuth: false }));
  try {
    await dispatcher.handleMessage(msg("m-once"), session("s-once"));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.["model"], "claude-sonnet-5");
    assert.equal(events[0]?.["ran"], "mimo");
    assert.equal(events[0]?.["origin"], "config.agents.orchestrator.llm.defaultModel");
    assert.match(String(events[0]?.["reason"]), /subscription is not connected/);
  } finally {
    resetAvailabilityWorld();
  }
});

test("a run whose chain is intact announces nothing", async () => {
  const events: unknown[] = [];
  hooks.on("model:fallback", (e) => void events.push(e));
  const home = { handleMessage: async () => "home" } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(mixedConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home });
  await dispatcher.handleMessage(msg("m-quiet"), session("s-quiet"));
  assert.equal(events.length, 0);
});
