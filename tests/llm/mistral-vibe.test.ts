import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LlmConfig, ResolvedLlmConfig } from "../../src/core/config.ts";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import { ModelCatalog } from "../../src/llm/catalog.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage, type ProviderMeta } from "../../src/llm/provider.ts";
import { mistralQuota } from "../../src/llm/quota/mistral.ts";
import { quotaSourceOf } from "../../src/llm/quota/index.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const KEY = "test-mistral-key";

beforeEach(() => {
  process.env["MISTRAL_API_KEY"] = KEY;
});

afterEach(() => {
  delete process.env["MISTRAL_API_KEY"];
});

function llm(): LlmConfig {
  return {
    defaultProvider: "mistral_vibe",
    defaultModel: "mistral_vibe/mistral-large-4-0",
    providers: { mistral_vibe: { type: "mistral-vibe", group: "Mistral Vibe" } },
    models: [
      {
        id: "mistral_vibe/mistral-large-4-0",
        label: "Mistral Large 4",
        apiId: "mistral-large-4-0",
        provider: "mistral_vibe",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        vision: true,
        limit: { context: 1_048_576 },
      },
    ],
  };
}

function sseResponse(frames: unknown[]): Response {
  const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): Record<string, unknown> {
  return {
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

const THINKING_AND_TEXT = [
  { type: "thinking", thinking: [{ type: "text", text: "Weighing" }], closed: true },
  { type: "thinking", thinking: [{ type: "text", text: " it." }], closed: true },
  { type: "text", text: "OK" },
];

describe("the Mistral Vibe provider", () => {
  test("resolves to the Vibe fingerprint, the Mistral endpoint and the one reasoning field that works", () => {
    const resolved = resolveLlmConfig(llm(), "mistral_vibe/mistral-large-4-0", "high");
    expect(resolved.mistralVibe).toBe(true);
    expect(resolved.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(resolved.apiKey).toBe(KEY);
    expect(resolved.effort).toBe("high");
    // Anthropic cache_control is a 422 on Mistral, so the bearer request never carries it.
    expect(resolved.promptCache).toBe(false);
    // `reasoning_content` is `422 extra_forbidden`; the assistant content parts are the only shape.
    expect(resolved.reasoningField).toBe("mistral_content");
  });

  test("the request claims Vibe, bills the Vibe allowance, and reads thinking out of content parts", async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const mock = mockFetch(async (_url, init) => {
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: THINKING_AND_TEXT }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const resolved = resolveLlmConfig(llm(), "mistral_vibe/mistral-large-4-0", "high");
      const reply = await chatCompletion(resolved, [{ role: "user", content: "say OK" }], undefined, undefined);

      expect(headers["user-agent"]).toBe("mistral-client-python/Mistral-Vibe/3.1.5");
      expect(headers["x-affinity"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(body["parallel_tool_calls"]).toBe(true);
      expect((body["metadata"] as Record<string, string>)["call_source"]).toBe("vibe_code");
      expect((body["metadata"] as Record<string, string>)["session_id"]).toBe(headers["x-affinity"]);

      expect(reply.content).toBe("OK");
      expect(reply.reasoning).toBe("Weighing it.");
      expect(reply.providerMeta?.chat?.field).toBe("mistral_content");
      expect(reply.providerMeta?.chat?.details).toEqual([
        { type: "thinking", thinking: [{ type: "text", text: "Weighing it." }] },
        { type: "text", text: "OK" },
      ]);
    } finally {
      mock.restore();
    }
  });

  test("a streamed turn separates thinking from text and replays both as content parts", async () => {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const mock = mockFetch(async () =>
      sseResponse([
        chunk({ role: "assistant", content: "" }),
        chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "Weighing" }], closed: true }] }),
        chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: " it." }], closed: true }] }),
        chunk({ content: [{ type: "text", text: "OK" }] }, "stop", {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
      ]),
    );
    let reply;
    try {
      const resolved = resolveLlmConfig(llm(), "mistral_vibe/mistral-large-4-0", "high");
      reply = await chatCompletionStream(
        resolved,
        [{ role: "user", content: "say OK" }],
        (token) => {
          tokens.push(token);
        },
        undefined,
        undefined,
        { onText: async (text) => {
          thoughts.push(text);
        } },
      );
    } finally {
      mock.restore();
    }

    expect(tokens.join("")).toBe("OK");
    expect(thoughts.join("")).toBe("Weighing it.");
    expect(reply.content).toBe("OK");
    expect(reply.reasoning).toBe("Weighing it.");
    expect(reply.providerMeta?.chat?.details).toEqual([
      { type: "thinking", thinking: [{ type: "text", text: "Weighing it." }] },
      { type: "text", text: "OK" },
    ]);
  });

  test("the next call carries the parts back on the assistant message, never reasoning_content", async () => {
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const mock = mockFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      return new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const meta: ProviderMeta = {
      backend: "openai",
      model: "mistral-large-4-0",
      chat: {
        field: "mistral_content",
        details: [
          { type: "thinking", thinking: [{ type: "text", text: "Weighing it." }] },
          { type: "text", text: "OK" },
        ],
      },
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "say OK" },
      {
        role: "assistant",
        content: "OK",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
        providerMeta: meta,
      },
      { role: "tool", tool_call_id: "call_1", content: "hi" },
    ];
    try {
      const resolved: ResolvedLlmConfig = resolveLlmConfig(llm(), "mistral_vibe/mistral-large-4-0", "high");
      await chatCompletion(resolved, messages);
    } finally {
      mock.restore();
    }

    const assistant = body!.messages.find((message) => message["role"] === "assistant")!;
    expect(assistant["content"]).toEqual(meta.chat!.details!);
    expect(assistant["prefix"]).toBe(false);
    expect(assistant["reasoning_content"]).toBeUndefined();
  });
});

describe("the Mistral model listing", () => {
  test("discovery keeps chat models with their context and vision, and drops the rest", async () => {
    const mock = mockFetch(async (url) => {
      if (!String(url).endsWith("/models")) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "mistral-large-4-0",
              capabilities: { completion_chat: true, vision: true, reasoning: true },
              max_context_length: 1_048_576,
            },
            { id: "mistral-embed-2312", capabilities: { completion_chat: false, embedding: true }, max_context_length: 8_192 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const config: LlmConfig = {
        providers: { mistral_vibe: { type: "mistral-vibe", discover: true, group: "Mistral Vibe" } },
        models: [],
      };
      const catalog = new ModelCatalog(() => config);
      await catalog.refresh();
      const discovered = catalog.discovered();
      expect(discovered.map((model) => model.id)).toEqual(["mistral_vibe/mistral-large-4-0"]);
      expect(discovered[0]?.limit?.context).toBe(1_048_576);
      expect(discovered[0]?.vision).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

describe("the Mistral billing API", () => {
  test("the provider type is what routes it to the billing reader", () => {
    expect(quotaSourceOf({ type: "mistral-vibe" })).toBe("mistral");
  });

  test("reads the Vibe allowance and the API pool as two separate purses", async () => {
    const mock = mockFetch(async (url) => {
      if (String(url).endsWith("/billing/budget")) {
        return new Response(
          JSON.stringify({
            vibe_budget: { usage_percentage: 5, initial_budget: 100, currency: "EUR", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
            api_budget: { usage_percentage: 0, initial_budget: 51, currency: "EUR", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).endsWith("/users/me")) {
        return new Response(
          JSON.stringify({
            email: "owner@example.com",
            workspace: { id: "w1", name: "Default Workspace" },
            organization: { id: "o1", name: "Example Org" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ plan_name: "TEAM", payg_enabled: false, vibe_payg_enabled: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const probe = await mistralQuota("mistral_vibe", KEY);
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      expect(probe.snapshot.plan).toBe("TEAM");
      expect(probe.snapshot.email).toBe("owner@example.com");
      expect(probe.snapshot.extras).toEqual([
        { label: "Organization", value: "Example Org" },
        { label: "Workspace", value: "Default Workspace" },
      ]);
      expect(probe.snapshot.windows).toEqual([
        { id: "vibe", label: "Vibe", usedPercent: 5, windowSeconds: 2_628_000, resetAt: "2026-12-01T00:00:00.000Z" },
      ]);
      expect(probe.snapshot.balances).toEqual([
        { id: "vibe", label: "Vibe credits", currency: "EUR", remaining: 95, total: 100 },
        { id: "api", label: "API credits", currency: "EUR", remaining: 51, total: 51 },
      ]);
    } finally {
      mock.restore();
    }
  });
});
