/**
 * The chat-completions transport against the two DeepSeek lanes this install runs on.
 *
 * Gated (`LLM_E2E=1`) and keyed from the environment (`SYNTHETIC_API_KEY`, `OPENCODE_GO_KEY`): it
 * spends real requests. What it proves is what no mock can: that the endpoints accept the wire the
 * transport now sends -- `reasoning_content` on every assistant turn, empty on the ones another
 * model wrote -- and that a real reply passes the stream contract with its reasoning on its own
 * channel, through a whole tool loop.
 */

import { describe, expect, test } from "bun:test";
import { chatCompletionStream, type ChatMessage, type LlmResponse } from "../../src/llm/provider.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const LANES = [
  { name: "synthetic", baseUrl: "https://api.synthetic.new/openai/v1", apiModel: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", key: process.env.SYNTHETIC_API_KEY, effort: "max" },
  { name: "opencode_go", baseUrl: "https://opencode.ai/zen/go/v1", apiModel: "deepseek-v4.1-flash", key: process.env.OPENCODE_GO_KEY, effort: "low" },
] as const;

const BASH = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command and return its output.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

for (const lane of LANES) {
  const config = {
    model: `${lane.name}/${lane.apiModel}`,
    apiModel: lane.apiModel,
    provider: lane.name,
    baseUrl: lane.baseUrl,
    apiKey: lane.key,
    backend: "openai",
    effort: lane.effort,
    reasoningField: "reasoning_content",
    reasoningReplay: true,
    limit: { output: 8192 },
    // OpenCode Go refuses a request that names no session (`x-opencode-session`), derived from this.
    cacheKey: `e2e-${crypto.randomUUID()}`,
  } as unknown as ResolvedLlmConfig;

  const call = async (messages: ChatMessage[]): Promise<{ reply: LlmResponse; painted: string; thought: string }> => {
    let painted = "";
    let thought = "";
    const reply = await chatCompletionStream(config, messages, (t) => { painted += t; }, [BASH], undefined, { onText(t) { thought += t; } });
    return { reply, painted, thought };
  };

  describe.skipIf(process.env.LLM_E2E !== "1" || !lane.key)(`${lane.name} DeepSeek, real endpoint`, () => {
    test("a tool loop over a history another model wrote passes the stream contract", async () => {
      const history: ChatMessage[] = [
        { role: "system", content: "You are a terse assistant. Use the bash tool when asked to run something." },
        { role: "user", content: "Say hi." },
        // Written by another model: it reaches the wire with an empty reasoning_content.
        { role: "assistant", content: "Hi." },
        { role: "user", content: "Run `echo e2e-ok` with the bash tool, then tell me what it printed, in one short sentence." },
      ];
      const first = await call(history);
      expect(first.reply.finishReason).toBeDefined();
      const calls = first.reply.toolCalls ?? [];
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]!.name).toBe("bash");

      const followUp: ChatMessage[] = [
        ...history,
        {
          role: "assistant",
          content: first.reply.content,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
          ...(first.reply.providerMeta ? { providerMeta: first.reply.providerMeta } : {}),
        },
        ...calls.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "e2e-ok\n" })),
      ];
      const second = await call(followUp);
      expect(second.reply.finishReason).toBe("stop");
      expect(second.reply.content).toContain("e2e-ok");
      // What the reader saw is what the reply says: nothing painted that the reply does not hold.
      expect(second.painted).toBe(second.reply.content);
      expect(second.thought).toBe(second.reply.reasoning ?? "");
    }, 180_000);
  });
}
