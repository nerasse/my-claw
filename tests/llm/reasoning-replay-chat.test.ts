import { describe, expect, test } from "bun:test";
import { chatCompletion, type ChatMessage, type ProviderMeta } from "../../src/llm/provider.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const BASE: ResolvedLlmConfig = { baseUrl: "https://example.com/v1", model: "deepseek-reasoner" };

function reply(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Runs one call and hands back both the body that went out and the response that came in. */
async function call(
  config: Partial<ResolvedLlmConfig>,
  messages: ChatMessage[],
  message: Record<string, unknown> = { content: "ok" },
): Promise<{ body: { messages: Array<Record<string, unknown>> }; meta?: ProviderMeta }> {
  let body: { messages: Array<Record<string, unknown>> } | undefined;
  const mock = mockFetch(async (_u, init) => {
    body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<Record<string, unknown>> };
    return reply(message) as never;
  });
  try {
    const response = await chatCompletion({ ...BASE, ...config }, messages);
    return { body: body!, meta: response.providerMeta };
  } finally {
    mock.restore();
  }
}

const USER: ChatMessage[] = [{ role: "user", content: "go" }];

const assistantWith = (meta: ProviderMeta): ChatMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: "on it", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }], providerMeta: meta },
  { role: "tool", tool_call_id: "c1", content: "out" },
];

describe("chat-completions reasoning capture", () => {
  test("a model that publishes reasoning_content gets its text captured", async () => {
    const { meta } = await call({ reasoningField: "reasoning_content" }, USER, { content: "ok", reasoning_content: "weighing it" });
    expect(meta).toEqual({ backend: "openai", model: "deepseek-reasoner", chat: { field: "reasoning_content", text: "weighing it" } });
  });

  test("a model that publishes nothing gets nothing captured", async () => {
    // models.dev leaves `interleaved` off most models, and guessing a field name is how you send
    // a body a strict endpoint rejects.
    const { meta } = await call({}, USER, { content: "ok", reasoning_content: "weighing it" });
    expect(meta).toBeUndefined();
  });

  test("reasoningReplay=false captures nothing", async () => {
    const { meta } = await call({ reasoningField: "reasoning_content", reasoningReplay: false }, USER, { content: "ok", reasoning_content: "x" });
    expect(meta).toBeUndefined();
  });

  test("a reasoning_details model captures the array verbatim, not the text", async () => {
    const details = [{ type: "reasoning.encrypted", data: "OPAQUE" }];
    const { meta } = await call({ reasoningField: "reasoning_details" }, USER, { content: "ok", reasoning: "summary", reasoning_details: details });
    expect(meta?.chat).toEqual({ field: "reasoning_details", details });
  });

  test("a reasoning_details model with only text captures nothing: a string is not that shape", async () => {
    const { meta } = await call({ reasoningField: "reasoning_details" }, USER, { content: "ok", reasoning_content: "just text" });
    expect(meta).toBeUndefined();
  });
});

describe("chat-completions reasoning replay", () => {
  const META: ProviderMeta = { backend: "openai", model: "deepseek-reasoner", chat: { field: "reasoning_content", text: "weighing it" } };

  test("the captured text rides back on the assistant message", async () => {
    const { body } = await call({ reasoningField: "reasoning_content" }, assistantWith(META));
    const assistant = body.messages.find((m) => m["role"] === "assistant")!;
    expect(assistant["reasoning_content"]).toBe("weighing it");
    expect(assistant["tool_calls"]).toBeDefined();
  });

  test("an empty captured string is still sent: DeepSeek requires the field to be present", async () => {
    const empty: ProviderMeta = { ...META, chat: { field: "reasoning_content", text: "" } };
    const { body } = await call({ reasoningField: "reasoning_content" }, assistantWith(empty));
    expect(body.messages.find((m) => m["role"] === "assistant")!["reasoning_content"]).toBe("");
  });

  test("a details array rides back under its own field", async () => {
    const details = [{ type: "reasoning.encrypted", data: "OPAQUE" }];
    const meta: ProviderMeta = { backend: "openai", model: "deepseek-reasoner", chat: { field: "reasoning_details", details } };
    const { body } = await call({ reasoningField: "reasoning_details" }, assistantWith(meta));
    const assistant = body.messages.find((m) => m["role"] === "assistant")!;
    expect(assistant["reasoning_details"]).toEqual(details);
    expect(assistant["reasoning_content"]).toBeUndefined();
  });

  test("prompt caching on or off, the same fields go out", async () => {
    const off = await call({ reasoningField: "reasoning_content" }, assistantWith(META));
    const on = await call({ reasoningField: "reasoning_content", promptCache: true }, assistantWith(META));
    for (const body of [off.body, on.body]) {
      const assistant = body.messages.find((m) => m["role"] === "assistant")!;
      expect(assistant["reasoning_content"]).toBe("weighing it");
      expect(assistant["providerMeta"]).toBeUndefined();
    }
  });
});

describe("chat-completions metadata containment", () => {
  /**
   * The regression that mattered: the body was built from the raw `ChatMessage[]` whenever prompt
   * caching was off, so `providerMeta` -- internal, opaque, model-bound state -- was serialized
   * straight onto the wire. `toWireMessage` was the fence and this path walked around it.
   */
  test("providerMeta itself never reaches the wire, cache on or off", async () => {
    const meta: ProviderMeta = {
      backend: "codex",
      model: "gpt-5-codex",
      reasoning: [{ id: "rs_1", encrypted: "SECRET-BLOB" }],
      thinking: [{ type: "thinking", thinking: "private", signature: "SIG" }],
    };
    for (const promptCache of [false, true]) {
      const { body } = await call({ promptCache }, assistantWith(meta));
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("providerMeta");
      expect(raw).not.toContain("SECRET-BLOB");
      expect(raw).not.toContain("SIG");
    }
  });
});
