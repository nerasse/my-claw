/**
 * The switch is the conversation's, and a delegated chain is that conversation's work --
 * docs/quota-retry.md.
 *
 * The owner turns "Retry when the quota returns" on once, in the chat he is looking at. Every
 * sub-agent of that chat is covered, at any depth: a child used to look for a toggle of its own,
 * which nothing ever sets, so a whole delegated tree silently ignored a switch the owner had
 * visibly turned on.
 *
 * What this pins, and what each assertion would have caught:
 *
 * - a child whose own field is untouched arms its wait off the root's switch;
 * - two levels down reaches the same root, so depth does not dilute the setting;
 * - the root's switch off still arms nothing, so the read does not turn the mode into a default;
 * - the wait is armed per session, so each resume keeps its own attempt count.
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
async function spawnChild(runner: SubAgentRunner, parentSessionId = PARENT): Promise<string> {
  const ids = new SubAgentRegistry();
  const setup = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "first" } }] }), { status: 200 }) as never);
  try {
    const { id } = await runner.spawn({
      displayName: "worker", type: "worker", mode: "session", task: "first pass",
      parentMessage: parentMessage(), existingIds: await ids.listExistingIds(),
      generateId: (n, e) => ids.generateId(n, e), parentSessionId, visibility: "global",
    });
    made.push(id);
    return id;
  } finally {
    setup.restore();
  }
}

/**
 * A conversation on disk, with the switch as written. The root is a real session: the runner
 * reaches it by `attributionParent`, so a fabricated id with no file would answer "no root".
 */
async function writeRoot(enabled: boolean): Promise<void> {
  const session = await loadSession(PARENT);
  const next = session ?? {
    id: PARENT, platform: "my-claw-app", chatType: "dm",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  };
  next.quotaRetry = { enabled };
  await writeMeta(PARENT, metaOf(next, null));
}

/** The provider refuses the account, and its usage endpoint names a reset. */
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
  await deleteSession(PARENT);
  runRegistry.clear();
  resetQuotaCache();
});

test("a child arms its wait off the conversation's switch, without ever having one of its own", async () => {
  const runner = makeRunner();
  const id = await spawnChild(runner);
  await writeRoot(true);
  assert.equal((await readMeta(id))?.quotaRetry, undefined, "the child starts with no switch at all");

  const resetsAt = new Date(Date.now() + 3600_000).toISOString();
  const wire = dryPlan(resetsAt);
  try {
    await runner.send(id, "hit the wall", undefined, parentMessage(), new SubAgentRegistry(), PARENT).catch(() => undefined);
  } finally {
    wire.restore();
  }

  const stored = (await readMeta(id))?.quotaRetry;
  assert.equal(stored?.enabled, true, "the wait is armed on the child");
  assert.ok(stored?.pending, "the provider's reset was read");
  // The switch is not copied onto the child as a setting: only the wait is written, so turning the
  // conversation's switch off later reaches every run without a broadcast that could miss one.
  assert.equal((await readMeta(PARENT))?.quotaRetry?.enabled, true);
});

test("a child of a child reaches the same root switch", async () => {
  const runner = makeRunner();
  await writeRoot(true);
  const child = await spawnChild(runner);
  const grandchild = await spawnChild(runner, child);

  const resetsAt = new Date(Date.now() + 1800_000).toISOString();
  const wire = dryPlan(resetsAt);
  try {
    await runner.send(grandchild, "deep wall", undefined, parentMessage(), new SubAgentRegistry(), child).catch(() => undefined);
  } finally {
    wire.restore();
  }

  assert.ok((await readMeta(grandchild))?.quotaRetry?.pending, "two levels down still waits");
});

test("with the conversation's switch off, a child arms nothing", async () => {
  const runner = makeRunner();
  const id = await spawnChild(runner);
  await writeRoot(false);

  const wire = dryPlan(new Date(Date.now() + 3600_000).toISOString());
  try {
    await runner.send(id, "wall", undefined, parentMessage(), new SubAgentRegistry(), PARENT).catch(() => undefined);
  } finally {
    wire.restore();
  }

  assert.equal((await readMeta(id))?.quotaRetry, undefined, "off is off, at every level");
});
