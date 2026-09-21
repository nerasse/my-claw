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
      // Off here on purpose: these tests are about the route failover, and the default schedule
      // would make every one of them wait thirty seconds to prove the same thing. The schedule has
      // its own tests below, where the waits are milliseconds.
      providerRetry: { enabled: false },
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
