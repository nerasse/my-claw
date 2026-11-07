import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import type { FileAgent } from "../../src/agents/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { loadSession, deleteSession } from "../../src/sessions/store.ts";
import { openSessionLog } from "../../src/sessions/log.ts";

function agentFile(name: string): FileAgent {
  return {
    name,
    meta: { description: `${name} agent`, base: "general", instructions: [] },
    prompt: "",
    path: `/agents/${name}.md`,
    source: "custom",
  };
}

function parentMessage(): UnifiedMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "go",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function makeConfig(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "openai", baseUrl: "https://example.com", apiKey: "k", defaultModel: "global-model" },
  };
}

function makeRunner(manager?: SessionManager): SubAgentRunner {
  const runner = new SubAgentRunner(
    makeConfig(),
    new ToolRegistry(),
    new SkillRegistry(),
    new VoiceManager(makeConfig()),
    new SttPipeline(new VoiceManager(makeConfig())),
    new AgentRegistry(new Map()),
  );
  if (manager) runner.setSessionManager(manager);
  return runner;
}

test("no duplicate user bubble after a sub-agent run (pre-push + bridge push merge)", async () => {
  const mock = mockFetch(async () => {
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never;
  });
  try {
    const runner = makeRunner();
    const registry = new SubAgentRegistry();
    const { id } = await runner.spawn({
      displayName: "sleeper",
      type: "general",
      mode: "run",
      task: "write the report",
      parentMessage: parentMessage(),
      existingIds: await registry.listExistingIds(),
      generateId: (n, e) => registry.generateId(n, e),
      parentSessionId: "telegram/dm/c1",
      visibility: "private",
    });
    // User entries are now in the log, not session.messages
    const log = await openSessionLog(id);
    const userEntries = (await log.all()).filter((e) => e.type === "user");
    assert.equal(userEntries.length, 1, "exactly one user bubble, got " + userEntries.length);
    await deleteSession(id);
  } finally {
    mock.restore();
  }
});

test("live sub-agent session is adopted into the SessionManager cache during the run", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockFetch(async () => {
    await gate;
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never;
  });
  try {
    const manager = new SessionManager();
    const runner = makeRunner(manager);
    const registry = new SubAgentRegistry();
    let subId = "";
    const running = runner.spawn({
      displayName: "sleeper",
      type: "general",
      mode: "session",
      task: "sleep 60",
      parentMessage: parentMessage(),
      existingIds: await registry.listExistingIds(),
      generateId: (n, e) => {
        const id = registry.generateId(n, e);
        subId = id;
        return id;
      },
      parentSessionId: "telegram/dm/c1",
      visibility: "private",
    });
    // Let the run reach the LLM call (adopt happens before), then peek the cache.
    await Bun.sleep(200);
    const inFlight = await manager.read(subId);
    assert.ok(inFlight, "session should be visible while the run is in flight");
    // User entries are now in the log, not session.messages
    const log = await openSessionLog(subId);
    assert.ok((await log.all()).some((e) => e.type === "user"), "the pre-pushed task should be there");
    release?.();
    await running;
    if (subId) await deleteSession(subId);
  } finally {
    release?.();
    mock.restore();
  }
});
