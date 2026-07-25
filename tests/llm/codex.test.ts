import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { codexResponse, codexResponseStream } from "../../src/llm/codex.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

function writeAuth(): void {
  mkdirSync(join(MY_CLAW_DIR, "codex"), { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "codex", "auth.json"),
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // MY_CLAW_DIR is shared across test files; leaking a codex credential breaks
  // other suites that assume a fresh (logged-out) state.
  rmSync(join(MY_CLAW_DIR, "codex"), { recursive: true, force: true });
});

const config: ResolvedLlmConfig = {
  backend: "codex",
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
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return sseResponse(events);
  }) as typeof fetch;

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
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  }) as typeof fetch;

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
  globalThis.fetch = (async () =>
    sseResponse([{ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }])) as unknown as typeof fetch;
  await assert.rejects(codexResponse(config, [{ role: "user", content: "hi" }], undefined), /server_error: boom/);
});
