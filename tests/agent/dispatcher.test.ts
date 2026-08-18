import { test } from "bun:test";
import assert from "node:assert/strict";
import { BackendDispatcher } from "../../src/agent/dispatcher.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ClaudeSdkBackend } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import { PERMISSIVE_WORLD, resetAvailabilityWorld, setAvailabilityWorld } from "../../src/llm/world.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function mixedConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: {
        litellm: { baseUrl: "https://litellm.local/v1" },
        anthropic: { type: "claude-sdk", fallbackModel: "claude-haiku-4" },
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
  return { id, platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(id: string, modelOverride?: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [], modelOverride };
}

test("resolver marks claude-sdk providers and leaves openai providers untouched", () => {
  const config = mixedConfig();
  const home = resolveLlmConfig(config.llm, "mimo");
  assert.equal(home.backend, undefined);
  assert.equal(home.baseUrl, "https://litellm.local/v1");

  const sdk = resolveLlmConfig(config.llm, "claude-sonnet-5");
  assert.equal(sdk.backend, "claude-sdk");
  assert.equal(sdk.baseUrl, "claude-sdk");
  assert.equal(sdk.fallbackModel, "claude-haiku-4");
});

test("dispatcher routes runs by the session's resolved model", async () => {
  const config = mixedConfig();
  const calls: string[] = [];
  const home = { handleMessage: async () => { calls.push("home"); return "home"; } } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => { calls.push("sdk"); return "sdk"; } } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  assert.equal(await dispatcher.handleMessage(msg("m1"), session("s1")), "home");
  assert.equal(await dispatcher.handleMessage(msg("m2"), session("s2", "claude-sonnet-5")), "sdk");
  assert.equal(await dispatcher.handleMessage(msg("m3"), session("s3", "mimo")), "home");
  assert.deepEqual(calls, ["home", "sdk", "home"]);
});

test("setApprovalHandler reaches both engines", () => {
  const config = mixedConfig();
  const seen: string[] = [];
  const home = { setApprovalHandler: () => { seen.push("home"); } } as unknown as AgentBridge;
  const sdk = { setApprovalHandler: () => { seen.push("sdk"); } } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });
  dispatcher.setApprovalHandler(async () => "allow-once");
  assert.deepEqual(seen, ["home", "sdk"]);
});

// The engine is chosen from the model that will actually run. When only the *agent* pins a
// claude-sdk model, resolving without the agent's config sends the run to the home loop, which
// then quietly runs a different model than the one configured.
test("dispatcher routes by the agent's configured model, not only the session's", async () => {
  const calls: string[] = [];
  const home = { handleMessage: async () => { calls.push("home"); return "home"; } } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => { calls.push("sdk"); return "sdk"; } } as unknown as ClaudeSdkBackend;

  const pinned = mixedConfig();
  pinned.agents.orchestrator = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  const d1 = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });
  assert.equal(await d1.handleMessage(msg("m1"), session("s1")), "sdk");

  // A per-chat choice still wins over the configured default.
  assert.equal(await d1.handleMessage(msg("m2"), session("s2", "mimo")), "home");

  // A cron pin must move cron runs only.
  const cronPinned = mixedConfig();
  cronPinned.agents.cron = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  const d2 = new BackendDispatcher(cronPinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });
  assert.equal(await d2.handleMessage({ ...msg("m3"), platform: "cron" }, session("s3")), "sdk");
  assert.equal(await d2.handleMessage(msg("m4"), session("s4")), "home");

  assert.deepEqual(calls, ["sdk", "home", "sdk", "home"]);
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
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: SessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "home", modelId });
      return `home:${modelId ?? "none"}`;
    },
  } as unknown as AgentBridge;
  let first = true;
  const sdk = {
    handleMessage: async (_m: UnifiedMessage, _s: SessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "sdk", modelId });
      if (first) {
        first = false;
        throw outageError(429);
      }
      return `sdk:${modelId ?? _s.modelOverride ?? "none"}`;
    },
  } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });
  const sess = session("s1", "claude-sonnet-5");

  const text = await dispatcher.handleMessage(msg("m1"), sess);
  assert.ok(text.startsWith("[fallback] claude-sonnet-5 via anthropic is unavailable"), text);
  assert.ok(text.includes("This run used mimo instead"), text);
  assert.ok(text.includes("returns to claude-sonnet-5"), text);
  assert.deepEqual(calls, [
    { backend: "sdk", modelId: undefined },
    { backend: "home", modelId: "mimo" },
  ]);
  assert.equal(sess.modelOverride, "claude-sonnet-5");

  // The provider recovered: the next message resolves the user's own choice again, no fallback.
  const recovered = await dispatcher.handleMessage(msg("m2"), sess);
  assert.equal(recovered, "sdk:claude-sonnet-5");
  assert.deepEqual(calls, [
    { backend: "sdk", modelId: undefined },
    { backend: "home", modelId: "mimo" },
    { backend: "sdk", modelId: undefined },
  ]);
});

test("an outage on the default provider itself surfaces the error: no reroute target exists", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: SessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "home", modelId });
      throw outageError(500);
    },
  } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => "never" } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  await assert.rejects(() => dispatcher.handleMessage(msg("m1"), session("s1")), /HTTP 500/);
  assert.deepEqual(calls, [{ backend: "home", modelId: undefined }]);
});

test("a request-specific 4xx is a config mistake, not an outage: no reroute", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  const sdk = {
    handleMessage: async (_m: UnifiedMessage, _s: SessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "sdk", modelId });
      throw outageError(400);
    },
  } as unknown as ClaudeSdkBackend;
  const home = { handleMessage: async () => "never" } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  await assert.rejects(() => dispatcher.handleMessage(msg("m1"), session("s1", "claude-sonnet-5")), /HTTP 400/);
  assert.deepEqual(calls, [{ backend: "sdk", modelId: undefined }]);
});

test("an open circuit breaker blocks every provider, so there is nothing to reroute to", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  const sdk = {
    handleMessage: async (_m: UnifiedMessage, _s: SessionData, _sig?: AbortSignal, modelId?: string) => {
      calls.push({ backend: "sdk", modelId });
      throw new Error("LLM circuit breaker open (5 consecutive failures). Retry in 30s.");
    },
  } as unknown as ClaudeSdkBackend;
  const home = { handleMessage: async () => "never" } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  await assert.rejects(() => dispatcher.handleMessage(msg("m1"), session("s1", "claude-sonnet-5")), /circuit breaker open/);
  assert.deepEqual(calls, [{ backend: "sdk", modelId: undefined }]);
});

test("streaming never reroutes after tokens were delivered: partial content cannot be replayed", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  let streamed = false;
  const sdk = {
    handleMessageStreaming: async (_m: UnifiedMessage, _s: SessionData, onToken: (t: string) => Promise<void>, _o?: unknown, _sig?: AbortSignal, _sw?: unknown, modelId?: string) => {
      calls.push({ backend: "sdk", modelId });
      await onToken("partial");
      throw outageError(429);
    },
  } as unknown as ClaudeSdkBackend;
  const home = { handleMessage: async () => "never" } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  await assert.rejects(
    () => dispatcher.handleMessageStreaming(msg("m1"), session("s1", "claude-sonnet-5"), async () => { streamed = true; }),
    /HTTP 429/,
  );
  assert.equal(streamed, true);
  assert.deepEqual(calls, [{ backend: "sdk", modelId: undefined }]);
});

test("streaming reroute streams the note first, then the fallback run's content", async () => {
  const config = mixedConfig();
  const calls: RunCall[] = [];
  const tokens: string[] = [];
  let first = true;
  const sdk = {
    handleMessageStreaming: async (_m: UnifiedMessage, _s: SessionData, onToken: (t: string) => Promise<void>, _o?: unknown, _sig?: AbortSignal, _sw?: unknown, modelId?: string) => {
      calls.push({ backend: "sdk", modelId });
      if (first) {
        first = false;
        throw new Error("fetch failed: provider is down");
      }
      await onToken("recovered answer");
      return "recovered answer";
    },
  } as unknown as ClaudeSdkBackend;
  const home = {
    handleMessageStreaming: async (_m: UnifiedMessage, _s: SessionData, onToken: (t: string) => Promise<void>, _o?: unknown, _sig?: AbortSignal, _sw?: unknown, modelId?: string) => {
      calls.push({ backend: "home", modelId });
      await onToken("fallback answer");
      return "fallback answer";
    },
  } as unknown as AgentBridge;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  const text = await dispatcher.handleMessageStreaming(msg("m1"), session("s1", "claude-sonnet-5"), async (t) => void tokens.push(t));
  assert.ok(text.startsWith("[fallback]"), text);
  assert.ok(tokens[0]!.startsWith("[fallback]"), tokens.join(""));
  assert.ok(tokens.join("").includes("fallback answer"), tokens.join(""));
  assert.deepEqual(calls, [
    { backend: "sdk", modelId: undefined },
    { backend: "home", modelId: "mimo" },
  ]);
});

// A pin that cannot run must not take the engine with it: the model falls back to the global
// default, and the engine has to follow the model that actually runs, not the one that was
// pinned. Before the single resolution, the dispatcher and the backend answered this
// differently -- and the dispatcher's answer chose the process.
test("a stale claude-sdk pin falls back to the default model, and the engine follows it", async () => {
  const calls: string[] = [];
  const home = { handleMessage: async () => { calls.push("home"); return "home"; } } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => { calls.push("sdk"); return "sdk"; } } as unknown as ClaudeSdkBackend;

  const pinned = mixedConfig();
  pinned.agents.orchestrator = { llm: { defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" } };
  const dispatcher = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

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
test("a pinned route survives the stale-override check", async () => {
  const calls: Array<string | undefined> = [];
  const home = {
    handleMessage: async (_m: UnifiedMessage, _s: SessionData, _sig?: AbortSignal, modelId?: string) => {
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
  const sdk = { handleMessage: async () => "sdk" } as unknown as ClaudeSdkBackend;
  const config = mixedConfig();
  config.llm.defaultModel = "claude-sonnet-5";
  config.llm.defaultProvider = "anthropic";
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

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
  // The backend resolves again on its own, exactly like the real engines do.
  const home = {
    handleMessage: async (message: UnifiedMessage, session: SessionData) => {
      const dup = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, {
        home: { handleMessage: async () => "inner" } as unknown as AgentBridge,
        sdk: { handleMessage: async () => "inner" } as unknown as ClaudeSdkBackend,
      });
      await dup.handleMessage(message, session);
      return "home";
    },
  } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => "sdk" } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(pinned, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

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
  const sdk = { handleMessage: async () => "sdk" } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(mixedConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });
  await dispatcher.handleMessage(msg("m-quiet"), session("s-quiet"));
  assert.equal(events.length, 0);
});
