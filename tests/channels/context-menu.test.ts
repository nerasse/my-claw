import { test, expect } from "bun:test";
import { contextChoiceFor } from "../../src/channels/context-menu.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

/** Shared by both channels so one cannot offer a window the other refuses. */

function cfg(models: Array<{ id: string; label: string; limit?: { context?: number } }>, context?: MyClawConfig["context"]): MyClawConfig {
  return { llm: { models }, context } as MyClawConfig;
}

const big = [{ id: "big", label: "Big", limit: { context: 1_048_576 } }];
const small = [{ id: "small", label: "Small", limit: { context: 100_000 } }];

test("the choice is offered when the cap lowers the window", () => {
  const c = contextChoiceFor(cfg(big), "big", undefined);
  expect(c.available).toBe(true);
  expect(c.raw).toBe(1_048_576);
  expect(c.cap).toBe(512_000);
  expect(c.mode).toBe("capped");
});

test("no choice on a model already below the cap", () => {
  expect(contextChoiceFor(cfg(small), "small", undefined).available).toBe(false);
});

test("no choice when the cap is disabled, since nothing is being withheld", () => {
  expect(contextChoiceFor(cfg(big, { cap: 0 }), "big", undefined).available).toBe(false);
});

test("the choice stays reachable after opting out, or there is no way back in", () => {
  // resolveContextWindow reports no cappedFrom once the session overrode it, so keying the entry
  // off that alone would make the submenu vanish exactly when it is needed to undo the choice.
  const c = contextChoiceFor(cfg(big), "big", "full");
  expect(c.available).toBe(true);
  expect(c.mode).toBe("full");
});

test("an unknown model still resolves, falling back to the default window", () => {
  const c = contextChoiceFor(cfg([]), "ghost", undefined);
  // 262 144 is below the 512 000 default cap, so nothing is withheld and nothing is offered.
  expect(c.available).toBe(false);
  expect(c.raw).toBe(262_144);
});

test("an exempt model is not offered a choice it already has", () => {
  const c = contextChoiceFor(cfg(big, { cap: 512_000, capExempt: ["big"] }), "big", undefined);
  // Both entries would resolve to the full window: "capped" clears the session override rather
  // than outranking the exemption, so the submenu would compare a number against itself.
  expect(c.available).toBe(false);
  expect(c.raw).toBe(1_048_576);
});

test("a glob exemption suppresses the entry for the whole family", () => {
  const models = [{ id: "Qwen3.6-35B-Q5_K_M", label: "Q", limit: { context: 1_000_000 } }];
  expect(contextChoiceFor(cfg(models, { capExempt: ["Qwen3.6-*"] }), "Qwen3.6-35B-Q5_K_M", undefined).available).toBe(false);
  // A model outside the pattern keeps it, or the exemption would read as a global switch.
  expect(contextChoiceFor(cfg(big, { capExempt: ["Qwen3.6-*"] }), "big", undefined).available).toBe(true);
});
