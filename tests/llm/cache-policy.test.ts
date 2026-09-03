import { describe, test, expect } from "bun:test";
import { cacheAttributionOf, cacheDialectOf } from "../../src/llm/cache-policy.ts";

describe("cacheDialectOf", () => {
  test("an Anthropic engine is recognized through every reseller", () => {
    // The point of the module: the same engine, reached five ways, gets one answer.
    expect(cacheDialectOf("claude-opus-5")).toBe("anthropic");
    expect(cacheDialectOf("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(cacheDialectOf("openrouter/anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(cacheDialectOf("commandcode/claude-fable-5-1")).toBe("anthropic");
    expect(cacheDialectOf("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(cacheDialectOf("claude-opus-4-5-20251101")).toBe("anthropic");
  });

  test("an OpenAI engine is recognized through every reseller", () => {
    expect(cacheDialectOf("gpt-5.6-luna")).toBe("openai");
    expect(cacheDialectOf("openai/gpt-5.4")).toBe("openai");
    expect(cacheDialectOf("openrouter/openai/gpt-5.6-terra")).toBe("openai");
    expect(cacheDialectOf("chatgpt/gpt-5.6-sol")).toBe("openai");
    expect(cacheDialectOf("gpt-5-codex")).toBe("openai");
    expect(cacheDialectOf("o3-mini")).toBe("openai");
    expect(cacheDialectOf("openai/o4-mini")).toBe("openai");
  });

  test("an endpoint pin never changes the engine", () => {
    expect(cacheDialectOf("openrouter/openai/gpt-5.6-luna@azure/eu")).toBe("openai");
    expect(cacheDialectOf("z-ai/glm-5.2@streamlake/fp8")).toBe("implicit");
  });

  test("gpt-oss is not OpenAI's cache", () => {
    // Open weights on Groq or OpenRouter: the name matches, the cache infrastructure does not,
    // so it must not be handed prompt_cache_key.
    expect(cacheDialectOf("openai/gpt-oss-120b")).toBe("implicit");
    expect(cacheDialectOf("gpt-oss-20b")).toBe("implicit");
    expect(cacheDialectOf("openai/gpt-oss-safeguard-20b")).toBe("implicit");
  });

  test("everything else is implicit", () => {
    expect(cacheDialectOf("deepseek/deepseek-v4-flash-vision-exp")).toBe("implicit");
    expect(cacheDialectOf("z-ai/glm-5.3")).toBe("implicit");
    expect(cacheDialectOf("google/gemini-3.7-flash")).toBe("implicit");
    expect(cacheDialectOf("Qwen3.6-35B-A3B-uncensored-MTP-Q5_K_M")).toBe("implicit");
    expect(cacheDialectOf("minimax-m3")).toBe("implicit");
    expect(cacheDialectOf("mimo-v2.5-pro")).toBe("implicit");
    expect(cacheDialectOf(undefined)).toBe("implicit");
    expect(cacheDialectOf("")).toBe("implicit");
  });

  test("a name that merely contains a family word is not that family", () => {
    // Guards the word-boundary anchors: a substring match would misroute these.
    expect(cacheDialectOf("olmo-2-13b")).toBe("implicit");
    expect(cacheDialectOf("hy-mt2-30b-a3b")).toBe("implicit");
    expect(cacheDialectOf("sonnet-writer-13b")).toBe("anthropic");
  });
});

describe("cacheAttributionOf", () => {
  test("names the transport and the dialect, wire id winning over identity", () => {
    expect(cacheAttributionOf({ backend: "codex", model: "gpt-5.6-luna" })).toEqual({
      backend: "codex",
      cacheDialect: "openai",
    });
    // A tag reference: the identity says nothing about the engine, the wire id decides.
    expect(cacheAttributionOf({ model: "tag:main", apiModel: "claude-opus-5" })).toEqual({
      backend: "openai",
      cacheDialect: "anthropic",
    });
  });

  test("an absent backend is the home OpenAI-compatible loop", () => {
    expect(cacheAttributionOf({ model: "deepseek/deepseek-v4-flash" }).backend).toBe("openai");
  });
});
