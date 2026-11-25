/**
 * A delegation is work the caller is not supposed to wait for.
 *
 * The call returns the child's id at once, the child keeps working after the run that launched it
 * ends, and its answer comes back as a turn of the conversation -- `<subagent …>` for the model, a
 * return card for the owner (docs/subagents.md, "Background").
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { createSpawnTool } from "../../src/tools/spawn.ts";
import { SubAgentRunner, returnText, type SubAgentReturn } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { deleteSession } from "../../src/sessions/store.ts";
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
const PARENT = "my-claw-app/thread/owner/main";

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

const catalog = (): AgentInfo[] => [
  { name: "research", description: "reads and reports", base: "research", source: "built-in", path: "research.md" },
];

function answers(text: string): { restore: () => void } {
  return mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );
}

/** A sink that records what it was handed, so a return can be waited on rather than slept through. */
function collector(): { notices: SubAgentReturn[]; settled: Promise<void>; sink: { deliver: (n: SubAgentReturn) => Promise<void> } } {
  const notices: SubAgentReturn[] = [];
  let resolve!: () => void;
  const settled = new Promise<void>((r) => { resolve = r; });
  return {
    notices,
    settled,
    sink: {
      deliver: async (notice) => {
        notices.push(notice);
        resolve();
      },
    },
  };
}

test("a launch returns the id at once, and its answer arrives as a return", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const collected = collector();
  runner.setReturnSink(collected.sink);
  const spawn = createSpawnTool(runner, new SubAgentRegistry(), () => [], catalog);
  const mock = answers("the report");
  let id: string | undefined;
  try {
    const out = await spawn.execute({
      name: "eyes",
      type: "research",
      mode: "session",
      task: "look",
      __message: parentMessage(),
      __sessionId: PARENT,
    });
    assert.equal(out.success, true);
    assert.match(out.output, /^Started eyes/);
    assert.match(out.output, /Do not sleep, poll or duplicate its work/);
    id = /\[sub-agent id: (subagent\/[^\]]+)\]/.exec(out.output)?.[1];
    assert.ok(id, `no id in the launch output: ${out.output}`);
    // The conversation is marked busy for the child, and the child is the one it launched.
    assert.equal(runner.backgroundCountOf(PARENT), 1);

    await collected.settled;
    assert.equal(collected.notices.length, 1);
    const notice = collected.notices[0]!;
    assert.equal(notice.subagentId, id);
    assert.equal(notice.parentSessionId, PARENT);
    assert.equal(notice.status, "complete");
    assert.equal(notice.text, "the report");
    assert.equal(notice.displayName, "eyes");
    assert.equal(runner.backgroundCountOf(PARENT), 0);
  } finally {
    mock.restore();
    if (id) await deleteSession(id);
  }
});

test("wait=true is the escape hatch: the call answers with the child's own words", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const collected = collector();
  runner.setReturnSink(collected.sink);
  const spawn = createSpawnTool(runner, new SubAgentRegistry(), () => [], catalog);
  const mock = answers("done inline");
  let id: string | undefined;
  try {
    const out = await spawn.execute({
      name: "eyes",
      type: "research",
      mode: "session",
      task: "look",
      wait: true,
      __message: parentMessage(),
      __sessionId: PARENT,
    });
    assert.equal(out.success, true);
    assert.match(out.output, /^done inline/);
    id = /\[sub-agent id: (subagent\/[^\]]+)\]/.exec(out.output)?.[1];
    assert.ok(id);
    // Nothing was launched in the background, so nothing reports back later.
    assert.equal(collected.notices.length, 0);
    assert.equal(runner.backgroundCountOf(PARENT), 0);
  } finally {
    mock.restore();
    if (id) await deleteSession(id);
  }
});

test("a Stop takes the conversation's background children with it, and they stay quiet", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const notices: SubAgentReturn[] = [];
  runner.setReturnSink({ deliver: async (notice) => { notices.push(notice); } });
  const spawn = createSpawnTool(runner, new SubAgentRegistry(), () => [], catalog);
  // A model that never returns keeps the child in flight until the Stop.
  const mock = mockFetch(async (_input, init) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    await new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    throw new Error("unreachable");
  });
  let id: string | undefined;
  try {
    const out = await spawn.execute({
      name: "slow",
      type: "research",
      mode: "session",
      task: "never mind",
      __message: parentMessage(),
      __sessionId: PARENT,
    });
    id = /\[sub-agent id: (subagent\/[^\]]+)\]/.exec(out.output)?.[1];
    assert.ok(id);
    assert.equal(runner.backgroundCountOf(PARENT), 1);

    const stopped = await runner.stopBackgroundOf(PARENT);
    assert.deepEqual(stopped, [id]);
    assert.equal(runner.backgroundCountOf(PARENT), 0);
    // The Stop woke nothing: a return would have started the very run the owner ended.
    assert.equal(notices.length, 0);
  } finally {
    mock.restore();
    if (id) await deleteSession(id);
  }
});

test("a wait with a budget answers inline when the child lands in time", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const collected = collector();
  runner.setReturnSink(collected.sink);
  const registry = new SubAgentRegistry();
  const mock = answers("quick enough");
  let id: string | undefined;
  try {
    const launch = await runner.spawn({
      displayName: "quick",
      type: "research",
      mode: "run",
      task: "look",
      parentMessage: parentMessage(),
      existingIds: await registry.listExistingIds(),
      generateId: (n, e) => registry.generateId(n, e),
      parentSessionId: PARENT,
      visibility: "private",
      wait: true,
      waitMs: 5_000,
    });
    id = launch.id;
    // The answer is here, so nothing was launched for later and the conversation is not left busy.
    assert.equal(launch.background, false);
    assert.match(launch.result, /quick enough/);
    assert.equal(runner.backgroundCountOf(PARENT), 0);
    // Give a return the chance to arrive before saying there is none.
    await Promise.race([collected.settled, new Promise((resolve) => setTimeout(resolve, 150))]);
    assert.equal(collected.notices.length, 0);
  } finally {
    mock.restore();
    if (id) await deleteSession(id);
  }
});

test("a wait past its budget hands the child off, and its answer arrives once", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const collected = collector();
  runner.setReturnSink(collected.sink);
  const registry = new SubAgentRegistry();
  // Slower than the budget, so the call has to let go of it.
  const mock = mockFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return new Response(JSON.stringify({ choices: [{ message: { content: "slower than the budget" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });
  let id: string | undefined;
  try {
    const launch = await runner.spawn({
      displayName: "slow",
      type: "research",
      mode: "run",
      task: "take your time",
      parentMessage: parentMessage(),
      existingIds: await registry.listExistingIds(),
      generateId: (n, e) => registry.generateId(n, e),
      parentSessionId: PARENT,
      visibility: "private",
      wait: true,
      waitMs: 10,
    });
    id = launch.id;
    // The caller is let go with the launch line, and the child is counted as still working.
    assert.equal(launch.background, true);
    assert.match(launch.result, /^Started slow/);
    assert.equal(runner.backgroundCountOf(PARENT), 1);

    await collected.settled;
    assert.equal(collected.notices.length, 1);
    assert.equal(collected.notices[0]!.status, "complete");
    assert.match(collected.notices[0]!.text, /slower than the budget/);
    assert.equal(runner.backgroundCountOf(PARENT), 0);
    // Nothing else is delivered: the answer the caller did not wait for is the only report.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(collected.notices.length, 1);
  } finally {
    mock.restore();
    if (id) await deleteSession(id);
  }
});

test("the return tells the model it is a report, not the owner speaking", () => {
  const text = returnText({
    subagentId: "subagent/eyes-1a2b",
    parentSessionId: PARENT,
    displayName: "eyes",
    agentType: "research",
    action: "spawn",
    status: "complete",
    text: "three pages read",
    attachments: [],
  });
  assert.match(text, /^<subagent id="subagent\/eyes-1a2b" status="complete" description="eyes">/);
  assert.match(text, /three pages read/);
  assert.match(text, /report from a sub-agent you launched, not a message from the owner/);

  const failed = returnText({
    subagentId: "subagent/eyes-1a2b",
    parentSessionId: PARENT,
    displayName: "eyes",
    agentType: "research",
    action: "spawn",
    status: "error",
    text: "",
    error: "the provider refused",
    attachments: [],
  });
  assert.match(failed, /status="error"/);
  assert.match(failed, /the provider refused/);
});
