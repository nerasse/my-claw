import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { codexResponse, codexResponseStream } from "../../src/llm/codex.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { isOverflowError } from "../../src/llm/overflow.ts";
import { isQuotaSpent } from "../../src/llm/outage.ts";

function writeAuth(): void {
  mkdirSync(join(MY_CLAW_DIR, "accounts"), { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "accounts", "chatgpt.json"),
    JSON.stringify({ access: "access-tok", refresh: "refresh-tok", expires: Date.now() + 3_600_000, accountId: "acct-123" }),
  );
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

let mock: { restore(): void } | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
  // MY_CLAW_DIR is shared across test files; leaking a codex credential breaks
  // other suites that assume a fresh (logged-out) state.
  rmSync(join(MY_CLAW_DIR, "accounts"), { recursive: true, force: true });
});

const config: ResolvedLlmConfig = {
  backend: "codex",
  provider: "chatgpt",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5-codex",
  effort: "high",
};

const events = [
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash", arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":' },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '"ls"}' },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' } },
  { type: "response.output_text.delta", output_index: 1, delta: "Hello" },
  { type: "response.output_text.delta", output_index: 1, delta: " world" },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
];

test("codex transport builds a Responses request and parses the SSE stream", async () => {
  writeAuth();
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  mock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return sseResponse(events);
  });

  const messages: ChatMessage[] = [
    { role: "system", content: "SYS PROMPT" },
    { role: "user", content: "run ls" },
  ];
  const tools = [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object" } } }];
  const tokens: string[] = [];
  const res = await codexResponseStream(config, messages, (t) => { tokens.push(t); }, tools);

  assert.equal(capturedUrl, "https://chatgpt.com/backend-api/codex/responses");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, any>;
  assert.equal(body.model, "gpt-5-codex");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "SYS PROMPT");
  assert.deepEqual(body.input[0], { role: "user", content: "run ls" });
  assert.equal(body.tools[0].name, "bash");
  assert.equal(body.tools[0].type, "function");
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });

  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer access-tok");
  assert.equal(headers.get("chatgpt-account-id"), "acct-123");
  assert.equal(headers.get("originator"), "codex_cli_rs");

  assert.equal(res.content, "Hello world");
  assert.deepEqual(tokens, ["Hello", " world"]);
  assert.equal(res.toolCalls?.length, 1);
  assert.deepEqual(res.toolCalls?.[0], { id: "call_1", name: "bash", arguments: { cmd: "ls" } });
  assert.deepEqual(res.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test("codex transport maps assistant tool calls and tool results to Responses items", async () => {
  writeAuth();
  let body: Record<string, any> = {};
  mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  });

  const messages: ChatMessage[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "let me check", tool_calls: [{ id: "call_9", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] },
    { role: "tool", tool_call_id: "call_9", content: "file.txt" },
  ];
  await codexResponse(config, messages, undefined);

  assert.deepEqual(body.input[1], { role: "assistant", content: "let me check" });
  assert.deepEqual(body.input[2], { type: "function_call", call_id: "call_9", name: "bash", arguments: '{"cmd":"ls"}' });
  assert.deepEqual(body.input[3], { type: "function_call_output", call_id: "call_9", output: "file.txt" });
});

test("codex transport surfaces a response.failed event as an error", async () => {
  writeAuth();
  mock = mockFetch(async () =>
    sseResponse([{ type: "response.failed", response: { error: { code: "invalid_prompt", message: "boom" } } }]));
  await assert.rejects(codexResponse(config, [{ role: "user", content: "hi" }], undefined), /Codex invalid_prompt: boom/);
});

test("codex pins the implicit prefix cache to the conversation", async () => {
  writeAuth();
  let capturedInit: RequestInit | undefined;
  mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return sseResponse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  });

  await codexResponse({ ...config, cacheKey: "thread-42" }, [{ role: "user", content: "hi" }]);

  const body = JSON.parse(String(capturedInit?.body)) as Record<string, any>;
  assert.equal(body.prompt_cache_key, "thread-42");
  // The ChatGPT backend routes its cache on this header, not on the body key: without it every
  // call read 0 cached tokens (measured 2026-10-09).
  assert.equal(new Headers(capturedInit?.headers).get("session-id"), "thread-42");
  // The key is what makes store:false survivable: nothing is kept server-side, so the request
  // itself has to say which cache it belongs to.
  assert.equal(body.store, false);
});

test("codex omits the key when no conversation named one", async () => {
  writeAuth();
  let capturedInit: RequestInit | undefined;
  mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return sseResponse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  });

  await codexResponse(config, [{ role: "user", content: "hi" }]);

  const body = JSON.parse(String(capturedInit?.body)) as Record<string, any>;
  assert.equal("prompt_cache_key" in body, false);
  assert.equal(new Headers(capturedInit?.headers).has("session-id"), false);
});

test("a tool's images ride its function_call_output as output items", async () => {
  writeAuth();
  let body: Record<string, unknown> | undefined;
  mock = mockFetch(async (_u, init) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return sseResponse([
      { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "seen" }] } },
      { type: "response.completed" },
    ]);
  });
  await codexResponse(config, [
    { role: "system", content: "sys" },
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "text", text: "Image read successfully" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ]);
  const input = (body as { input: Array<Record<string, unknown>> }).input;
  const out = input.find((i) => i["type"] === "function_call_output") as { output: unknown };
  const items = out.output as Array<{ type: string; text?: string; image_url?: string }>;
  assert.deepEqual(items.map((i) => i.type), ["input_text", "input_image"]);
  assert.equal(items[1]!.image_url, "data:image/png;base64,AAAA");
});

/**
 * A spent plan limit costs one request, not three.
 *
 * The Codex transport retried every retryable status, 429 included, without asking whether the
 * refusal was the plan running dry. Measured 2026-10-27 on `chatgpt-2`: three requests per turn,
 * four turns (30 s, 60 s, 120 s), twelve requests for one wall.
 */
test("a spent plan limit is not retried by the transport", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    return new Response(
      JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  });
  await assert.rejects(() => codexResponse(config, [{ role: "user", content: "go" }], undefined), /usage limit/i);
  assert.equal(requests, 1, "one request, then the caller's fallback owns the decision");
});

test("a rate limit is still retried by the transport: it clears on its own", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    // Fails every time here: what is pinned is that the transport *tried* again, which is the
    // behaviour a spent quota must not get.
    return new Response(
      JSON.stringify({ error: { type: "rate_limit_error", message: "Too many concurrent requests" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  });
  await assert.rejects(() => codexResponse(config, [{ role: "user", content: "go" }], undefined));
  assert.equal(requests, 3, "three attempts, as every other retryable status gets");
});

/**
 * The one that killed 34-minute runs (2026-11-05).
 *
 * The backend announces a failure from inside the stream with its code nested under `error`; this
 * transport read the root, so the message said "Codex stream error : unknown" and every one of them
 * was fatal. The official client maps an unknown code to a retryable error, and so does this now.
 */
test("a stream error's code is read wherever the backend put it", async () => {
  writeAuth();
  mock = mockFetch(async () => sseResponse([{ type: "error", error: { code: "usage_not_included", message: "the wire said no" } }]));
  await assert.rejects(
    () => codexResponse(config, [{ role: "user", content: "hi" }], undefined),
    /Codex usage_not_included: the wire said no/,
  );
});

test("the nested type stands in for a missing code", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    return sseResponse([{ type: "error", error: { type: "cyber_policy", message: "flagged for cyber risk" } }]);
  });
  await assert.rejects(
    () => codexResponse(config, [{ role: "user", content: "hi" }], undefined),
    /policy violation \(cyber_policy\): flagged for cyber risk/,
  );
  assert.equal(requests, 1, "a policy refusal is a verdict, not something to replay");
});

test("an unnamed stream error is replayed instead of ending the run", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    if (requests === 1) return sseResponse([{ type: "error" }]);
    return sseResponse([
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
  });
  const res = await codexResponse(config, [{ role: "user", content: "hi" }], undefined);
  assert.equal(requests, 2);
  assert.equal(res.content, "ok");
});

test("a replay takes back what the dead attempt painted", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    if (requests === 1) {
      return sseResponse([
        { type: "response.output_text.delta", output_index: 0, delta: "half an ans" },
        { type: "error" },
      ]);
    }
    return sseResponse([
      { type: "response.output_text.delta", output_index: 0, delta: "the answer" },
      { type: "response.completed" },
    ]);
  });
  const tokens: string[] = [];
  let restarts = 0;
  const res = await codexResponseStream(
    config,
    [{ role: "user", content: "hi" }],
    (t) => { tokens.push(t); },
    undefined,
    undefined,
    { onRestart: async () => { restarts += 1; } },
  );
  assert.equal(restarts, 1, "the channel was told to erase the failed attempt");
  assert.deepEqual(tokens, ["half an ans", "the answer"]);
  assert.equal(res.content, "the answer");
});

test("without a channel that can erase, a stream that already painted is not replayed", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    return sseResponse([
      { type: "response.output_text.delta", output_index: 0, delta: "half an ans" },
      { type: "error" },
    ]);
  });
  await assert.rejects(
    () => codexResponseStream(config, [{ role: "user", content: "hi" }], () => {}),
    /stream error/,
  );
  assert.equal(requests, 1, "a retry nobody can erase would say the answer twice");
});

test("a spent plan announced mid-stream is not replayed", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    return sseResponse([
      { type: "error", error: { code: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 900 } },
    ]);
  });
  const err = await codexResponse(config, [{ role: "user", content: "hi" }], undefined).catch((e: unknown) => e);
  assert.equal(requests, 1, "no backoff refills a plan");
  assert.match(String((err as Error).message), /quota exhausted \(usage_limit_reached\)/);
  assert.equal((err as { status?: number }).status, 429);
  assert.equal((err as { resetInSeconds?: number }).resetInSeconds, 900);
  assert.equal(isQuotaSpent(err), true);
});

test("a context overflow announced mid-stream stays an overflow", async () => {
  writeAuth();
  mock = mockFetch(async () =>
    sseResponse([{ type: "error", error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } }]));
  const err = await codexResponse(config, [{ role: "user", content: "hi" }], undefined).catch((e: unknown) => e);
  assert.equal(isOverflowError(err), true);
});

test("a stream that keeps dying stops after its own budget", async () => {
  writeAuth();
  let requests = 0;
  mock = mockFetch(async () => {
    requests += 1;
    // `retry_after` in seconds, tiny: the delay is the server's, so five attempts cost milliseconds
    // and the count is what this pins.
    return sseResponse([
      { type: "error", error: { code: "rate_limit_exceeded", message: "slow down", retry_after: 0.001 } },
    ]);
  });
  await assert.rejects(() => codexResponse(config, [{ role: "user", content: "go" }], undefined), /rate limit/);
  assert.equal(requests, 5, "five attempts, then the caller's fallback owns the decision");
});
