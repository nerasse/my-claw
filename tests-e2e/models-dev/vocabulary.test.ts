// E2E vocabulary guard: reads the real models.dev catalogue and checks that every reasoning level
// it publishes is one we know how to offer. Requires network.
// Run with: MODELS_DEV_E2E=1 bun test tests-e2e/models-dev/*.test.ts
//
// Why this is a test and not a comment: the per-model ladders are read from that file at runtime
// (docs/model-metadata.md R1), so a level added upstream is silently dropped by our validation
// rather than surfacing anywhere. A failure here is the notice that the vocabulary needs a rung --
// and the reminder that a new rung also needs a clamp in toSdkEffort.

import { test, expect } from "bun:test";
import type { EffortLevel } from "../../src/core/config.ts";
import { effortLadderOf } from "../../src/llm/pricing.ts";

const E2E_ENABLED = process.env.MODELS_DEV_E2E === "1";

/** Kept in step with EffortLevel in src/core/config.ts, deliberately by hand: the point is to fail. */
const VOCABULARY: EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Junk measured in the live file: one `"default"` and two nulls. Values we refuse on purpose, as
// opposed to values we have not heard of, which is what this test is looking for.
const KNOWN_JUNK = new Set(["default"]);

interface RawModel {
  reasoning_options?: Array<{ type?: string; values?: unknown }>;
}

test.if(E2E_ENABLED)("every reasoning level models.dev publishes is one we can offer", async () => {
  const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000) });
  expect(res.ok).toBe(true);
  const api = (await res.json()) as Record<string, { models?: Record<string, RawModel> }>;

  const unknown = new Map<string, number>();
  const types = new Map<string, number>();
  let models = 0;
  let described = 0;

  for (const provider of Object.values(api)) {
    for (const model of Object.values(provider.models ?? {})) {
      models++;
      const options = model.reasoning_options ?? [];
      if (options.length > 0) described++;
      for (const option of options) {
        if (option.type) types.set(option.type, (types.get(option.type) ?? 0) + 1);
        if (option.type !== "effort" || !Array.isArray(option.values)) continue;
        for (const value of option.values) {
          if (typeof value !== "string" || KNOWN_JUNK.has(value)) continue;
          if (VOCABULARY.includes(value as EffortLevel)) continue;
          unknown.set(value, (unknown.get(value) ?? 0) + 1);
        }
      }
    }
  }

  // Sanity: a catalogue that answered with nothing would make the assertions below vacuous.
  expect(models).toBeGreaterThan(1000);
  expect(described).toBeGreaterThan(100);

  // A new rung upstream needs: the EffortLevel union, EFFORT_SET, EFFORT_ORDER, a clamp in
  // toSdkEffort, and a decision on whether EFFORT_LEVELS should carry it (docs/model-metadata.md R1
  // says no by default).
  expect([...unknown.entries()]).toEqual([]);

  // A new option shape is a feature we do not implement, not a level: `budget_tokens` is ignored on
  // purpose and a fourth kind would need its own decision.
  expect([...types.keys()].sort()).toEqual(["budget_tokens", "effort", "toggle"]);
});

test.if(E2E_ENABLED)("the ladder reader agrees with the live entry for a known model", async () => {
  const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000) });
  const api = (await res.json()) as Record<string, { models?: Record<string, RawModel> }>;
  const model = api["opencode-go"]?.models?.["deepseek-v4-flash"];
  expect(model).toBeDefined();
  // The example the spec is written against, read through the code that will read it in production.
  expect(effortLadderOf(model ?? {}).levels).toEqual(["low", "high", "max"]);
});
