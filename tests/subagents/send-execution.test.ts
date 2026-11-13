/**
 * Drving an existing sub-agent on another model, and refusing to leave it -- docs/subagents.md.
 *
 * Two things are pinned here, both measured on 2026-10-28:
 *
 * - a caller that names a model on purpose gets that model or the failure. An explicit GPT request
 *   whose account was spent answered on DeepSeek through the agent's own tagged default, and the
 *   `[fallback]` note announcing it arrived after the work was done. Announcing an unauthorised
 *   fallback does not authorise it.
 * - the settings a `send` carries are run-scoped unless the caller says otherwise, and they are put
 *   back before the write: a one-off account choice must not become the agent's permanent one.
 *
 * Everything is read off the wire (`mockFetch`), not off a resolved config, because the bug was
 * exactly a resolved config that said one thing while another answered.
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
import { createSendTool } from "../../src/tools/send.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, loadSession } from "../../src/sessions/store.ts";
import { runRegistry } from "../../src/core/run-registry.ts";

const PARENT = "my-claw-app/thread/owner/main";

/**
 * One GPT account and one default, which is the shape of the incident: `gptacct` pinned, the agent's
 * configured default a tag that names DeepSeek first. Both are plain OpenAI-compatible endpoints on
 * purpose: the test reads the wire, and a subscription transport would stop before it.
 */
function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      providers: {
        gptacct: { baseUrl: "https://gpt.example/v1", apiKey: "k1" },
        opencode: { baseUrl: "https://opencode.example/v1", apiKey: "k2" },
      },
      models: [
        { id: "gptacct/gpt-6.1-sol", provider: "gptacct" },
        { id: "opencode/deepseek-v4.1-flash", provider: "opencode" },
      ],
      defaultProvider: "opencode",
      defaultModel: "opencode/deepseek-v4.1-flash",
    },
    tags: { Cheap: { model: "opencode/deepseek-v4.1-flash" } },
    agents: {},
    memory: { enabled: false },
  } as unknown as MyClawConfig;
}

function agentFile(name: string, model?: string): FileAgent {
  return {
    name,
    meta: { description: `${name} agent`, base: "general", instructions: [], ...(model ? { model } : {}) },
    prompt: "",
    path: `/agents/${name}.md`,
    source: "custom",
  };
}

function parentMessage(): UnifiedMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    platform: "my-claw-app", userId: "owner", chatId: "owner", chatType: "dm",
    text: "go", attachments: [], isForwarded: false, raw: {},
  };
}

/** The model each request carried, and a refusal for the accounts the test means to be spent. */
function wire(opts: { spent?: string; message?: string } = {}) {
  const seen: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    const model = body.model ?? "";
    seen.push(model);
    if (opts.spent && model === opts.spent) {
      return new Response(
        JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 3600 } }),
        { status: 429 },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: opts.message ?? "done" } }] }), { status: 200 }) as never;
  });
  return { seen, restore: () => mock.restore() };
}

const made: string[] = [];

async function spawnSession(runnerAgent = "worker"): Promise<string> {
  const cfg = config();
  const runner = new SubAgentRunner(
    cfg, new ToolRegistry(), new SkillRegistry(),
    new VoiceManager(cfg), new SttPipeline(new VoiceManager(cfg)),
    new AgentRegistry(new Map([[runnerAgent, agentFile(runnerAgent)]])) as unknown as AgentRegistry,
  );
  const ids = new SubAgentRegistry();
  // The session's first run is a real run: it needs its own wire, or the network guard fires.
  const setup = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "first" } }] }), { status: 200 }) as never);
  try {
    const { id } = await runner.spawn({
      displayName: runnerAgent, type: runnerAgent, mode: "session", task: "first pass",
      parentMessage: parentMessage(), existingIds: await ids.listExistingIds(),
      generateId: (n, e) => ids.generateId(n, e), parentSessionId: PARENT,
      visibility: "global",
    });
    made.push(id);
    return id;
  } finally {
    setup.restore();
  }
}

function sendTool(runner: SubAgentRunner, registry = new SubAgentRegistry()) {
  return createSendTool(runner, registry, undefined, () => ["gptacct/gpt-6.1-sol", "opencode/deepseek-v4.1-flash", "tag:Cheap"]);
}

function makeRunner(): SubAgentRunner {
  const cfg = config();
  return new SubAgentRunner(
    cfg, new ToolRegistry(), new SkillRegistry(),
    new VoiceManager(cfg), new SttPipeline(new VoiceManager(cfg)),
    new AgentRegistry(new Map([["worker", agentFile("worker")]])) as unknown as AgentRegistry,
  );
}

afterEach(async () => {
  for (const id of made.splice(0)) await deleteSession(id);
  runRegistry.clear();
});

/**
 * The incident itself. With `forbid`, a spent account is the end of the run: no second model is
 * called, so there is nothing to undo and nothing to distrust.
 */
test("fallback='forbid': a spent account stops the run instead of answering on another family", async () => {
  const id = await spawnSession();
  const wireSpy = wire({ spent: "gpt-6.1-sol" });
  try {
    const tool = sendTool(makeRunner());
    const result = await tool.execute({
      id, message: "continue the implementation",
      model: "gptacct/gpt-6.1-sol", fallback: "forbid",
      __message: parentMessage(), __sessionId: PARENT,
    });
    assert.equal(result.success, false);
    assert.deepEqual(wireSpy.seen, ["gpt-6.1-sol"], "no other model was ever called");
    assert.match(result.error ?? "", /spent quota/);
  } finally {
    wireSpy.restore();
  }
});

test("without the policy the chain still answers, which is what 'inherit' means", async () => {
  const id = await spawnSession();
  const wireSpy = wire({ spent: "gpt-6.1-sol" });
  try {
    const tool = sendTool(makeRunner());
    const result = await tool.execute({
      id, message: "continue",
      model: "gptacct/gpt-6.1-sol",
      __message: parentMessage(), __sessionId: PARENT,
    });
    assert.equal(result.success, true);
    // The configured default answered after the pinned account refused -- the documented chain.
    assert.deepEqual(wireSpy.seen, ["gpt-6.1-sol", "deepseek-v4.1-flash"]);
  } finally {
    wireSpy.restore();
  }
});

/**
 * A blocked report is what a parent acts on: the class of failure, whether the tools already ran,
 * and when the provider said its limit reopens. Prose alone left it guessing in both directions.
 */
test("a blocked run answers with a structured report, and never claims the work was not done", async () => {
  const id = await spawnSession();
  const wireSpy = wire({ spent: "gpt-6.1-sol" });
  try {
    const tool = sendTool(makeRunner());
    const result = await tool.execute({
      id, message: "go", model: "gptacct/gpt-6.1-sol", fallback: "forbid",
      __message: parentMessage(), __sessionId: PARENT,
    });
    const line = (result.output ?? "").split("\n").find((l) => l.startsWith("blocked: "));
    assert.ok(line, "the report is on the output, as one JSON line");
    const report = JSON.parse(line!.slice("blocked: ".length)) as Record<string, unknown>;
    assert.equal(report["status"], "blocked");
    assert.equal(report["reason"], "quota_exhausted");
    assert.equal(report["agentId"], id);
    assert.equal(report["partialWork"], "unknown", "no tool settled, and a cut-off call settles nothing");
    assert.equal(report["historyPreserved"], true);
    assert.equal(report["resumable"], true);
    // The model as the caller named it, not the wire id: that is what a caller compares against
    // what it asked for, and the provider entry is what owns the quota.
    assert.deepEqual(report["requested"], { model: "gptacct/gpt-6.1-sol", provider: "gptacct" });
    const retry = report["retry"] as { eligibleAt?: string; source: string };
    assert.equal(retry.source, "provider_hint");
    assert.ok(retry.eligibleAt, "the provider's own resets_in_seconds became a time");
    assert.ok((report["nextActions"] as string[]).includes("wait"));
  } finally {
    wireSpy.restore();
  }
});

/** A run-scoped model is the one that runs, and the agent's own pin is back on disk afterwards. */
test("a run-scoped model applies to that call alone and is put back before the write", async () => {
  const id = await spawnSession();
  const runner = makeRunner();
  const wireSpy = wire({});
  try {
    const before = await loadSession(id);
    const tool = sendTool(runner);
    const result = await tool.execute({
      id, message: "one pass on the other account",
      model: "gptacct/gpt-6.1-sol", effort: "xhigh",
      __message: parentMessage(), __sessionId: PARENT,
    });
    assert.equal(result.success, true);
    assert.deepEqual(wireSpy.seen, ["gpt-6.1-sol"]);
    const after = await loadSession(id);
    assert.equal(after?.modelOverride, before?.modelOverride, "the standing pin is what it was");
    assert.equal(after?.effortOverride, undefined);
  } finally {
    wireSpy.restore();
  }
});

test("scope='session' keeps the settings, so the next plain send runs on them", async () => {
  const id = await spawnSession();
  const tool = sendTool(makeRunner());
  const first = wire({});
  try {
    const result = await tool.execute({
      id, message: "work here from now on",
      model: "gptacct/gpt-6.1-sol", scope: "session",
      __message: parentMessage(), __sessionId: PARENT,
    });
    assert.equal(result.success, true);
    const stored = await loadSession(id);
    assert.equal(stored?.modelOverride, "gptacct/gpt-6.1-sol");
  } finally {
    first.restore();
  }
  const second = wire({});
  try {
    const result = await tool.execute({ id, message: "and again", __message: parentMessage(), __sessionId: PARENT });
    assert.equal(result.success, true);
    assert.deepEqual(second.seen, ["gpt-6.1-sol"], "the session kept it");
  } finally {
    second.restore();
  }
});

/** A refused pin costs no request, and says which ids would have worked. */
test("a model this install does not know is refused before any run starts", async () => {
  const id = await spawnSession();
  const wireSpy = wire({});
  try {
    const tool = sendTool(makeRunner());
    const result = await tool.execute({
      id, message: "go", model: "gpt-6.1-sol",
      __message: parentMessage(), __sessionId: PARENT,
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /provider\/model/);
    assert.deepEqual(wireSpy.seen, []);
  } finally {
    wireSpy.restore();
  }
});

test("a nonsense fallback or scope is refused, never silently ignored", async () => {
  const id = await spawnSession();
  const tool = sendTool(makeRunner());
  const badFallback = await tool.execute({ id, message: "x", fallback: "maybe", __message: parentMessage(), __sessionId: PARENT });
  assert.equal(badFallback.success, false);
  assert.match(badFallback.error ?? "", /Unknown fallback/);
  const badScope = await tool.execute({ id, message: "x", scope: "forever", __message: parentMessage(), __sessionId: PARENT });
  assert.equal(badScope.success, false);
  assert.match(badScope.error ?? "", /Unknown scope/);
});

/** The schema is the model's only map: it has to name the fields, and not require them. */
test("the schema names the execution fields and requires only the id", () => {
  const tool = sendTool(makeRunner());
  const schema = tool.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["attachments", "contextCap", "effort", "fallback", "id", "message", "model", "scope", "wait"]);
  assert.deepEqual(schema.properties["fallback"]!.enum, ["forbid", "inherit"]);
  assert.deepEqual(schema.properties["scope"]!.enum, ["run", "session"]);
  assert.deepEqual(schema.required, ["id"]);
});
