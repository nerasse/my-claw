import { test, expect } from "bun:test";
import { resolveContextWindow, occupiedContextTokens, measuredPrompt, sessionMirrorRole } from "../../src/llm/context-window.ts";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/llm/tokens.ts";
import { DEFAULT_CONTEXT_CAP, resolveContextCap, type MyClawConfig } from "../../src/core/config.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

/**
 * The cap and the occupancy measurement, which together decide when a conversation gets compacted.
 * See docs/context-window.md.
 */

function cfg(context?: MyClawConfig["context"]): MyClawConfig {
  return { llm: {}, context } as MyClawConfig;
}

const table = (tokens?: number, approximate = false) => ({
  contextWindowOf: () => (tokens === undefined ? undefined : { tokens, approximate, source: "test" }),
});

test("a declared window is used as-is when it sits below the cap", () => {
  const w = resolveContextWindow({ model: "m", config: cfg(), declared: 200_000 });
  expect(w.raw).toBe(200_000);
  expect(w.effective).toBe(200_000);
  expect(w.rawSource).toBe("declared");
  expect(w.cappedFrom).toBeUndefined();
});

test("a window filled in at boot keeps the third party's name, not the owner's", () => {
  // The enrichment pass writes models.dev into the same field a declaration uses, so without this
  // /status would credit a curated number for a figure nobody in this deployment chose.
  const w = resolveContextWindow({ model: "m", config: cfg(), declared: 400_000, declaredSource: "models.dev" });
  expect(w.rawSource).toBe("models.dev");
  const own = resolveContextWindow({ model: "m", config: cfg(), declared: 400_000 });
  expect(own.rawSource).toBe("declared");
});

test("the table answers when nothing is declared, and its provenance is carried", () => {
  const w = resolveContextWindow({ model: "m", config: cfg(), table: table(300_000, true) });
  expect(w.raw).toBe(300_000);
  expect(w.rawSource).toBe("models.dev");
  expect(w.approximate).toBe(true);
});

test("an unknown model falls back to the default and says so", () => {
  const w = resolveContextWindow({ model: "m", config: cfg(), table: table(undefined) });
  expect(w.raw).toBe(DEFAULT_CONTEXT_TOKENS);
  expect(w.rawSource).toBe("default");
});

test("the fallback window is 256Ki exactly, deliberately not rounded up", () => {
  // Pinned to the literal because the value is a decision, not an implementation detail: it also
  // sizes maxTokens, where overshooting the real window overflows instead of merely wasting it.
  // 262 144 is the native window of the local Qwen3.x ggufs that are its only real consumer.
  expect(DEFAULT_CONTEXT_TOKENS).toBe(262_144);
});

test("the cap lowers a larger window and records what it lowered", () => {
  const w = resolveContextWindow({ model: "m", config: cfg(), declared: 1_048_576 });
  expect(w.effective).toBe(DEFAULT_CONTEXT_CAP);
  expect(w.cappedFrom).toBe(1_048_576);
  // The raw figure has to survive, or /status cannot explain the number it prints.
  expect(w.raw).toBe(1_048_576);
});

test("the cap is active without configuration, which is a deliberate behaviour change", () => {
  expect(resolveContextCap(cfg())).toBe(512_000);
});

test("a zero or negative cap disables the ceiling instead of clamping everything to nothing", () => {
  for (const cap of [0, -1]) {
    const w = resolveContextWindow({ model: "m", config: cfg({ cap }), declared: 1_048_576 });
    expect(w.effective).toBe(1_048_576);
    expect(w.cappedFrom).toBeUndefined();
  }
});

test("a glob exemption releases a whole self-hosted family in one line", () => {
  const config = cfg({ cap: 512_000, capExempt: ["Qwen3.6-*"] });
  const exempt = resolveContextWindow({ model: "Qwen3.6-35B-A3B-uncensored-MTP-Q5_K_M", config, declared: 1_048_576 });
  expect(exempt.effective).toBe(1_048_576);
  expect(exempt.cappedFrom).toBeUndefined();
  // A model outside the pattern is still capped, or the exemption would be a global switch.
  const other = resolveContextWindow({ model: "mimo-v2.5-pro", config, declared: 1_048_576 });
  expect(other.effective).toBe(512_000);
});

test("exemption matching ignores case, since ids are spelled inconsistently across providers", () => {
  const w = resolveContextWindow({
    model: "QWEN3.6-35B-Q5_K_M",
    config: cfg({ capExempt: ["qwen3.6-*"] }),
    declared: 1_048_576,
  });
  expect(w.effective).toBe(1_048_576);
});

test("an explicitly declared window is still capped: one rule, and capExempt is the only way out", () => {
  const w = resolveContextWindow({ model: "m", config: cfg({ cap: 400_000 }), declared: 900_000, declaredSource: "declared" });
  expect(w.effective).toBe(400_000);
  expect(w.rawSource).toBe("declared");
});

test("a session override wins over the cap and is named", () => {
  const w = resolveContextWindow({ model: "m", config: cfg({ cap: 512_000 }), declared: 1_000_000, sessionOverride: "full" });
  expect(w.effective).toBe(1_000_000);
  expect(w.overridden).toBe(true);
  expect(w.cappedFrom).toBeUndefined();
});

test("an override on a model the cap never touched is not advertised", () => {
  const w = resolveContextWindow({ model: "m", config: cfg({ cap: 512_000 }), declared: 100_000, sessionOverride: "full" });
  expect(w.effective).toBe(100_000);
  // Claiming an override here would tell the owner a choice mattered when it changed nothing.
  expect(w.overridden).toBeUndefined();
});

test("clearing the override returns the conversation to the standing policy", () => {
  const w = resolveContextWindow({ model: "m", config: cfg({ cap: 512_000 }), declared: 1_000_000, sessionOverride: undefined });
  expect(w.effective).toBe(512_000);
  expect(w.overridden).toBeUndefined();
  expect(w.cappedFrom).toBe(1_000_000);
});

test("a numeric override can tighten below the cap, not only lift it", () => {
  // The point is not only to escape the policy: a shorter prompt is cheaper and faster, and one
  // conversation may be worth spending less on.
  const w = resolveContextWindow({ model: "m", config: cfg({ cap: 512_000 }), declared: 1_000_000, sessionOverride: 128_000 });
  expect(w.effective).toBe(128_000);
  expect(w.cappedFrom).toBe(1_000_000);
  expect(w.overridden).toBe(true);
});

test("a numeric override beats an exemption, in either direction", () => {
  const config = cfg({ cap: 512_000, capExempt: ["m"] });
  expect(resolveContextWindow({ model: "m", config, declared: 1_000_000, sessionOverride: 64_000 }).effective).toBe(64_000);
  // And with no override the exemption still releases it.
  expect(resolveContextWindow({ model: "m", config, declared: 1_000_000 }).effective).toBe(1_000_000);
});

test("an override above the model's own window cannot invent capacity", () => {
  const w = resolveContextWindow({ model: "m", config: cfg(), declared: 200_000, sessionOverride: 900_000 });
  expect(w.effective).toBe(200_000);
  expect(w.cappedFrom).toBeUndefined();
});

test("an agent's own ceiling wins over the global one", () => {
  const config = { llm: {}, context: { cap: 512_000 }, agents: { research: { context: { cap: 128_000 } } } } as never;
  expect(resolveContextWindow({ model: "m", config, declared: 1_000_000, agent: "research" }).effective).toBe(128_000);
  // A different agent is untouched by it.
  expect(resolveContextWindow({ model: "m", config, declared: 1_000_000, agent: "general" }).effective).toBe(512_000);
});

test("an agent's ceiling may exceed the global one, which a min() would silently refuse", () => {
  const config = { llm: {}, context: { cap: 512_000 }, agents: { research: { context: { cap: 900_000 } } } } as never;
  // The case the whole "wins outright" rule exists for: granting one agent more than the standing
  // policy without editing the policy. Combining the two would clamp it straight back to 512k.
  expect(resolveContextWindow({ model: "m", config, declared: 1_000_000, agent: "research" }).effective).toBe(900_000);
});

test("an agent can lift the ceiling for itself alone with a zero", () => {
  const config = { llm: {}, context: { cap: 512_000 }, agents: { research: { context: { cap: 0 } } } } as never;
  // A min() against the global cap would silently refuse this, which is why the agent key wins
  // outright instead of being combined.
  expect(resolveContextWindow({ model: "m", config, declared: 1_000_000, agent: "research" }).effective).toBe(1_000_000);
});

// -- occupancy ---------------------------------------------------------------------------------

const toChat = (msgs: readonly string[]): ChatMessage[] => msgs.map((content) => ({ role: "user" as const, content }));

test("with no measurement, occupancy is the plain estimate", () => {
  const history = ["a".repeat(400)];
  expect(occupiedContextTokens(history, toChat)).toBe(occupiedContextTokens(history, toChat, undefined));
});

test("a measurement replaces the estimate for the history it covered, and only the rest is guessed", () => {
  const history = ["a".repeat(400), "b".repeat(400)];
  // The estimate is ~100 tokens per message; the provider billed 10 000 for the first one alone.
  const occupied = occupiedContextTokens(history, toChat, { tokens: 10_000, messageCount: 1 });
  // Exact prefix plus an estimate of the single message appended since.
  expect(occupied).toBeGreaterThan(10_000);
  expect(occupied).toBeLessThan(10_400);
});

test("the measurement is discarded when the history shrank, because compaction invalidated it", () => {
  const history = ["a".repeat(400)];
  const stale = { tokens: 900_000, messageCount: 12 };
  const occupied = occupiedContextTokens(history, toChat, stale);
  expect(occupied).toBeLessThan(1000);
});

test("occupancy never reads below the plain estimate, so the gate can only tighten", () => {
  const history = ["a".repeat(4000), "b".repeat(4000)];
  const plain = occupiedContextTokens(history, toChat);
  // A provider under-reporting its prompt must not make the gate blinder than chars/4 alone.
  expect(occupiedContextTokens(history, toChat, { tokens: 1, messageCount: 2 })).toBe(plain);
});

test("a zero prompt is not a measurement: error paths report it and would blind the gate", () => {
  expect(measuredPrompt(0, 5)).toBeUndefined();
  expect(measuredPrompt(-1, 5)).toBeUndefined();
  expect(measuredPrompt(12, 5)).toEqual({ tokens: 12, messageCount: 5 });
});

test("a measurement covering the whole history adds nothing for turns since", () => {
  const history = ["a".repeat(400), "b".repeat(400)];
  expect(occupiedContextTokens(history, toChat, { tokens: 50_000, messageCount: 2 })).toBe(50_000);
});

// -- transcript mirror -------------------------------------------------------------------------
// The SDK owns its history and compacts it behind our back, while `session.messages` keeps every
// turn and every tool result: flooring on the estimate over that mirror is what reported a
// conversation at 98 percent of the window minutes after it had been compacted down to 15.

test("on a transcript mirror the measurement stands alone: the mirror estimate is not a floor", () => {
  const history = ["a".repeat(40_000), "b".repeat(400)];
  const measured = { tokens: 5_000, messageCount: 1 };
  expect(occupiedContextTokens(history, toChat, measured)).toBeGreaterThan(10_000);
  const transcript = occupiedContextTokens(history, toChat, measured, { kind: "transcript" });
  expect(transcript).toBeGreaterThan(5_000);
  expect(transcript).toBeLessThan(5_200);
});

test("without a measurement a transcript mirror counts from the last boundary only", () => {
  const history = ["a".repeat(40_000), "b".repeat(400)];
  const fromBoundary = occupiedContextTokens(history, toChat, undefined, { kind: "transcript", base: 1 });
  expect(fromBoundary).toBeLessThan(200);
  expect(fromBoundary).toBeLessThan(occupiedContextTokens(history, toChat, undefined, { kind: "transcript" }));
});

// The local summarizer can run on an SDK session, and it rewrites the mirror: an index into the
// old array would then point past the end and report an empty context.
test("a boundary past the end of a rewritten mirror falls back to the whole of it", () => {
  const history = ["a".repeat(400)];
  const whole = occupiedContextTokens(history, toChat, undefined, { kind: "transcript" });
  expect(occupiedContextTokens(history, toChat, undefined, { kind: "transcript", base: 12 })).toBe(whole);
});

test("a stale measurement is discarded on a transcript mirror too", () => {
  const history = ["a".repeat(400)];
  const stale = { tokens: 900_000, messageCount: 12 };
  expect(occupiedContextTokens(history, toChat, stale, { kind: "transcript" })).toBeLessThan(1000);
});

// Which mirror a stored session carries is resolved from its own model choice, the same chain the
// run resolves: a chat pinned to another engine must not be read the way the default one is.
test("the mirror kind follows the engine of the session's own model", () => {
  const config = {
    llm: {
      providers: { anthropic: { type: "claude-sdk" }, litellm: { baseUrl: "http://x/v1" } },
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
      models: [
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
        { id: "mimo", label: "Mimo", provider: "litellm" },
      ],
    },
  } as unknown as MyClawConfig;

  expect(sessionMirrorRole(config, {})).toEqual({ kind: "transcript" });
  expect(sessionMirrorRole(config, { sdkTranscriptBase: 12 })).toEqual({ kind: "transcript", base: 12 });
  expect(sessionMirrorRole(config, { modelOverride: "mimo" })).toEqual({ kind: "prompt" });
});

/**
 * The engine is what decides the mirror, and the engine comes from the whole chain. A chat that
 * picked nothing still runs on whatever its agent is pinned to, and a display that read the
 * override alone called that a prompt mirror while the gate called it a transcript.
 */
test("the mirror kind follows the agent's pin, not just the session's pick", () => {
  const config = {
    llm: {
      providers: {
        anthropic: { type: "claude-sdk" },
        litellm: { baseUrl: "https://litellm.example.com", apiKeyEnv: "LITELLM_KEY" },
      },
      defaultProvider: "litellm",
      defaultModel: "mimo",
      models: [
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
        { id: "mimo", label: "Mimo", provider: "litellm" },
      ],
    },
    agents: { orchestrator: { llm: { defaultModel: "claude-sonnet-5" } } },
  } as unknown as MyClawConfig;

  expect(sessionMirrorRole(config, {})).toEqual({ kind: "transcript" });
  // The chat's own pick still wins over the pin, in both directions.
  expect(sessionMirrorRole(config, { modelOverride: "mimo" })).toEqual({ kind: "prompt" });
  // Another agent has its own chain: nothing pinned there, so the global default applies.
  expect(sessionMirrorRole(config, {}, "research")).toEqual({ kind: "prompt" });
});
