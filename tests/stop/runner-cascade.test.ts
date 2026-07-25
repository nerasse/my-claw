import { test } from "bun:test";
import assert from "node:assert/strict";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: { general: { maxIterations: 5 }, research: { maxIterations: 5 } },
  memory: { enabled: false },
};

function parentMessage(): UnifiedMessage {
  return { id: "msg-1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "task", attachments: [], isForwarded: false, raw: null };
}

test("runner: aborting the shared signal stops a running sub-agent (AbortedError + subagent:aborted)", async () => {
  const voiceManager = new VoiceManager(config);
  const sttPipeline = new SttPipeline(voiceManager);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);

  // The sub-agent's LLM call hangs until the shared signal aborts.
  const fetchMock = mockFetch((_url, init) => new Promise((_resolve, reject) => {
    const sig = (init as RequestInit | undefined)?.signal;
    sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }) as never);

  let abortedId: string | undefined;
  const onAbort = (p: { id: string }) => { abortedId = p.id; };
  hooks.on("subagent:aborted", onAbort);

  const c = new AbortController();
  try {
    const p = runner.spawn("researcher", "research", "run", "dig", undefined, parentMessage(), new Set(), (n) => `subagent/${n}`, c.signal);
    setTimeout(() => c.abort(), 30);
    await assert.rejects(() => p, AbortedError);
    assert.ok(abortedId, "subagent:aborted emitted");
  } finally {
    hooks.off("subagent:aborted", onAbort);
    fetchMock.restore();
  }
});
