import { describe, expect, test } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function msg(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "neras", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(): SessionData {
  const now = new Date().toISOString();
  return { id: "my-claw-app/thread/neras/projet", platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

/**
 * An OpenAI-compatible stream reports its usage in the last chunk, so that is the earliest the
 * prompt can be stated. One announcement per call, and the measurement is readable by the time a
 * listener is told about it: a screen following the context has a single thing to watch.
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
