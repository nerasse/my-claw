import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { codexResponse, codexResponseStream } from "../../src/llm/codex.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

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
    sseResponse([{ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }]));
  await assert.rejects(codexResponse(config, [{ role: "user", content: "hi" }], undefined), /server_error: boom/);
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
