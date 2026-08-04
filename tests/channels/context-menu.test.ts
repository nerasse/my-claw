import { test, expect } from "bun:test";
import { contextChoiceFor } from "../../src/channels/context-menu.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

/** Shared by both channels so one cannot offer a window the other refuses. */

function cfg(models: Array<{ id: string; label: string; limit?: { context?: number } }>, context?: MyClawConfig["context"], agents?: unknown): MyClawConfig {
  return { llm: { models }, context, agents } as MyClawConfig;
}

const big = [{ id: "big", label: "Big", limit: { context: 1_048_576 } }];
const mid = [{ id: "mid", label: "Mid", limit: { context: 300_000 } }];
const tiny = [{ id: "tiny", label: "Tiny", limit: { context: 40_000 } }];

const labels = (c: ReturnType<typeof contextChoiceFor>) => c.tiers.map((t) => t.label);

test("the full window leads, then every ceiling strictly below it", () => {
  const c = contextChoiceFor(cfg(big), "big", undefined);
  expect(labels(c)).toEqual(["Full: 1,048,576", "512,000 (cap)", "256,000", "128,000", "64,000"]);
  expect(c.available).toBe(true);
  // Standing policy with no session choice: the cap is what is in force.
  expect(c.effective).toBe(512_000);
  expect(c.tiers.find((t) => t.selected)?.label).toBe("512,000 (cap)");
});

test("ceilings at or above the window are dropped, not rendered as the same number twice", () => {
  // 300 000 sits under the 512 000 cap, so the cap tier would repeat the full window.
  expect(labels(contextChoiceFor(cfg(mid), "mid", undefined))).toEqual(["Full: 300,000", "256,000", "128,000", "64,000"]);
});

test("a model smaller than every tier has nothing to arbitrate", () => {
  const c = contextChoiceFor(cfg(tiny), "tiny", undefined);
  expect(labels(c)).toEqual(["Full: 40,000"]);
  expect(c.available).toBe(false);
});

test("the selected tier follows the session's own choice", () => {
  const c = contextChoiceFor(cfg(big), "big", 128_000);
  expect(c.effective).toBe(128_000);
  expect(c.tiers.find((t) => t.selected)?.label).toBe("128,000");
  const full = contextChoiceFor(cfg(big), "big", "full");
  expect(full.effective).toBe(1_048_576);
  expect(full.tiers.find((t) => t.selected)?.label).toBe("Full: 1,048,576");
});

test("the choice stays reachable after opting out, or there is no way back in", () => {
  expect(contextChoiceFor(cfg(big), "big", "full").available).toBe(true);
});

test("an exempt model still gets the list, because a tier can now tighten it", () => {
  // Unlike the first design, the menu is not pointless here: the lower tiers do something.
  const c = contextChoiceFor(cfg(big, { cap: 512_000, capExempt: ["big"] }), "big", undefined);
  expect(c.available).toBe(true);
  expect(c.effective).toBe(1_048_576);
  expect(c.tiers.find((t) => t.selected)?.label).toBe("Full: 1,048,576");
});

test("a disabled cap drops its tier but keeps the lower ones", () => {
  expect(labels(contextChoiceFor(cfg(big, { cap: 0 }), "big", undefined))).toEqual(["Full: 1,048,576", "256,000", "128,000", "64,000"]);
});

test("an agent's own ceiling is the one offered and marked", () => {
  const config = cfg(big, { cap: 512_000 }, { research: { context: { cap: 128_000 } } });
  const c = contextChoiceFor(config, "big", undefined, "research");
  expect(c.effective).toBe(128_000);
  expect(c.tiers.find((t) => t.selected)?.label).toBe("128,000 (cap)");
  // The global cap is not the agent's, so it is not labelled as one for it.
  expect(labels(c)).toEqual(["Full: 1,048,576", "128,000 (cap)", "256,000", "64,000"]);
});

test("an unknown model still resolves, falling back to the default window", () => {
  const c = contextChoiceFor(cfg([]), "ghost", undefined);
  expect(c.raw).toBe(262_144);
});
