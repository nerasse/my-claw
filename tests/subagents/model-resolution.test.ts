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
import { PERMISSIVE_WORLD, resetAvailabilityWorld, setAvailabilityWorld } from "../../src/llm/world.ts";
import { loadSession, deleteSession } from "../../src/sessions/store.ts";

function agentFile(name: string, model?: string): FileAgent {
  return {
    name,
    meta: {
      description: `${name} agent`,
      base: "general",
      instructions: [],
      ...(model ? { model } : {}),
    },
    prompt: "",
    path: `/agents/${name}.md`,
    source: "custom",
  };
}

function registryWith(agent: FileAgent): AgentRegistry {
  return new AgentRegistry(new Map([[agent.name, agent]]));
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

/** Captures the model and endpoint of every completion the run asked for. */
function captureCalls(): { calls: Array<{ url: string; model: string }>; restore(): void } {
  const calls: Array<{ url: string; model: string }> = [];
  const mock = mockFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push({ url: String(input), model: body.model ?? "" });
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never;
  });
  return { calls, restore: () => mock.restore() };
}

async function spawn(config: MyClawConfig, registry: AgentRegistry, type: string, model?: string) {
  const runner = new SubAgentRunner(
    config,
    new ToolRegistry(),
    new SkillRegistry(),
    new VoiceManager(config),
    new SttPipeline(new VoiceManager(config)),
    registry,
  );
  const ids = new SubAgentRegistry();
  return runner.spawn({
    displayName: type,
    type,
    mode: "run",
    task: "work",
    parentMessage: parentMessage(),
    existingIds: await ids.listExistingIds(),
    generateId: (n, e) => ids.generateId(n, e),
    parentSessionId: "telegram/dm/c1",
    visibility: "private",
    ...(model ? { model } : {}),
  });
}

test("an agent file's model: applies to a spawn", async () => {
  const config: MyClawConfig = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "openai", baseUrl: "https://example.com", apiKey: "k", defaultModel: "global-model" },
  };
  const capture = captureCalls();
  try {
    const { id } = await spawn(config, registryWith(agentFile("reviewer", "file-model")), "reviewer");
    // Read straight off the wire: the config entry alone said "global-model", and that is what
    // this spawn used to send.
    assert.deepEqual(capture.calls.map((c) => c.model), ["file-model"]);
    const session = await loadSession(id);
    assert.equal(session?.modelOverride, "file-model");
    await deleteSession(id);
  } finally {
    capture.restore();
  }
});

test("an explicit spawn model outranks the agent file's", async () => {
  const config: MyClawConfig = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "openai", baseUrl: "https://example.com", apiKey: "k", defaultModel: "global-model" },
  };
  const capture = captureCalls();
  try {
    const { id } = await spawn(config, registryWith(agentFile("reviewer", "file-model")), "reviewer", "asked-model");
    assert.deepEqual(capture.calls.map((c) => c.model), ["asked-model"]);
    await deleteSession(id);
  } finally {
    capture.restore();
  }
});

test("a pinned model the provider no longer serves falls back to the global default", async () => {
  const config: MyClawConfig = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    // Pinned on the config entry, the one place the old path did read: what it lacked was any step
    // below the pin.
    agents: { reviewer: { llm: { defaultModel: "pinned-model" } } },
    llm: {
      defaultProvider: "good",
      defaultModel: "global-model",
      providers: {
        good: { baseUrl: "https://good.example.com", apiKeyEnv: "GOOD_KEY" },
        blocked: { baseUrl: "https://blocked.example.com", apiKeyEnv: "BLOCKED_KEY" },
      },
      models: [
        { id: "pinned-model", label: "Pinned", provider: "blocked" },
        { id: "global-model", label: "Global", provider: "good" },
      ],
    },
  };
  // The gateway answered and does not list the pinned model: exactly what a blocked model looks
  // like from here. The old path had no step below the pin and sent the request anyway.
  setAvailabilityWorld(() => ({
    ...PERMISSIVE_WORLD,
    answered: (provider: string) => provider === "blocked",
    listedBy: () => new Set<string>(),
  }));
  const capture = captureCalls();
  try {
    const { id } = await spawn(config, registryWith(agentFile("reviewer")), "reviewer");
    assert.deepEqual(capture.calls.map((c) => c.model), ["global-model"]);
    assert.ok(capture.calls[0]?.url.startsWith("https://good.example.com"), capture.calls[0]?.url);
    await deleteSession(id);
  } finally {
    capture.restore();
    resetAvailabilityWorld();
  }
});
