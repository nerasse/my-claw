import { describe, expect, test } from "bun:test";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
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
  return { id: "m1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(): SessionData {
  const now = new Date().toISOString();
  return { id: "telegram/dm/u1", platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

/** Replays a scripted SDK stream, consuming the prompt generator like the real query does. */
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

const RESULT = { type: "result", subtype: "success", result: "the answer" };

/**
 * The Claude Code bridge redacts the thinking text and reports only a running estimate
 * (SDKThinkingTokensMessage). A count is all this engine can ever offer -- see
 * docs/reasoning-visibility.md.
 */
describe("the redacted engine reports a count, never text", () => {
  test("thinking_tokens reaches onTokens", async () => {
    const backend = makeBackend(
      fakeQuery([
        { type: "system", subtype: "thinking_tokens", estimated_tokens: 128, estimated_tokens_delta: 128 },
        { type: "system", subtype: "thinking_tokens", estimated_tokens: 640, estimated_tokens_delta: 512 },
        RESULT,
      ]),
    );
    const counts: number[] = [];
    const text: string[] = [];
    const reply = await backend.handleMessageStreaming(
      msg(),
      session(),
      async (token) => void text.push(token),
      undefined,
      undefined,
      undefined,
      undefined,
      { onTokens: async (n) => void counts.push(n), onText: async (t) => void text.push(t) },
    );
    expect(reply).toBe("the answer");
    // The estimate is a running total, so the app can render the latest value verbatim.
    expect(counts).toEqual([128, 640]);
    expect(text).toEqual([]);
  });

  test("a thinking_tokens frame without a number is ignored, not reported as zero", async () => {
    const backend = makeBackend(fakeQuery([{ type: "system", subtype: "thinking_tokens" }, RESULT]));
    const counts: number[] = [];
    await backend.handleMessageStreaming(
      msg(), session(), async () => {}, undefined, undefined, undefined, undefined,
      { onTokens: async (n) => void counts.push(n) },
    );
    expect(counts).toEqual([]);
  });

  test("a run with no sink is unaffected, which is how the chat channels stay clean", async () => {
    const backend = makeBackend(
      fakeQuery([{ type: "system", subtype: "thinking_tokens", estimated_tokens: 42, estimated_tokens_delta: 42 }, RESULT]),
    );
    const reply = await backend.handleMessageStreaming(msg(), session(), async () => {});
    expect(reply).toBe("the answer");
  });

  test("text deltas still reach onToken and never the reasoning sink", async () => {
    const backend = makeBackend(
      fakeQuery([
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } },
        RESULT,
      ]),
    );
    const tokens: string[] = [];
    const reasoning: string[] = [];
    await backend.handleMessageStreaming(
      msg(), session(), async (t) => void tokens.push(t), undefined, undefined, undefined, undefined,
      { onText: async (d) => void reasoning.push(d) },
    );
    expect(tokens).toEqual(["hello"]);
    expect(reasoning).toEqual([]);
  });
});
