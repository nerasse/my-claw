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
