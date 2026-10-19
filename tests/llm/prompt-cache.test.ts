import { describe, test, expect } from "bun:test";
import { applyPromptCache, chatCompletion, chatCompletionStream, type ChatMessage } from "../../src/llm/provider.ts";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import type { LlmConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseResponse } from "../helpers/sse.ts";

const EPHEMERAL = { type: "ephemeral" };

describe("applyPromptCache", () => {
  test("marks the system message, the last user turn and the last message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply" },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const wire = applyPromptCache(messages);

    // System (index 0): string promoted to a text part carrying the breakpoint.
    expect(wire[0]!["content"]).toEqual([{ type: "text", text: "SYS", cache_control: EPHEMERAL }]);
    // The owner's turn: the point the next request still shares.
    expect(wire[1]!["content"]).toEqual([{ type: "text", text: "hi", cache_control: EPHEMERAL }]);
    expect(wire[2]!["content"]).toBe("reply");
    // Last message (tool result) carries the rolling breakpoint + keeps tool_call_id.
    expect(wire[3]!["content"]).toEqual([{ type: "text", text: "result", cache_control: EPHEMERAL }]);
    expect(wire[3]!["tool_call_id"]).toBe("c1");
  });

  test("attaches the breakpoint to the last part of array content", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ],
      },
    ];
    const wire = applyPromptCache(messages);
    const parts = wire[1]!["content"] as Array<Record<string, unknown>>;
    expect(parts[0]!["cache_control"]).toBeUndefined();
    expect(parts[1]!["cache_control"]).toEqual(EPHEMERAL);
  });

  test("preserves assistant tool_calls when the assistant message is last", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ];
    const wire = applyPromptCache(messages);
    expect(wire[1]!["tool_calls"]).toBeDefined();
    expect(wire[1]!["content"]).toEqual([{ type: "text", text: "calling", cache_control: EPHEMERAL }]);
  });

  test("does not mark an empty-string last message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "assistant", content: "" },
    ];
    const wire = applyPromptCache(messages);
    expect(wire[1]!["content"]).toBe("");
  });

  test("single system message gets exactly one breakpoint (not double-marked)", () => {
    const wire = applyPromptCache([{ role: "system", content: "SYS" }]);
    expect(wire.length).toBe(1);
    expect(wire[0]!["content"]).toEqual([{ type: "text", text: "SYS", cache_control: EPHEMERAL }]);
  });
});

describe("buildRequestBody prompt cache gating", () => {
  const base = { baseUrl: "https://example.com", model: "m", apiKey: "k" };

  async function capture(promptCache: boolean, model: string = "m"): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await chatCompletion({ ...base, model, promptCache }, [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ]);
      return bodies[0]!;
    } finally {
      mock.restore();
    }
  }

  test("off: messages stay plain strings (no cache_control)", async () => {
    const body = await capture(false);
    const messages = body["messages"] as Array<{ content: unknown }>;
    expect(messages[0]!.content).toBe("SYS");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  test("on: a Claude model carries cache_control on the system message and the last one", async () => {
    const body = await capture(true, "claude-sonnet-5");
    const messages = body["messages"] as Array<{ content: unknown }>;
    expect(Array.isArray(messages[0]!.content)).toBe(true);
    expect(JSON.stringify(body)).toContain("cache_control");
  });

  test("on: a model that speaks neither dialect gets no hint at all", async () => {
    // `cache_control` is Anthropic's spelling. Sending it to a DeepSeek model is what answered
    // 400 on 2026-09-26, after twenty-three tool calls and four minutes of work.
    const body = await capture(true, "deepseek-v4.1-flash");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("resolver promptCache propagation", () => {
  const cfg: LlmConfig = {
    defaultProvider: "proxy",
    defaultModel: "m",
    providers: {
      proxy: { baseUrl: "https://proxy/v1", promptCache: true },
      anthropic: { type: "anthropic", promptCache: true },
    },
    models: [
      { id: "m", label: "M", provider: "proxy" },
      { id: "claude", label: "C", provider: "anthropic" },
    ],
  };

  test("openai provider carries promptCache through to the resolved config", () => {
    expect(resolveLlmConfig(cfg, "m").promptCache).toBe(true);
  });

  test("the native anthropic backend caches on its own, so the flag is not propagated", () => {
    // The Messages transport marks its own cache breakpoints; an OpenAI-shaped `promptCache` flag
    // has nothing to translate into on that path.
    const resolved = resolveLlmConfig(cfg, "claude");
    expect(resolved.backend).toBe("anthropic");
    expect(resolved.promptCache).toBeUndefined();
  });
});

describe("prompt_cache_key by model family", () => {
  const base = { baseUrl: "https://example.com", apiKey: "k" };

  async function capture(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await chatCompletion({ ...base, ...config } as never, [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ]);
      return bodies[0]!;
    } finally {
      mock.restore();
    }
  }

  test("an OpenAI engine resold on a compatible endpoint gets the key", async () => {
    const body = await capture({ model: "openai/gpt-5.6-luna", promptCache: true, cacheKey: "sess-1" });
    expect(body["prompt_cache_key"]).toBe("sess-1");
  });

  test("the wire id decides, not the run identity", async () => {
    const body = await capture({ model: "tag:main", apiModel: "gpt-5.4", promptCache: true, cacheKey: "sess-2" });
    expect(body["prompt_cache_key"]).toBe("sess-2");
  });

  // The regression guards: these three families are at 91-97% cache-read in production and
  // nothing about their request may move.
  test("an Anthropic engine keeps breakpoints and gets no key", async () => {
    const body = await capture({ model: "anthropic/claude-sonnet-5", promptCache: true, cacheKey: "sess-3" });
    expect(body["prompt_cache_key"]).toBeUndefined();
    expect(JSON.stringify(body)).toContain("cache_control");
  });

  test("an implicit-cache engine gets neither key nor breakpoints", async () => {
    // The name of this test used to promise the breakpoints were kept, which was the bug stated
    // as a fact: they are the other dialect's spelling, and this engine reads neither.
    const body = await capture({ model: "deepseek/deepseek-v4-flash-vision-exp", promptCache: true, cacheKey: "sess-4" });
    expect(body["prompt_cache_key"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  test("no key without the provider opt-in, and none without a session", async () => {
    expect((await capture({ model: "gpt-5.6-luna", promptCache: false, cacheKey: "s" }))["prompt_cache_key"]).toBeUndefined();
    expect((await capture({ model: "gpt-5.6-luna", promptCache: true }))["prompt_cache_key"]).toBeUndefined();
  });
});

describe("an endpoint that refuses the cached content shape", () => {
  // A Claude id: it is the only dialect we still send breakpoints to, so it is the only place a
  // refusal of that shape can still arise. The contract below is unchanged.
  const base = { baseUrl: "https://refusing.example.com", model: "claude-sonnet-5", apiKey: "k" };
  const messages: ChatMessage[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
  ];
  const REFUSAL = '{"error":{"type":"invalid_request_error","message":"4 request validation errors: Input should be a valid string, field: \'messages[0].content.str\'"}}';

  function answering(): { bodies: Array<Record<string, unknown>>; restore: () => void } {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      bodies.push(body);
      // Strict validation, like the upstream that refused the parts form: a string content is
      // fine, a content array is not.
      const first = (body["messages"] as Array<{ content: unknown }>)[0]!;
      if (Array.isArray(first.content)) {
        return new Response(REFUSAL, { status: 400, headers: { "Content-Type": "application/json" } });
      }
      // The streaming transport reads SSE; a finished JSON body is a null stream to it.
      return body["stream"] === true
        ? sseResponse("ok")
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return { bodies, restore: () => mock.restore() };
  }

  test("is resent without the hints, and the answer lands", async () => {
    // Measured 2026-09-21 on `opencode_go/glm-5.3`: an upstream that validates the content shape
    // strictly answers 400 to the parts form our cache hints produce. The request was fine -- and
    // since the dialect fix, such a model is not sent the parts form in the first place.
    const { bodies, restore } = answering();
    try {
      const response = await chatCompletion({ ...base, promptCache: true }, messages);
      expect(response.content).toBe("ok");
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[0])).toContain("cache_control");
      expect(JSON.stringify(bodies[1])).not.toContain("cache_control");
      expect((bodies[1]!["messages"] as Array<{ content: unknown }>)[0]!.content).toBe("SYS");
    } finally {
      restore();
    }
  });

  test("is remembered: the next call sends the plain form straight away", async () => {
    const { bodies, restore } = answering();
    try {
      await chatCompletion({ ...base, promptCache: true }, messages);
      const before = bodies.length;
      await chatCompletion({ ...base, promptCache: true }, messages);
      // One request, not two: the round trip is paid once per model, not once per call.
      expect(bodies.length - before).toBe(1);
      expect(JSON.stringify(bodies[bodies.length - 1])).not.toContain("cache_control");
    } finally {
      restore();
    }
  });

  test("the streaming path does the same", async () => {
    const { bodies, restore } = answering();
    try {
      const tokens: string[] = [];
      const response = await chatCompletionStream({ ...base, promptCache: true }, messages, (t) => void tokens.push(t));
      expect(response.content).toBe("ok");
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1])).not.toContain("cache_control");
    } finally {
      restore();
    }
  });

  test("a 400 that is not about the shape is left alone", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response('{"error":{"message":"model does not exist"}}', { status: 400, headers: { "Content-Type": "application/json" } });
    });
    try {
      await expect(chatCompletion({ ...base, promptCache: true }, messages)).rejects.toThrow(/does not exist/);
      expect(bodies).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });
});
