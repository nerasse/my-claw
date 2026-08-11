import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { codexResponseStream } from "../../src/llm/codex.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

function writeAuth(): void {
  mkdirSync(join(MY_CLAW_DIR, "codex"), { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "codex", "auth.json"),
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
  rmSync(join(MY_CLAW_DIR, "codex"), { recursive: true, force: true });
});

const config: ResolvedLlmConfig = {
  backend: "codex",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5-codex",
  effort: "high",
};

async function run(events: unknown[]): Promise<{ reasoning: string[]; text: string; returned?: string }> {
  writeAuth();
  mock = mockFetch(async () => sseResponse(events) as never);
  const reasoning: string[] = [];
  let text = "";
  const response = await codexResponseStream(
    config,
    [{ role: "user", content: "hi" }],
    (token) => {
      text += token;
    },
    undefined,
    undefined,
    { onText: async (delta) => void reasoning.push(delta) },
  );
  return { reasoning, text, returned: response.reasoning };
}

/**
 * The request has always asked for `reasoning: { summary: "auto" }`, so these events were arriving
 * and being dropped on the floor -- docs/reasoning-visibility.md.
 */
describe("Codex Responses reasoning", () => {
  test("summary deltas reach the sink", async () => {
    const { reasoning, text } = await run([
      { type: "response.reasoning_summary_text.delta", delta: "Weighing " },
      { type: "response.reasoning_summary_text.delta", delta: "the options" },
      { type: "response.output_text.delta", output_index: 0, delta: "Answer" },
      { type: "response.completed", response: {} },
    ]);
    expect(reasoning.join("")).toBe("Weighing the options");
    expect(text).toBe("Answer");
  });

  test("raw reasoning_text deltas reach the sink too", async () => {
    const { reasoning } = await run([
      { type: "response.reasoning_text.delta", delta: "raw thought" },
      { type: "response.output_text.delta", output_index: 0, delta: "x" },
      { type: "response.completed", response: {} },
    ]);
    expect(reasoning.join("")).toBe("raw thought");
  });

  test("the accumulated reasoning comes back for persistence", async () => {
    const { returned } = await run([
      { type: "response.reasoning_summary_text.delta", delta: "abc" },
      { type: "response.output_text.delta", output_index: 0, delta: "x" },
      { type: "response.completed", response: {} },
    ]);
    expect(returned).toBe("abc");
  });

  test("an unrelated reasoning event is ignored rather than throwing", async () => {
    const { reasoning, text } = await run([
      { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
      { type: "response.output_text.delta", output_index: 0, delta: "fine" },
      { type: "response.completed", response: {} },
    ]);
    expect(reasoning).toEqual([]);
    expect(text).toBe("fine");
  });

  test("a run that reasons but has no sink still returns the text", async () => {
    writeAuth();
    mock = mockFetch(async () =>
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "unheard" },
        { type: "response.output_text.delta", output_index: 0, delta: "ok" },
        { type: "response.completed", response: {} },
      ]) as never,
    );
    let text = "";
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], (t) => {
      text += t;
    });
    expect(text).toBe("ok");
    expect(response.reasoning).toBe("unheard");
  });
});
