import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { codexResponseStream } from "../../src/llm/codex.ts";
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

  /**
   * The seam. Both strings below are verbatim from this install's stored reasoning, where forty
   * of these welds accumulated: GPT ends a summary part on `**` and opens the next on `**`, and
   * appended raw they meet as `****` mid-line -- not two headings, not a rule, just broken.
   */
  test("two summary parts are separated instead of welded into ****", async () => {
    const { reasoning, returned } = await run([
      { type: "response.reasoning_summary_text.delta", delta: "**Locating user workspace directory**" },
      { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
      { type: "response.reasoning_summary_text.delta", delta: "**Inspecting git status and recent changes**" },
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.completed", response: {} },
    ]);
    const expected = "**Locating user workspace directory**\n\n**Inspecting git status and recent changes**";
    expect(returned).toBe(expected);
    expect(returned).not.toContain("****");
    // The live stream carries the break too, or the replay reads differently from what was watched.
    expect(reasoning.join("")).toBe(expected);
  });

  test("the part index separates them even when no part event is sent", async () => {
    const { returned } = await run([
      { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "**First**" },
      { type: "response.reasoning_summary_text.delta", summary_index: 1, delta: "**Second**" },
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.completed", response: {} },
    ]);
    expect(returned).toBe("**First**\n\n**Second**");
  });

  test("deltas inside one part are still concatenated untouched", async () => {
    const { returned } = await run([
      { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "**Weigh" },
      { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "ing it**" },
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.completed", response: {} },
    ]);
    expect(returned).toBe("**Weighing it**");
  });

  test("a part boundary before any text opens no blank line", async () => {
    const { returned } = await run([
      { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
      { type: "response.reasoning_summary_text.delta", delta: "**Only part**" },
      { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.completed", response: {} },
    ]);
    expect(returned).toBe("**Only part**");
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

  // GPT-5 answers, thinks again and keeps writing inside one response, so this transport is the
  // one that needs the cuts most -- docs/reasoning-visibility.md.
  test("a response that thinks again mid-answer reports where it split", async () => {
    writeAuth();
    mock = mockFetch(async () =>
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "checking" },
        { type: "response.output_text.delta", output_index: 0, delta: "one moment" },
        { type: "response.reasoning_summary_text.delta", delta: "now sure" },
        { type: "response.output_text.delta", output_index: 0, delta: "the answer" },
        { type: "response.completed", response: {} },
      ]) as never,
    );
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], () => {});
    // Duration dropped, same reason as in reasoning.test.ts: it comes off the real clock.
    expect(response.segments?.map(({ reasoning, content }) => ({ reasoning, content }))).toEqual([
      { reasoning: "checking", content: "one moment" },
      { reasoning: "now sure", content: "the answer" },
    ]);
    expect(response.content).toBe("one momentthe answer");
  });

  test("one thinking phase reports no split at all", async () => {
    writeAuth();
    mock = mockFetch(async () =>
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "thinking" },
        { type: "response.output_text.delta", output_index: 0, delta: "answer" },
        { type: "response.completed", response: {} },
      ]) as never,
    );
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], () => {});
    expect(response.segments).toBeUndefined();
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

/** Events written one by one, with real time between the ones that need a span to measure. */
function pacedResponse(steps: Array<unknown | { pauseMs: number }>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const step of steps) {
          if (step && typeof step === "object" && "pauseMs" in step) await Bun.sleep((step as { pauseMs: number }).pauseMs);
          else controller.enqueue(encoder.encode(`data: ${JSON.stringify(step)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/**
 * Measured on gpt-6.1-sol (2026-10-26): with `summary: "auto"` the backend writes a summary for a
 * fraction of its thoughts, and the rest come back as a reasoning item with `summary: []` and no
 * delta at all -- 82 % of the phases that day. The count and the item's lifetime are then all
 * there is to show (docs/reasoning-visibility.md, "A thought with no words").
 */
describe("a Codex thought with no words", () => {
  const silentThenTool = (pauseMs: number): Array<unknown | { pauseMs: number }> => [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { pauseMs },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "read", arguments: "" } },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c1", name: "read", arguments: "{\"path\":\"/x\"}" } },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 100, output_tokens: 600, output_tokens_details: { reasoning_tokens: 516 } } },
    },
  ];

  test("reports what it spent, from the usage of the completed response", async () => {
    writeAuth();
    mock = mockFetch(async () => pacedResponse(silentThenTool(0)) as never);
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], () => {});
    expect(response.usage?.reasoningTokens).toBe(516);
    expect(response.usage?.completionTokens).toBe(600);
    expect(response.reasoning).toBeUndefined();
    expect(response.toolCalls?.map((call) => call.name)).toEqual(["read"]);
  });

  test("is timed by its reasoning item, since no delta ever opened a span", async () => {
    writeAuth();
    mock = mockFetch(async () => pacedResponse(silentThenTool(25)) as never);
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], () => {});
    // A lower bound only: a loaded machine stretches the pause, it never shortens it.
    expect(response.reasoningMs).toBeGreaterThanOrEqual(20);
  });

  test("a thought with words keeps the span the live view measured, from its first delta", async () => {
    writeAuth();
    mock = mockFetch(async () =>
      pacedResponse([
        { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
        { pauseMs: 300 },
        { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "**Reading**" },
        { pauseMs: 25 },
        { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**Reading**" }] } },
        { type: "response.output_text.delta", output_index: 1, delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 9, output_tokens_details: { reasoning_tokens: 7 } } } },
      ]) as never,
    );
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], () => {});
    expect(response.reasoning).toBe("**Reading**");
    expect(response.usage?.reasoningTokens).toBe(7);
    // Opened by the delta, closed by the first word of the answer: the 300 ms before the delta are
    // not in it, which is what tells it from the item's own lifetime.
    expect(response.reasoningMs).toBeGreaterThanOrEqual(20);
    expect(response.reasoningMs).toBeLessThan(300);
  });

  test("a response that did not think reports neither a count nor a span", async () => {
    writeAuth();
    mock = mockFetch(async () =>
      pacedResponse([
        { type: "response.output_text.delta", output_index: 0, delta: "4" },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } } } },
      ]) as never,
    );
    const response = await codexResponseStream(config, [{ role: "user", content: "hi" }], () => {});
    expect(response.usage?.reasoningTokens).toBeUndefined();
    expect(response.reasoningMs).toBeUndefined();
  });
});
