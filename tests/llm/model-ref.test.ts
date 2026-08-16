import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseModelRef, formatModelRef, withoutEndpoint, bareIdOf, usageModelOf } from "../../src/llm/model-ref.ts";

const PROVIDERS = ["litellm", "openrouter", "anthropic", "opencode_go"];

test("a bare id names no provider, whatever it looks like", () => {
  assert.deepEqual(parseModelRef("claude-opus-5", PROVIDERS), { apiId: "claude-opus-5" });
});

test("a known head is the provider, an unknown one is part of the id", () => {
  assert.deepEqual(parseModelRef("opencode_go/mimo-v2.5", PROVIDERS), {
    provider: "opencode_go",
    apiId: "mimo-v2.5",
  });
  // OpenRouter ids carry a slash of their own: without the provider table this would be read as
  // provider "openai", and every reference written before this existed would move.
  assert.deepEqual(parseModelRef("openai/gpt-5.6-luna", PROVIDERS), { apiId: "openai/gpt-5.6-luna" });
});

test("the pin is split off before the provider, and may contain a slash", () => {
  assert.deepEqual(parseModelRef("openrouter/openai/gpt-5.6-luna@azure/eu", PROVIDERS), {
    provider: "openrouter",
    apiId: "openai/gpt-5.6-luna",
    endpoint: "azure/eu",
  });
  assert.deepEqual(parseModelRef("openrouter/openai/gpt-5.6-luna@openai/flex", PROVIDERS), {
    provider: "openrouter",
    apiId: "openai/gpt-5.6-luna",
    endpoint: "openai/flex",
  });
});

test("formatting is the inverse of parsing", () => {
  for (const ref of [
    "claude-opus-5",
    "opencode_go/mimo-v2.5",
    "openai/gpt-5.6-luna",
    "openrouter/openai/gpt-5.6-luna@azure/eu",
  ]) {
    assert.equal(formatModelRef(parseModelRef(ref, PROVIDERS)), ref);
  }
});

test("degenerate strings parse instead of throwing", () => {
  assert.deepEqual(parseModelRef("", PROVIDERS), { apiId: "" });
  // A leading separator is not a provider and not a pin: the id keeps it rather than losing a half.
  assert.deepEqual(parseModelRef("/model", PROVIDERS), { apiId: "/model" });
  assert.deepEqual(parseModelRef("@tag", PROVIDERS), { apiId: "@tag" });
  assert.deepEqual(parseModelRef("model@", PROVIDERS), { apiId: "model" });
});

test("withoutEndpoint drops the pin and only the pin", () => {
  assert.equal(withoutEndpoint("openrouter/x@azure/eu"), "openrouter/x");
  assert.equal(withoutEndpoint("openrouter/x"), "openrouter/x");
});

test("bareIdOf strips the addressing, keeps the name", () => {
  assert.equal(bareIdOf("opencode_go/mimo-v2.5", PROVIDERS), "mimo-v2.5");
  assert.equal(bareIdOf("openrouter/openai/gpt-5.6-luna@azure/eu", PROVIDERS), "openai/gpt-5.6-luna");
});

// A tag resolves away in analytics so a later tag edit cannot rewrite history, but the endpoint
// stays: two endpoints of one model are two different bills, which is the reason for all of this.
test("usageModelOf files a row under the wire id plus its endpoint", () => {
  assert.equal(usageModelOf({ model: "tag:Smart", apiModel: "claude-opus-5" }), "claude-opus-5");
  assert.equal(usageModelOf({ model: "litellm/mimo" }), "litellm/mimo");
  assert.equal(
    usageModelOf({ model: "openrouter/openai/gpt-5.6-luna@azure/eu", apiModel: "openai/gpt-5.6-luna", providerRoute: "azure/eu" }),
    "openai/gpt-5.6-luna@azure/eu",
  );
});
