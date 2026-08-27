import { describe, test, expect } from "bun:test";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import {
  ANTHROPIC_TIMEOUT_MS,
  CODEX_TIMEOUT_MS,
  OPENAI_TIMEOUT_MS,
  describeTimeout,
  requestTimeoutMs,
  timeoutSourceOf,
  transportTimeoutDefault,
} from "../../src/llm/request-timeout.ts";
import type { LlmConfig } from "../../src/core/config.ts";

/** Three transports, one per default, so the precedence is checked where it actually lands. */
const base: LlmConfig = {
  defaultProvider: "litellm",
  defaultModel: "litellm/local",
  providers: {
    litellm: { baseUrl: "https://litellm.test/v1", apiKeyEnv: "LITELLM_API_KEY" },
    codex: { type: "codex" },
    claude: { type: "anthropic" },
  },
  models: [
    { id: "litellm/local", label: "Local", provider: "litellm" },
    { id: "litellm/slow", label: "Slow", provider: "litellm", timeoutMs: 900_000 },
    { id: "litellm/unbounded", label: "Unbounded", provider: "litellm", timeoutMs: 0 },
    { id: "codex/gpt", label: "GPT", provider: "codex" },
    { id: "claude/opus", label: "Opus", provider: "claude" },
  ],
};

describe("timeout precedence", () => {
  test("a model's own declaration wins over the global one", () => {
    const resolved = resolveLlmConfig({ ...base, timeoutMs: 60_000 }, "litellm/slow");
    expect(resolved.timeoutMs).toBe(900_000);
    expect(resolved.timeoutFrom).toBe("model");
  });

  test("the global declaration applies to a model that declares nothing", () => {
    const resolved = resolveLlmConfig({ ...base, timeoutMs: 60_000 }, "litellm/local");
    expect(resolved.timeoutMs).toBe(60_000);
    expect(resolved.timeoutFrom).toBe("global");
  });

  test("nothing declared leaves the transport default in force", () => {
    const resolved = resolveLlmConfig(base, "litellm/local");
    expect(resolved.timeoutMs).toBeUndefined();
    expect(requestTimeoutMs(resolved, OPENAI_TIMEOUT_MS)).toBe(OPENAI_TIMEOUT_MS);
    expect(timeoutSourceOf(resolved)).toBe("default");
  });

  test("zero survives resolution instead of reading as absent", () => {
    // The whole feature exists for this value: truthiness anywhere on the path silently restores
    // the wall the owner asked to remove.
    const resolved = resolveLlmConfig({ ...base, timeoutMs: 60_000 }, "litellm/unbounded");
    expect(resolved.timeoutMs).toBe(0);
    expect(resolved.timeoutFrom).toBe("model");
    expect(requestTimeoutMs(resolved, OPENAI_TIMEOUT_MS)).toBe(0);
  });

  test("a global zero applies to every model that declares nothing", () => {
    const resolved = resolveLlmConfig({ ...base, timeoutMs: 0 }, "litellm/local");
    expect(resolved.timeoutMs).toBe(0);
    expect(resolved.timeoutFrom).toBe("global");
  });

  test("a declaration is read the same way on the codex and anthropic transports", () => {
    const codex = resolveLlmConfig({ ...base, timeoutMs: 45_000 }, "codex/gpt");
    expect(codex.backend).toBe("codex");
    expect(requestTimeoutMs(codex, transportTimeoutDefault(codex.backend))).toBe(45_000);

    const claude = resolveLlmConfig(base, "claude/opus");
    expect(claude.backend).toBe("anthropic");
    expect(requestTimeoutMs(claude, transportTimeoutDefault(claude.backend))).toBe(ANTHROPIC_TIMEOUT_MS);
  });

  test("each transport keeps its own default, and they disagree on purpose", () => {
    expect(transportTimeoutDefault(undefined)).toBe(OPENAI_TIMEOUT_MS);
    expect(transportTimeoutDefault("openai")).toBe(OPENAI_TIMEOUT_MS);
    expect(transportTimeoutDefault("codex")).toBe(CODEX_TIMEOUT_MS);
    expect(transportTimeoutDefault("anthropic")).toBe(ANTHROPIC_TIMEOUT_MS);
  });

  test("a nonsense declaration falls back instead of arming a broken timer", () => {
    // Config is hand-edited: a negative or non-finite value must not become a zero-length wall.
    expect(requestTimeoutMs({ timeoutMs: -1 }, OPENAI_TIMEOUT_MS)).toBe(OPENAI_TIMEOUT_MS);
    expect(requestTimeoutMs({ timeoutMs: Number.NaN }, OPENAI_TIMEOUT_MS)).toBe(OPENAI_TIMEOUT_MS);
    expect(resolveLlmConfig({ ...base, timeoutMs: -5 }, "litellm/local").timeoutMs).toBeUndefined();
  });
});

describe("describeTimeout", () => {
  test("names the value and where it comes from", () => {
    expect(describeTimeout({ timeoutMs: 900_000, timeoutFrom: "model" }, OPENAI_TIMEOUT_MS)).toBe("900s (model)");
    expect(describeTimeout({ timeoutMs: 60_000, timeoutFrom: "global" }, OPENAI_TIMEOUT_MS)).toBe("60s (global)");
    expect(describeTimeout({}, OPENAI_TIMEOUT_MS)).toBe("120s (default)");
  });

  test("no timer is spelled out, not shown as 0s", () => {
    expect(describeTimeout({ timeoutMs: 0, timeoutFrom: "model" }, OPENAI_TIMEOUT_MS)).toBe("none (Stop only)");
  });

  test("a value that is not whole seconds stays in milliseconds", () => {
    // Rounding it to "1.5s" would print a number the owner cannot type back into the field.
    expect(describeTimeout({ timeoutMs: 1_500, timeoutFrom: "model" }, OPENAI_TIMEOUT_MS)).toBe("1500ms (model)");
    expect(describeTimeout({ timeoutMs: 1_234, timeoutFrom: "model" }, OPENAI_TIMEOUT_MS)).toBe("1234ms (model)");
  });
});
