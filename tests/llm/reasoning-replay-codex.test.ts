import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { codexResponseStream } from "../../src/llm/codex.ts";
import type { ChatMessage, ProviderMeta } from "../../src/llm/provider.ts";
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
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

let mock: { restore(): void } | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
  rmSync(join(MY_CLAW_DIR, "accounts"), { recursive: true, force: true });
});

const config: ResolvedLlmConfig = {
  backend: "codex",
  provider: "chatgpt",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5-codex",
  effort: "high",
};

interface SentBody {
  include?: string[];
  store?: boolean;
  input: Array<Record<string, unknown>>;
}

async function send(messages: ChatMessage[], events: unknown[] = [{ type: "response.completed", response: {} }]): Promise<{ body: SentBody; meta?: ProviderMeta }> {
  writeAuth();
  let body: SentBody | undefined;
  mock = mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body ?? "{}")) as SentBody;
    return sseResponse(events) as never;
  });
  const response = await codexResponseStream(config, messages, () => {});
  return { body: body!, meta: response.providerMeta };
}

/** A turn that called one tool, as the model emitted it: think, then call. */
const TURN_EVENTS = [
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "ENC-1" } },
  { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" } },
  { type: "response.completed", response: {} },
];

describe("Codex reasoning replay", () => {
  test("the request asks for the encrypted state, which store:false otherwise discards", async () => {
    const { body } = await send([{ role: "user", content: "hi" }]);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("reasoning items are captured off the stream with their encrypted state", async () => {
    const { meta } = await send([{ role: "user", content: "hi" }], TURN_EVENTS);
    expect(meta).toEqual({ backend: "codex", model: "gpt-5-codex", reasoning: [{ id: "rs_1", encrypted: "ENC-1" }] });
  });

  test("an item announced without encrypted content is still tracked, minus the blob", async () => {
    const { meta } = await send([{ role: "user", content: "hi" }], [
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_bare" } },
      { type: "response.completed", response: {} },
    ]);
    expect(meta?.reasoning).toEqual([{ id: "rs_bare" }]);
  });

  test("a captured item is replayed ahead of the call it produced", async () => {
    const meta: ProviderMeta = { backend: "codex", model: "gpt-5-codex", reasoning: [{ id: "rs_1", encrypted: "ENC-1" }] };
    const { body } = await send([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }], providerMeta: meta },
      { role: "tool", tool_call_id: "call_1", content: "output" },
    ]);
    const types = body.input.map((i) => i["type"] ?? i["role"]);
    // Order is not cosmetic: the API rejects a reasoning item that does not precede its call.
    expect(types).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
    expect(body.input[1]).toEqual({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC-1" });
  });

  test("state from another model is dropped, not replayed: it would be a 400", async () => {
    const meta: ProviderMeta = { backend: "codex", model: "gpt-5.1-some-other", reasoning: [{ id: "rs_1", encrypted: "ENC-1" }] };
    const { body } = await send([
      { role: "user", content: "go" },
      { role: "assistant", content: "answer", providerMeta: meta },
    ]);
    expect(body.input.some((i) => i["type"] === "reasoning")).toBe(false);
  });

  test("state from another backend is dropped too", async () => {
    const meta: ProviderMeta = { backend: "anthropic", model: "gpt-5-codex", reasoning: [{ id: "rs_1", encrypted: "ENC-1" }] };
    const { body } = await send([
      { role: "user", content: "go" },
      { role: "assistant", content: "answer", providerMeta: meta },
    ]);
    expect(body.input.some((i) => i["type"] === "reasoning")).toBe(false);
  });

  test("a turn with no metadata sends exactly what it always sent", async () => {
    const { body } = await send([
      { role: "user", content: "go" },
      { role: "assistant", content: "answer" },
    ]);
    expect(body.input).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "answer" },
    ]);
  });

  test("encrypted state arriving only on the terminal response is backfilled", async () => {
    // Azure's deployments omit it from the item and supply it only in the completed response; an
    // item replayed without it is dropped as unusable.
    const { meta } = await send([{ role: "user", content: "hi" }], [
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      { type: "response.completed", response: { output: [{ type: "reasoning", id: "rs_1", encrypted_content: "LATE" }] } },
    ]);
    expect(meta?.reasoning).toEqual([{ id: "rs_1", encrypted: "LATE" }]);
  });

  test("the item's own encrypted state wins over the terminal copy", async () => {
    const { meta } = await send([{ role: "user", content: "hi" }], [
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "EARLY" } },
      { type: "response.completed", response: { output: [{ type: "reasoning", id: "rs_1", encrypted_content: "LATE" }] } },
    ]);
    expect(meta?.reasoning).toEqual([{ id: "rs_1", encrypted: "EARLY" }]);
  });

  test("several reasoning items keep their wire order", async () => {
    const { meta } = await send([{ role: "user", content: "hi" }], [
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_a", encrypted_content: "A" } },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" } },
      { type: "response.output_item.done", output_index: 2, item: { type: "reasoning", id: "rs_b", encrypted_content: "B" } },
      { type: "response.completed", response: {} },
    ]);
    expect(meta?.reasoning?.map((r) => r.id)).toEqual(["rs_a", "rs_b"]);
  });
});
