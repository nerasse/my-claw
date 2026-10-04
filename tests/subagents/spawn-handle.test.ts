/**
 * What `spawn` hands back, and what it leaves behind.
 *
 * A persistent sub-agent is reachable by id and by nothing else, and the runner used to keep that
 * id to itself: the tool returned the agent's first answer alone. The caller then had to guess
 * `subagent/<name>-<four hex>`, which is a "sub-agent not found" every time, or spend a round trip
 * on `agents list`.
 *
 * The other half of the same problem: a spawn whose first run dies hands back an error and no id,
 * so the session it created was a roster entry nobody could name, drive or kill.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { createSpawnTool } from "../../src/tools/spawn.ts";
import { createSendTool } from "../../src/tools/send.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { deleteSession, loadSession, subagentSessionIdsSync } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { AgentInfo } from "../../src/agents/types.ts";

const config: MyClawConfig = {
  whitelist: ["owner"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);

function parentMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "owner",
    chatId: "owner",
    chatType: "dm",
    text: "go",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function answers(text: string): { restore: () => void } {
  return mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );
}

// The tool checks the type against the live agent catalog, so the test has to offer one.
const catalog = (): AgentInfo[] => [
  { name: "research", description: "reads and reports", base: "research", source: "built-in", path: "research.md" },
];

const tools = (runner: SubAgentRunner, registry: SubAgentRegistry) => ({
  spawn: createSpawnTool(runner, registry, () => [], catalog),
  send: createSendTool(runner, registry),
});

const idOf = (output: string): string | undefined => /\[sub-agent id: (subagent\/[^\]]+)\]/.exec(output)?.[1];

test("a session spawn hands back the id, and that id is what send answers to", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const { spawn, send } = tools(runner, new SubAgentRegistry());
  const mock = answers("ready");
  let id: string | undefined;
  try {
    const spawned = await spawn.execute({
      name: "eyes",
      type: "research",
      mode: "session",
      task: "wait",
      __message: parentMessage(),
      __sessionId: "my-claw-app/thread/owner/main",
    });
    assert.equal(spawned.success, true);
    // The answer is still the answer: the handle is appended, it does not replace anything.
    assert.match(spawned.output, /^ready/);
    id = idOf(spawned.output);
    assert.ok(id, `no id in the spawn output: ${spawned.output}`);

    // The round trip is the whole point: no guessing, no `agents list`.
    const sent = await send.execute({
      id,
      message: "still there?",
      __message: parentMessage(),
      __sessionId: "my-claw-app/thread/owner/main",
    });
    assert.equal(sent.success, true);
    assert.equal(sent.output, "ready");
  } finally {
    mock.restore();
    if (id) await deleteSession(id);
  }
});

test("a one-shot answers without a handle: nothing is meant to drive it", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const { spawn } = tools(runner, new SubAgentRegistry());
  const mock = answers("done");
  try {
    const out = await spawn.execute({
      name: "quick",
      type: "research",
      mode: "run",
      task: "count to three",
      __message: parentMessage(),
      __sessionId: "my-claw-app/thread/owner/main",
    });
    assert.equal(out.success, true);
    assert.equal(out.output, "done");
  } finally {
    mock.restore();
    for (const id of subagentSessionIdsSync()) await deleteSession(id);
  }
});

test("a spawn whose first run dies keeps its work and tells the caller how to resume it", async () => {
  // It used to be deleted, the caller having no id to name it by, and the caller then redid its
  // task from nothing (the veille of 2026-09-29). Kept, named, resumable: docs/continue.md.
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const { spawn } = tools(runner, new SubAgentRegistry());
  const before = new Set(subagentSessionIdsSync());
  const mock = mockFetch(async () =>
    new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 400 }) as never,
  );
  try {
    const out = await spawn.execute({
      name: "doomed",
      type: "research",
      mode: "session",
      task: "wait",
      __message: parentMessage(),
      __sessionId: "my-claw-app/thread/owner/main",
    });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /400|credits/);
    const kept = subagentSessionIdsSync().filter((id) => !before.has(id));
    assert.equal(kept.length, 1, "the failed spawn's session is kept");
    assert.match(out.error ?? "", new RegExp(`send\\(id: "${kept[0]}"\\) with no message resumes it`));
    assert.notEqual(await loadSession(kept[0]!), null);
  } finally {
    mock.restore();
    for (const id of subagentSessionIdsSync()) if (!before.has(id)) await deleteSession(id);
  }
});
