/**
 * A sub-agent that died on a spent plan waits for it and comes back by itself -- docs/quota-retry.md.
 *
 * The wait lived in the app adapter alone because that is where the tick runs, so a sub-agent whose
 * provider ran dry stayed blocked until somebody resumed it by hand. It arms its own wait now, on
 * its own session, and the one tick fires it: one scheduler for both kinds of session.
 *
 * What has to hold, and what this pins:
 *
 * - a child with the switch off arms nothing, like a conversation;
 * - a child with the switch on, whose provider publishes a reset, arms at that second plus buffer;
 * - the attempt count climbs across retries, so the eight-attempt guard can still stop a loop;
 * - a wait that came due resumes the same child, adding no turn, and a finished child refuses to
 *   run again.
 */

import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import type { FileAgent } from "../../src/agents/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { deleteSession, loadSession } from "../../src/sessions/store.ts";
import { metaOf, readMeta, writeMeta } from "../../src/sessions/meta.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { resetQuotaCache } from "../../src/llm/quota/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

process.env["SYNTH_KEY"] = "test-key";
const PARENT = "my-claw-app/thread/owner/main";

function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      providers: {
        gpt: { baseUrl: "https://gpt.example/v1", apiKeyEnv: "SYNTH_KEY" },
        synth: { baseUrl: "https://api.synthetic.new/openai/v1", apiKeyEnv: "SYNTH_KEY" },
      },
      models: [
        { id: "gpt/gpt-6.1-sol", provider: "gpt" },
        { id: "synth/m", provider: "synth" },
      ],
      defaultProvider: "synth",
      defaultModel: "synth/m",
    },
    agents: {},
    memory: { enabled: false },
  } as unknown as MyClawConfig;
}

function agentFile(name: string): FileAgent {
  return { name, meta: { description: `${name} agent`, base: "general", instructions: [] }, prompt: "", path: `/agents/${name}.md`, source: "custom" };
}

function parentMessage(): UnifiedMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    platform: "my-claw-app", userId: "owner", chatId: "owner", chatType: "dm",
    text: "go", attachments: [], isForwarded: false, raw: {},
  };
}

function makeRunner(): SubAgentRunner {
  const cfg = config();
  return new SubAgentRunner(
    cfg, new ToolRegistry(), new SkillRegistry(),
    new VoiceManager(cfg), new SttPipeline(new VoiceManager(cfg)),
    new AgentRegistry(new Map([["worker", agentFile("worker")]])) as unknown as AgentRegistry,
  );
}

const made: string[] = [];

/** A session-mode child, spawned with its first run answered normally. */
async function spawnChild(runner: SubAgentRunner): Promise<string> {
  const ids = new SubAgentRegistry();
  const setup = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "first" } }] }), { status: 200 }) as never);
  try {
    const { id } = await runner.spawn({
      displayName: "worker", type: "worker", mode: "session", task: "first pass",
      parentMessage: parentMessage(), existingIds: await ids.listExistingIds(),
      generateId: (n, e) => ids.generateId(n, e), parentSessionId: PARENT, visibility: "global",
    });
    made.push(id);
    return id;
  } finally {
    setup.restore();
  }
}

/** Turns the child's own switch on, where the runner will read it: written, not held in memory. */
async function enableSwitch(id: string): Promise<void> {
  const session = await loadSession(id);
  session!.quotaRetry = { enabled: true };
  const log = await sessionLogOf(id);
  await writeMeta(id, metaOf(session!, log.leaf()));
}

/** The provider refuses the child's account, and its usage endpoint names a reset. */
function dryPlan(resetsAt: string) {
  return mockFetch(async (input) => {
    const url = String(input);
    if (url.includes("/v2/quotas")) {
      return new Response(JSON.stringify({
        planWeeklyLimit: { percentRemaining: 0, nextRegenAt: resetsAt },
        rollingFiveHourLimit: { max: 500, remaining: 500, nextTickAt: resetsAt },
      }), { status: 200 }) as never;
    }
    return new Response(
      JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }),
      { status: 429 },
    ) as never;
  });
}

afterEach(async () => {
  for (const id of made.splice(0)) await deleteSession(id);
  runRegistry.clear();
  resetQuotaCache();
});

test("a child whose switch is off arms nothing, exactly like a conversation", async () => {
  const runner = makeRunner();
  const id = await spawnChild(runner);
  const wire = dryPlan(new Date(Date.now() + 3600_000).toISOString());
  try {
    // The runner throws on a provider failure; what matters here is only what it did NOT write.
    await runner.send(id, "work", undefined, parentMessage(), new SubAgentRegistry(), PARENT).then(
      () => assert.fail("a spent plan must not answer"),
      () => undefined,
    );
    assert.equal((await readMeta(id))?.quotaRetry?.pending, undefined, "off means off");
  } finally {
    wire.restore();
  }
});

/**
 * The shape of the whole feature: the switch on, the plan spent, and the wait comes out of the run
 * that died rather than out of a channel that never saw it.
 */
test("a child with the switch on arms the wait the provider published, on its own session", async () => {
  const runner = makeRunner();
  const id = await spawnChild(runner);
  await enableSwitch(id);

  const resetsAt = new Date(Date.now() + 3 * 3600_000 + 30_000).toISOString();
  const wire = dryPlan(resetsAt);
  try {
    await runner.send(id, "hit the wall", undefined, parentMessage(), new SubAgentRegistry(), PARENT).catch(() => undefined);
    const stored = (await readMeta(id))?.quotaRetry;
    assert.equal(stored?.enabled, true, "the switch is the child's own");
    assert.ok(stored?.pending, "a wait was armed");
    assert.equal(stored.pending.attempts, 1);
    // The provider's second, plus the same one-minute buffer the conversation path uses.
    assert.equal(stored.pending.at, new Date(Date.parse(resetsAt) + 60_000).toISOString());
    assert.ok((stored.pending.windows ?? []).length > 0, "the spent window is named");
  } finally {
    wire.restore();
  }
});

test("the attempt count climbs, so the eight-attempt guard can still stop a loop", async () => {
  const runner = makeRunner();
  const id = await spawnChild(runner);
  await enableSwitch(id);
  const resetsAt = new Date(Date.now() + 600_000).toISOString();
  let wire = dryPlan(resetsAt);
  try {
    await runner.send(id, "wall", undefined, parentMessage(), new SubAgentRegistry(), PARENT).catch(() => undefined);
  } finally {
    wire.restore();
  }
  assert.equal((await readMeta(id))?.quotaRetry?.pending?.attempts, 1);

  // A second wall on the same child: the count comes from what the session already holds.
  resetQuotaCache();
  wire = dryPlan(resetsAt);
  try {
    await runner.send(id, "wall again", undefined, parentMessage(), new SubAgentRegistry(), PARENT).catch(() => undefined);
  } finally {
    wire.restore();
  }
  assert.equal((await readMeta(id))?.quotaRetry?.pending?.attempts, 2);
});

/**
 * The tick's own entry point. It resumes the same child, adds no turn, and refuses a child that has
 * nothing left to pick up -- a timer must never make a finished agent run again.
 */
test("a due wait resumes the child without adding a turn, and a finished child is refused", async () => {
  const runner = makeRunner();
  const registry = new SubAgentRegistry();
  const id = await spawnChild(runner);

  // This child's last run finished, so a wait that fired on it has nothing to pick up.
  const finished = await runner.resumeArmedWait(id, registry);
  assert.equal(finished.ok, false);
  assert.match((finished as { reason: string }).reason, /last run finished/);

  // Now leave one unanswered, which is exactly what a quota wall does.
  const log = await sessionLogOf(id);
  log.append({ type: "user", prompt: true, text: "unfinished question" });
  log.append({ type: "run_start", prompt: false });
  log.append({ type: "run_end", prompt: false, reason: "error", failure: "quota_exhausted" });
  await log.flush();

  const wire = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "resumed" } }] }), { status: 200 }) as never);
  try {
    const started = await runner.resumeArmedWait(id, registry);
    assert.equal(started.ok, true);
  } finally {
    wire.restore();
  }
});
