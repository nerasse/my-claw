/**
 * Siphon: the root conversation's pin governs the whole tree -- docs/siphon.md.
 *
 * The rule the owner asked for is "whatever it is, it runs on this model", so the cases that matter
 * are the ones where something else would have won: an explicit spawn model, an agent file's own
 * pin, and a child of a child that never saw the root.
 */

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
import { metaOf, writeMeta } from "../../src/sessions/meta.ts";
import { pinModelOf, rootSessionOf } from "../../src/sessions/siphon.ts";

process.env["SYNTH_KEY"] = "test-key";
const ROOT = "my-claw-app/thread/u1/root-thread";

function config(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {}, agents: {},
    llm: {
      providers: {
        openai: { baseUrl: "https://alpha.local/v1", apiKeyEnv: "SYNTH_KEY" },
        other: { baseUrl: "https://beta.local/v1", apiKeyEnv: "SYNTH_KEY" },
      },
      models: [
        { id: "global-model", label: "Global", provider: "openai" },
        { id: "pinned-model", label: "Pinned", provider: "other" },
        { id: "asked-model", label: "Asked", provider: "openai" },
        { id: "file-model", label: "File", provider: "openai" },
      ],
      defaultProvider: "openai",
      defaultModel: "global-model",
    },
  };
}

function agentFile(name: string, model?: string): FileAgent {
  return {
    name,
    meta: { description: name, base: "general", instructions: [], ...(model ? { model } : {}) },
    prompt: "",
    path: `/agents/${name}.md`,
    source: "custom",
  };
}

function parentMessage(parentSessionId: string): UnifiedMessage {
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

function captureCalls(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push(body.model ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never;
  });
  return { calls, restore: () => mock.restore() };
}

async function spawn(
  cfg: MyClawConfig,
  type: string,
  opts: { parentSessionId: string; model?: string; registry?: AgentRegistry },
) {
  const runner = new SubAgentRunner(
    cfg, new ToolRegistry(), new SkillRegistry(),
    new VoiceManager(cfg), new SttPipeline(new VoiceManager(cfg)),
    opts.registry ?? new AgentRegistry(new Map()),
  );
  const ids = new SubAgentRegistry();
  return runner.spawn({
    displayName: type,
    type,
    mode: "run",
    task: "work",
    parentMessage: parentMessage(opts.parentSessionId),
    existingIds: await ids.listExistingIds(),
    generateId: (n, e) => ids.generateId(n, e),
    parentSessionId: opts.parentSessionId,
    visibility: "private",
    ...(opts.model ? { model: opts.model } : {}),
  });
}

/** The root conversation, written the way the app writes one: a meta on disk. */
async function pinRoot(pin: string | undefined): Promise<void> {
  const root = (await loadSession(ROOT)) ?? {
    id: ROOT, platform: "my-claw-app", chatType: "dm",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  };
  if (pin) root.pinModel = pin;
  else delete root.pinModel;
  await writeMeta(ROOT, metaOf(root, null));
}

test("an explicit spawn model loses to the root's pin", async () => {
  setAvailabilityWorld(() => PERMISSIVE_WORLD);
  await pinRoot("other/pinned-model");
  const capture = captureCalls();
  try {
    const { id } = await spawn(config(), "reviewer", { parentSessionId: ROOT, model: "asked-model" });
    assert.deepEqual(capture.calls, ["pinned-model"], "the pin is the whole promise: nothing else runs");
    await deleteSession(id);
  } finally {
    capture.restore();
    await pinRoot(undefined);
    resetAvailabilityWorld();
  }
});

test("an agent file's own model loses to the root's pin too", async () => {
  setAvailabilityWorld(() => PERMISSIVE_WORLD);
  await pinRoot("other/pinned-model");
  const capture = captureCalls();
  try {
    const registry = new AgentRegistry(new Map([["reviewer", agentFile("reviewer", "file-model")]]));
    const { id } = await spawn(config(), "reviewer", { parentSessionId: ROOT, registry });
    assert.deepEqual(capture.calls, ["pinned-model"]);
    await deleteSession(id);
  } finally {
    capture.restore();
    await pinRoot(undefined);
    resetAvailabilityWorld();
  }
});

test("a child of a child reaches the same root pin", async () => {
  setAvailabilityWorld(() => PERMISSIVE_WORLD);
  await pinRoot("other/pinned-model");
  const capture = captureCalls();
  try {
    const first = await spawn(config(), "reviewer", { parentSessionId: ROOT });
    capture.calls.length = 0;
    // The grandchild is spawned by the child: its own session carries no pin, only its ancestry.
    const second = await spawn(config(), "reviewer", { parentSessionId: first.id });
    assert.deepEqual(capture.calls, ["pinned-model"], "the pin is read from the root, not copied down");
    await deleteSession(second.id);
    await deleteSession(first.id);
  } finally {
    capture.restore();
    await pinRoot(undefined);
    resetAvailabilityWorld();
  }
});

test("with no pin the chain decides, exactly as before", async () => {
  setAvailabilityWorld(() => PERMISSIVE_WORLD);
  await pinRoot(undefined);
  const capture = captureCalls();
  try {
    const { id } = await spawn(config(), "reviewer", { parentSessionId: ROOT, model: "asked-model" });
    assert.deepEqual(capture.calls, ["asked-model"], "an unpinned tree keeps its old precedence");
    await deleteSession(id);
  } finally {
    capture.restore();
    resetAvailabilityWorld();
  }
});

test("a removal reaches the next run without touching the child", async () => {
  setAvailabilityWorld(() => PERMISSIVE_WORLD);
  await pinRoot("other/pinned-model");
  const capture = captureCalls();
  try {
    const first = await spawn(config(), "reviewer", { parentSessionId: ROOT });
    assert.deepEqual(capture.calls, ["pinned-model"]);
    await pinRoot(undefined);
    capture.calls.length = 0;
    const second = await spawn(config(), "reviewer", { parentSessionId: ROOT });
    assert.deepEqual(capture.calls, ["global-model"], "the pin lives on the root, so removing it is enough");
    await deleteSession(first.id);
    await deleteSession(second.id);
  } finally {
    capture.restore();
    await pinRoot(undefined);
    resetAvailabilityWorld();
  }
});

test("rootSessionOf stops at the top, and survives a cycle", async () => {
  const a = { id: "a", invokedBy: "b" } as never;
  const b = { id: "b", invokedBy: "a" } as never;
  const seen: string[] = [];
  const root = await rootSessionOf(a, async (id) => {
    seen.push(id);
    return id === "b" ? b : null;
  });
  // A corrupted chain must terminate, not spin: the first session already visited ends it.
  assert.ok(root === a || root === b, "one of the two, never a hang");
  assert.equal(pinModelOf({ id: "x", pinModel: "  " } as never), undefined);
});
