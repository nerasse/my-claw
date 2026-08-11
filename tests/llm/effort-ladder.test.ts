import { test, expect } from "bun:test";
import { clampEffortToLadder } from "../../src/llm/effort-ladder.ts";
import { resolveLlmConfig, effectiveEffort } from "../../src/llm/resolver.ts";
import { EFFORT_ORDER, type LlmConfig } from "../../src/core/config.ts";

/**
 * A pin outlives the model under it: a tag keeps `max` while its model becomes one that publishes
 * two rungs. The level is clamped to the nearest rung the model owns rather than sent verbatim
 * (a 400 on providers that validate it) or dropped (the provider's own default, often the
 * opposite of the ask). See docs/model-metadata.md.
 */

test("a level the model does not publish clamps to the nearest rung it owns", () => {
  // Above the top: the ladder's own ceiling is the nearest rung.
  expect(clampEffortToLadder("ultra", ["low", "high", "max"], "m")).toBe("max");
  // Below the bottom: same rule in the other direction.
  expect(clampEffortToLadder("none", ["low", "high", "max"], "m")).toBe("low");
  // Inside the range but off a rung: `medium` sits next to `high` here.
  expect(clampEffortToLadder("xhigh", ["low", "high"], "m")).toBe("high");
});

test("a tie goes down: spending less than asked is the smaller surprise", () => {
  // medium is one rung from low and one from high.
  expect(clampEffortToLadder("medium", ["low", "high"], "m")).toBe("low");
  // The published order must not decide it, so the same ladder reversed answers the same.
  expect(clampEffortToLadder("medium", ["high", "low"], "m")).toBe("low");
});

test("a level on the ladder is untouched, and an unknown ladder claims nothing", () => {
  expect(clampEffortToLadder("high", ["low", "high", "max"], "m")).toBe("high");
  // No ladder is no evidence: clamping here would invent a limit the provider never stated.
  expect(clampEffortToLadder("ultra", undefined, "m")).toBe("ultra");
  expect(clampEffortToLadder("ultra", [], "m")).toBe("ultra");
});

test("every rung of the vocabulary can be clamped from, none of them throws", () => {
  for (const level of EFFORT_ORDER) {
    const out = clampEffortToLadder(level, ["low", "high"], "m");
    expect(["low", "high"]).toContain(out);
  }
});

// --- the run and the display must land on the same level ---

const laddered: LlmConfig = {
  defaultProvider: "go",
  defaultModel: "flash",
  effort: "ultra",
  providers: { go: { baseUrl: "https://x/v1" } },
  models: [{ id: "flash", label: "Flash", provider: "go", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] }],
  tags: { Cheap: { model: "flash", effort: "ultra" } },
};

test("the wire carries the clamped level, whatever pinned it", () => {
  expect(resolveLlmConfig(laddered, "flash").effort).toBe("max");
  expect(resolveLlmConfig(laddered, "tag:Cheap").effort).toBe("max");
  expect(resolveLlmConfig(laddered, "flash", "none").effort).toBe("low");
});

test("the display names the level the run sends, not the pin it came from", () => {
  // Reporting the pin verbatim is how a menu came to name a rung no request ever carried.
  expect(effectiveEffort(laddered, "flash")).toEqual({ level: "max", source: "config" });
  expect(effectiveEffort(laddered, "tag:Cheap")).toEqual({ level: "max", source: "tag" });
  expect(effectiveEffort(laddered, "flash", "none")).toEqual({ level: "low", source: "session" });
  expect(effectiveEffort(laddered, "flash", undefined, "minimal")).toEqual({ level: "low", source: "scope" });
});

test("a model with no published ladder still gets the pin as asked", () => {
  const bare: LlmConfig = {
    ...laddered,
    models: [{ id: "flash", label: "Flash", provider: "go", supportsEffort: true }],
  };
  expect(resolveLlmConfig(bare, "flash").effort).toBe("ultra");
  expect(effectiveEffort(bare, "flash")).toEqual({ level: "ultra", source: "config" });
});
