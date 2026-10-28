/**
 * Where a run goes when its provider fails: the owner's own configuration, read in order.
 *
 * No new setting is involved -- a tag's route *is* a chain, and an agent's default is the fallback
 * for a run that is not on one. What is pinned here is the order, and the one case that must stay
 * empty: a run already on its default has no target, because the target would be the model that
 * just failed.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { providerFallbackTargets } from "../../src/llm/provider-fallback.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      providers: {
        litellm: { baseUrl: "https://litellm.local/v1" },
        anthropic: { type: "anthropic" },
      },
      models: [
        { id: "mimo", label: "Mimo", provider: "litellm" },
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
        { id: "claude-opus-5", label: "Opus", provider: "anthropic" },
      ],
      defaultProvider: "litellm",
      defaultModel: "mimo",
    },
    agents: {}, memory: { enabled: false },
  };
}

const attempted = (models: string[] = []) => new Set(models);

test("a run on a non-default model falls back to the configured default", () => {
  const targets = providerFallbackTargets({
    config: config(),
    agent: "main",
    current: { model: "claude-sonnet-5", provider: "anthropic" },
    hasImages: false,
    attempted: attempted(["claude-sonnet-5"]),
  });
  assert.deepEqual(targets.map((t) => t.model), ["mimo"]);
  assert.equal(targets[0]?.label, "configured default");
  assert.equal(targets[0]?.config.provider, "litellm");
});

test("a run already on its default has nowhere to go", () => {
  // The target would be the model that just failed: a reroute to it is a retry, and the retry
  // schedule is the thing that owns retries.
  const targets = providerFallbackTargets({
    config: config(),
    agent: "main",
    current: { model: "mimo", provider: "litellm" },
    hasImages: false,
    attempted: attempted(["mimo"]),
  });
  assert.deepEqual(targets, []);
});

test("a route walks what is left of it, in order, then the global default when it says so", () => {
  const route = {
    tag: "Cheap",
    candidates: [
      { model: "claude-sonnet-5", effort: "max" as const, contextCap: 120000 },
      { model: "claude-opus-5" },
    ],
    fallbackToGlobalDefault: true,
    selectedIndex: 0,
  };
  const targets = providerFallbackTargets({
    config: config(),
    agent: "main",
    route,
    current: { model: "claude-sonnet-5", provider: "anthropic" },
    hasImages: false,
    attempted: attempted(["claude-sonnet-5"]),
  });
  // The selected candidate is skipped -- it is the one that just failed -- and the tag's own
  // global default comes last, after the route is exhausted.
  assert.deepEqual(targets.map((t) => t.model), ["claude-opus-5", "mimo"]);
  assert.equal(targets[0]?.label, "Cheap route candidate 2");
  assert.equal(targets[0]?.config.effort, undefined);
  assert.equal(targets[1]?.label, "Cheap global default");
});

test("a global default already on the route is not tried twice", () => {
  // It used to come back as a last target after the route had tried it: a second go at a model
  // that just failed is a retry, and the retry schedule is what owns retries.
  const route = { tag: "Cheap", candidates: [{ model: "claude-sonnet-5" }, { model: "mimo" }], fallbackToGlobalDefault: true, selectedIndex: 0 };
  const targets = providerFallbackTargets({
    config: config(), agent: "main", route,
    current: { model: "claude-sonnet-5", provider: "anthropic" }, hasImages: false, attempted: attempted(["claude-sonnet-5"]),
  });
  assert.deepEqual(targets.map((t) => t.model), ["mimo"]);
});

test("off its route, a run whose agent default is a tag falls back along the whole route", () => {
  // A volet spawned on a model of its own (mimo) with `general` on tag:Medium. Only the route's
  // first candidate used to be offered, and the volet died once it failed too, opus unused.
  const cfg = config();
  cfg.tags = { Medium: { route: [{ model: "claude-sonnet-5" }, { model: "mimo" }, { model: "claude-opus-5" }], fallbackToGlobalDefault: true } };
  cfg.agents = { general: { llm: { defaultModel: "tag:Medium" } } } as MyClawConfig["agents"];
  const targets = providerFallbackTargets({
    config: cfg, agent: "general",
    current: { model: "mimo", provider: "litellm" }, hasImages: false, attempted: attempted(["mimo"]),
  });
  assert.deepEqual(targets.map((t) => t.model), ["claude-sonnet-5", "claude-opus-5"]);
  assert.deepEqual(targets.map((t) => t.label), ["Medium route candidate 1", "Medium route candidate 3"]);
});

test("a candidate the resolver refuses is skipped, not fatal", () => {
  const route = {
    tag: "Cheap",
    candidates: [{ model: "ghost-model" }, { model: "mimo" }],
    fallbackToGlobalDefault: false,
    selectedIndex: 0,
    unavailableIndices: [],
  };
  const targets = providerFallbackTargets({
    config: config(),
    agent: "main",
    route,
    current: { model: "ghost-model" },
    hasImages: false,
    attempted: attempted(["ghost-model"]),
  });
  assert.deepEqual(targets.map((t) => t.model), ["mimo"]);
});

test("a model the run already tried is never handed back", () => {
  const targets = providerFallbackTargets({
    config: config(),
    agent: "main",
    current: { model: "claude-sonnet-5", provider: "anthropic" },
    hasImages: false,
    attempted: attempted(["claude-sonnet-5", "mimo"]),
  });
  assert.deepEqual(targets, []);
});

/**
 * The route the conversation picked, when the run did not carry it.
 *
 * Measured 2026-10-27: a chat pinned on `tag:CubeFlowSol` -- two ChatGPT subscriptions -- spent the
 * first account's quota, and the run answered on `Medium`'s first candidate instead of the tag's own
 * second account. `chatgpt-3` answered fine ninety seconds later, so the target had been there and
 * was simply not looked at.
 *
 * `RunModel.route` is what the walk wants, and it does not always survive the trip: the dispatcher
 * hands the bridge the concrete winner as a forced model (which resolves to no tag), and a sub-agent
 * hands it a resolved config. Both lose the route; what the conversation picked does not.
 */
test("a tag still names the chain when the run arrives without its route", () => {
  const cfg = config();
  cfg.tags = {
    TwoAccounts: {
      route: [{ model: "claude-sonnet-5" }, { model: "claude-opus-5" }],
      fallbackToGlobalDefault: false,
    },
  };
  const targets = providerFallbackTargets({
    config: cfg,
    agent: "main",
    tagRef: "tag:TwoAccounts",
    current: { model: "claude-sonnet-5", provider: "anthropic" },
    hasImages: false,
    attempted: attempted(["claude-sonnet-5"]),
  });
  // The tag's own second candidate, never the global default: the tag does not say so.
  assert.deepEqual(targets.map((t) => t.model), ["claude-opus-5"]);
  assert.equal(targets[0]?.label, "TwoAccounts route candidate 2");
});

test("a run that left its tag is not dragged back onto it", () => {
  // The preflight already fell through this tag to the global default (both candidates were
  // unavailable before the run). Walking the route now would retry a model the resolver refused.
  const cfg = config();
  cfg.tags = { TwoAccounts: { route: [{ model: "claude-sonnet-5" }, { model: "claude-opus-5" }] } };
  const targets = providerFallbackTargets({
    config: cfg,
    agent: "main",
    tagRef: "tag:TwoAccounts",
    current: { model: "mimo", provider: "litellm" },
    hasImages: false,
    attempted: attempted(["mimo"]),
  });
  assert.deepEqual(targets, []);
});

test("a deleted tag leaves the run on the ordinary chain", () => {
  const targets = providerFallbackTargets({
    config: config(),
    agent: "main",
    tagRef: "tag:Gone",
    current: { model: "claude-sonnet-5", provider: "anthropic" },
    hasImages: false,
    attempted: attempted(["claude-sonnet-5"]),
  });
  assert.deepEqual(targets.map((t) => t.model), ["mimo"]);
  assert.equal(targets[0]?.label, "configured default");
});

test("the route wins over the tag reference when both are present", () => {
  // The resolved route knows things the stored pick does not: which candidates the preflight judged
  // unavailable, and where the effort and ceiling come from.
  const cfg = config();
  cfg.tags = {
    Cheap: { route: [{ model: "claude-sonnet-5" }, { model: "mimo" }, { model: "claude-opus-5" }] },
    Other: { route: [{ model: "claude-opus-5" }] },
  };
  const targets = providerFallbackTargets({
    config: cfg,
    agent: "main",
    route: { tag: "Cheap", candidates: [{ model: "claude-sonnet-5" }, { model: "mimo" }], fallbackToGlobalDefault: false, selectedIndex: 0 },
    tagRef: "tag:Other",
    current: { model: "claude-sonnet-5", provider: "anthropic" },
    hasImages: false,
    attempted: attempted(["claude-sonnet-5"]),
  });
  assert.deepEqual(targets.map((t) => t.model), ["mimo"]);
});
