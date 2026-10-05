/**
 * What a 400 can ask us to change, and what happens when it asks.
 *
 * Two live failures on 2026-09-26, both on the same run of `opencode_go/deepseek-v4.1-flash`:
 * an Anthropic-only `cache_control` field reaching a DeepSeek model, and a thinking endpoint
 * demanding back the reasoning of turns we had stopped sending. Each one ended a run that had
 * minutes and dozens of tool calls behind it, because nothing read the refusal (docs/llm-request-repair.md).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chatCompletion, chatCompletionStream } from "../../src/llm/provider.ts";
import { cacheDialectOf } from "../../src/llm/cache-policy.ts";
import { repairFor, resetLearnedRepairs } from "../../src/llm/request-repair.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const base = { baseUrl: "https://proxy.test/v1", apiKey: "k", promptCache: true };

/** The refusals, verbatim, as the endpoint worded them. */
const CACHE_REFUSAL =
  "Upstream request failed: The parameter cache_control is not supported for the requested model. Please try again or contact support if you expect this parameter to be supported.";
const REASONING_REFUSAL =
  "Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: a2237cf0-1f56-4fc0-b23e)";

function body400(detail: string): Response {
  return new Response(JSON.stringify({ error: { message: detail } }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(content = "hello"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Capture = Array<Record<string, unknown>>;

function scriptedFetch(script: Array<() => Response>): Capture {
  const bodies: Capture = [];
  handles.push(
    mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = script.shift();
      if (!next) throw new Error("fetch called more times than the script allows");
      return next();
    }),
  );
  return bodies;
}

const messages: ChatMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hi" },
];

const handles: Array<{ restore(): void }> = [];

beforeEach(() => resetLearnedRepairs());
afterEach(() => {
  // Last made, first restored: each mock saved the one before it, and restoring them in the order
  // they were made left the first installed for every later file (the adapter's HTTP tests).
  for (const handle of handles.splice(0).reverse()) handle.restore();
});

describe("the cache hint is spoken in the dialect of the model being called", () => {
  test("a DeepSeek model is never sent cache_control, whatever the provider opts into", async () => {
    const bodies = scriptedFetch([() => ok()]);
    await chatCompletion({ ...base, model: "deepseek-v4.1-flash" }, messages);
    // This is the exact field the endpoint refused, on a model the dialect says speaks neither form.
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(bodies[0]!["prompt_cache_key"]).toBeUndefined();
  });

  test("a Claude model keeps its breakpoints", async () => {
    const bodies = scriptedFetch([() => ok()]);
    await chatCompletion({ ...base, model: "claude-sonnet-5" }, messages);
    expect(JSON.stringify(bodies[0])).toContain("cache_control");
  });

  test("an OpenAI model gets the key, and not the other dialect's field", async () => {
    const bodies = scriptedFetch([() => ok()]);
    await chatCompletion({ ...base, model: "gpt-5.6-luna", cacheKey: "thread-1" }, messages);
    expect(bodies[0]!["prompt_cache_key"]).toBe("thread-1");
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });

  test("with the opt-in off, a Claude model gets nothing either", async () => {
    const bodies = scriptedFetch([() => ok()]);
    await chatCompletion({ ...base, model: "claude-sonnet-5", promptCache: false }, messages);
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });
});

describe("a refusal that names a parameter is repaired, then remembered", () => {
  test("the same call is replayed without it, and the run continues", async () => {
    const bodies = scriptedFetch([() => body400(CACHE_REFUSAL), () => ok("survived")]);
    const response = await chatCompletion({ ...base, model: "claude-sonnet-5" }, messages);
    expect(response.content).toBe("survived");
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies[0])).toContain("cache_control");
    expect(JSON.stringify(bodies[1])).not.toContain("cache_control");
  });

  test("the next call to that endpoint does not pay the refusal again", async () => {
    scriptedFetch([() => body400(CACHE_REFUSAL), () => ok()]);
    await chatCompletion({ ...base, model: "claude-sonnet-5" }, messages);

    // A second call, scripted with a single answer: a second 400 would exhaust the script and fail.
    const bodies = scriptedFetch([() => ok()]);
    await chatCompletion({ ...base, model: "claude-sonnet-5" }, messages);
    expect(bodies.length).toBe(1);
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });

  test("a parameter we never set is still dropped by name, and the run continues", async () => {
    const bodies = scriptedFetch([
      () => body400("The parameter logprobs is not supported for the requested model."),
      () => ok("fine"),
    ]);
    const response = await chatCompletion({ ...base, model: "claude-sonnet-5" }, messages);
    expect(response.content).toBe("fine");
    expect(bodies.length).toBe(2);
  });
});

describe("a thinking endpoint gets its reasoning back", () => {
  const withForeignReasoning: ChatMessage[] = [
    { role: "system", content: "SYS" },
    {
      role: "assistant",
      content: "working",
      // Produced by another model than the one being called: the field used to be dropped here.
      providerMeta: { backend: "openai", model: "another-model", chat: { field: "reasoning_content", text: "the why" } },
    },
    { role: "user", content: "go" },
  ];

  test("the replay carries the field the endpoint demanded", async () => {
    const bodies = scriptedFetch([() => body400(REASONING_REFUSAL), () => ok("thought")]);
    const response = await chatCompletion({ ...base, model: "deepseek-v4.1-flash" }, withForeignReasoning);
    expect(response.content).toBe("thought");
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies[0])).not.toContain("the why");
    const replayed = (bodies[1]!["messages"] as Array<Record<string, unknown>>)[1]!;
    expect(replayed["reasoning_content"]).toBe("the why");
  });
});

describe("what is not in the table changes nothing", () => {
  test("an unknown 400 is thrown as itself, with no replay", async () => {
    const bodies = scriptedFetch([() => body400("something we have never seen")]);
    await expect(chatCompletion({ ...base, model: "claude-sonnet-5" }, messages)).rejects.toThrow(/something we have never seen/);
    expect(bodies.length).toBe(1);
  });

  test("a refusal whose repair would change nothing does not loop", () => {
    // The dialect already sent no hints: replaying the identical request would buy the same 400.
    const repair = repairFor(400, CACHE_REFUSAL);
    expect(repair?.id).toBe("drop-refused-parameter");
    const options = { cacheBreakpoints: false, cacheKey: false, forceReasoning: false, dropParameters: [] };
    expect(repair!.apply(options, CACHE_REFUSAL)).toBe(false);
  });
});

describe("the streaming path repairs the same way", () => {
  test("a refused parameter is dropped and the stream answers", async () => {
    const bodies: Capture = [];
    handles.push(
      mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (bodies.length === 1) return body400(CACHE_REFUSAL);
        const chunk = JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
        return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const tokens: string[] = [];
    const result = await chatCompletionStream({ ...base, model: "claude-sonnet-5" }, messages, token => void tokens.push(token));
    expect(tokens.join("")).toBe("ok");
    expect(result.content).toBe("ok");
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies[1])).not.toContain("cache_control");
  });
});

describe("the dialect table itself", () => {
  test("only Claude speaks the breakpoint form", () => {
    expect(cacheDialectOf("claude-sonnet-5")).toBe("anthropic");
    expect(cacheDialectOf("openrouter/anthropic/claude-opus-5")).toBe("anthropic");
    expect(cacheDialectOf("gpt-5.6-luna")).toBe("openai");
    expect(cacheDialectOf("deepseek-v4.1-flash")).toBe("implicit");
    expect(cacheDialectOf("glm-5.3")).toBe("implicit");
  });
});

describe("a balance that covers less than the ask: the ask is capped to it, once, and never remembered", () => {
  const OPENROUTER_402 = (n: number) =>
    `This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford ${n}. To increase, visit https://openrouter.ai/settings/credits`;
  const body402 = (n: number) =>
    new Response(JSON.stringify({ error: { message: OPENROUTER_402(n), code: 402 } }), { status: 402, headers: { "Content-Type": "application/json" } });
  const routed = { ...base, model: "z-ai/glm-5.3", promptCache: false, limit: { output: 131072 } };

  test("the same call is replayed asking for what can be paid, and answers", async () => {
    const bodies = scriptedFetch([() => body402(54608), () => ok("paid")]);
    const response = await chatCompletion(routed, messages);
    expect(response.content).toBe("paid");
    expect(bodies.map((b) => b["max_tokens"])).toEqual([131072, 54608]);
  });

  test("an ask the request never made is capped all the same: the model's whole output was reserved", async () => {
    const bodies = scriptedFetch([() => body402(54608), () => ok()]);
    await chatCompletion({ ...routed, limit: undefined }, messages);
    expect(bodies.map((b) => b["max_tokens"])).toEqual([undefined, 54608]);
  });

  test("the next call asks for its own again: a balance is not a fact about the endpoint", async () => {
    const bodies = scriptedFetch([() => body402(54608), () => ok(), () => ok()]);
    await chatCompletion(routed, messages);
    await chatCompletion(routed, messages);
    expect(bodies.map((b) => b["max_tokens"])).toEqual([131072, 54608, 131072]);
  });

  test("too little to answer with, or refused again: the 402 goes up, for the route to move on", async () => {
    scriptedFetch([() => body402(900)]);
    await expect(chatCompletion(routed, messages)).rejects.toThrow("can only afford 900");
    const twice = scriptedFetch([() => body402(54608), () => body402(30000)]);
    await expect(chatCompletion(routed, messages)).rejects.toThrow("can only afford 30000");
    expect(twice.length).toBe(2);
  });

  test("the stream is repaired the same way", async () => {
    const bodies = scriptedFetch([
      () => body402(54608),
      () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    ]);
    const tokens: string[] = [];
    await chatCompletionStream(routed, messages, (t) => {
      tokens.push(t);
    });
    expect(tokens.join("")).toBe("ok");
    expect(bodies[1]!["max_tokens"]).toBe(54608);
  });
});
