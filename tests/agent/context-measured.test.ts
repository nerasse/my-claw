import { describe, expect, test } from "bun:test";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
    },
    agents: {}, memory: { enabled: false },
  };
}

function msg(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "neras", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(): SessionData {
  const now = new Date().toISOString();
  return { id: "my-claw-app/thread/neras/projet", platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

function fakeQuery(events: Array<Record<string, unknown>>): SdkQueryFn {
  return ({ prompt }) =>
    (async function* () {
      await prompt.next();
      for (const event of events) yield event;
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
}

function makeBackend(queryFn: SdkQueryFn): ClaudeSdkBackend {
  return new ClaudeSdkBackend(baseConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);
}

/** Collects every measurement announced during the run, then unsubscribes. */
async function withMeasurements(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const handler = ({ sessionId }: { sessionId: string }) => void seen.push(sessionId);
  hooks.on("session:context:measured", handler);
  try {
    await run();
  } finally {
    hooks.off("session:context:measured", handler);
  }
  return seen;
}

const START = (usage: Record<string, number>) => ({ type: "stream_event", event: { type: "message_start", message: { usage } } });
const RESULT = { type: "result", subtype: "success", result: "the answer" };

/**
 * `message_start` is the earliest the API states what it received, and it states it on every turn,
 * tool calls or not. Reading it there is what lets a screen follow the context of a run instead of
 * showing where the run started.
 */
describe("the prompt is measured when the turn opens", () => {
  test("message_start records the input the API counted, all three buckets", async () => {
    const s = session();
    const backend = makeBackend(fakeQuery([START({ input_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900 }), RESULT]));
    const announced = await withMeasurements(() => backend.handleMessageStreaming(msg(), s, async () => {}));
    expect(s.lastPrompt?.tokens).toBe(5020);
    expect(announced).toEqual(["my-claw-app/thread/neras/projet"]);
  });

  test("a turn that calls no tool still measures, which is most short runs", async () => {
    const s = session();
    const backend = makeBackend(fakeQuery([
      START({ input_tokens: 1000 }),
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } },
      RESULT,
    ]));
    const tokens: string[] = [];
    const announced = await withMeasurements(() =>
      backend.handleMessageStreaming(msg(), s, async (t) => void tokens.push(t)),
    );
    expect(tokens).toEqual(["hello"]);
    expect(s.lastPrompt?.tokens).toBe(1000);
    expect(announced.length).toBe(1);
  });

  test("every turn of a run is measured, not just the first", async () => {
    const s = session();
    const backend = makeBackend(fakeQuery([START({ input_tokens: 1000 }), START({ input_tokens: 7000 }), RESULT]));
    const announced = await withMeasurements(() => backend.handleMessageStreaming(msg(), s, async () => {}));
    expect(s.lastPrompt?.tokens).toBe(7000);
    expect(announced.length).toBe(2);
  });

  test("a start with no usage leaves the last measurement alone", async () => {
    const s = session();
    const backend = makeBackend(fakeQuery([START({ input_tokens: 3000 }), { type: "stream_event", event: { type: "message_start", message: {} } }, RESULT]));
    const announced = await withMeasurements(() => backend.handleMessageStreaming(msg(), s, async () => {}));
    expect(s.lastPrompt?.tokens).toBe(3000);
    expect(announced.length).toBe(1);
  });

  test("the reading matches the one the billing path writes for the same turn", async () => {
    const usage = { input_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900, output_tokens: 12 };
    const fromStart = session();
    await makeBackend(fakeQuery([START(usage), RESULT])).handleMessageStreaming(msg(), fromStart, async () => {});
    const fromAssistant = session();
    await makeBackend(fakeQuery([
      { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "hi" }], usage } },
      RESULT,
    ])).handleMessageStreaming(msg(), fromAssistant, async () => {});
    expect(fromStart.lastPrompt?.tokens).toBe(fromAssistant.lastPrompt?.tokens);
  });
});

/**
 * The other transport cannot say it any earlier: an OpenAI-compatible stream reports its usage in
 * the last chunk. The announcement is the same one, so a listener has a single thing to follow.
 */
describe("the home loop announces its own measurement", () => {
  const homeConfig = (): MyClawConfig => ({
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {}, memory: { enabled: false },
  });

  test("one announcement per call, and the measurement is readable when it lands", async () => {
    runRegistry.clear();
    const s = session();
    const bridge = new AgentBridge(homeConfig(), new ToolRegistry(), new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(s.id);
    const seenTokens: Array<number | undefined> = [];
    const handler = () => void seenTokens.push(s.lastPrompt?.tokens);
    hooks.on("session:context:measured", handler);
    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );
    try {
      await bridge.handleMessage(msg(), s, signal);
    } finally {
      hooks.off("session:context:measured", handler);
      mock.restore();
      end();
      runRegistry.clear();
    }
    expect(seenTokens).toEqual([4242]);
  });
});
