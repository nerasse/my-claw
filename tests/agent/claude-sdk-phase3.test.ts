import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { createSpawnTool } from "../../src/tools/spawn.ts";
import type { AgentInfo } from "../../src/agents/types.ts";
import { resolveAgentLlmConfig } from "../../src/llm/resolver.ts";
import type { MessagePreprocessor } from "../../src/agent/preprocess.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import type { SubAgentRunner } from "../../src/subagents/runner.ts";
import type { SubAgentRegistry } from "../../src/subagents/registry.ts";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: {
        litellm: { baseUrl: "https://litellm.local/v1" },
        anthropic: { type: "claude-sdk" },
      },
      models: [
        { id: "mimo", label: "Mimo", provider: "litellm" },
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic", vision: true },
      ],
      defaultProvider: "litellm",
      defaultModel: "mimo",
    },
    agents: {}, memory: { enabled: false },
  };
}

function session(id: string, modelOverride?: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [], modelOverride };
}

test("compact maps to the SDK /compact slash command", async () => {
  const captured: Array<{ options: Record<string, unknown>; first?: string }> = [];
  const queryFn: SdkQueryFn = ({ prompt, options }) => {
    const call: { options: Record<string, unknown>; first?: string } = { options };
    captured.push(call);
    return (async function* () {
      const first = await prompt.next();
      if (!first.done) call.first = String(first.value.message.content);
      yield { type: "system", subtype: "compact_boundary" } as never;
      yield { type: "result", subtype: "success", result: "compacted" } as never;
    })() as AsyncIterable<never>;
  };
  const backend = new ClaudeSdkBackend(baseConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);

  const sess = session("s1");
  sess.sdkSessionId = "sdk-42";
  const out = await backend.compact(sess);

  assert.ok(out.includes("compacted"));
  assert.equal(captured[0]!.first, "/compact");
  assert.equal(captured[0]!.options["resume"], "sdk-42");
});

test("compact without an SDK session is a friendly no-op", async () => {
  const queryFn: SdkQueryFn = () => { throw new Error("must not be called"); };
  const backend = new ClaudeSdkBackend(baseConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);
  const out = await backend.compact(session("s1"));
  assert.ok(out.includes("Nothing to compact"));
});

test("spawn tool exposes a live model enum and validates the model", async () => {
  let models = ["mimo", "claude-sonnet-5"];
  const runnerCalls: Array<{ model?: string }> = [];
  const runner = {
    spawn: async (opts: { model?: string }) => {
      runnerCalls.push({ model: opts.model });
      return { id: "subagent/x", result: "done" };
    },
  } as unknown as SubAgentRunner;
  const registry = { listExistingIds: async () => new Set<string>(), generateId: (n: string) => `subagent/${n}` } as unknown as SubAgentRegistry;
  let agents: AgentInfo[] = [
    { name: "research", description: "Read-only", base: "research", source: "built-in", path: "/r.md" },
    { name: "general", description: "Full", base: "general", source: "built-in", path: "/g.md" },
  ];
  const tool = createSpawnTool(runner, registry, () => models, () => agents);

  const params = tool.parameters as { properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(params.properties["model"]?.enum, ["mimo", "claude-sonnet-5"]);
  assert.deepEqual(params.properties["type"]?.enum, ["research", "general"]);
  models = ["mimo"];
  const params2 = tool.parameters as { properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(params2.properties["model"]?.enum, ["mimo"]);
  models = ["mimo", "claude-sonnet-5"];

  const message = { id: "m1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "", attachments: [], isForwarded: false, raw: {} };
  const bad = await tool.execute({ name: "a", type: "research", mode: "run", task: "t", model: "nope", __message: message });
  assert.equal(bad.success, false);
  assert.ok(bad.error?.includes("Unknown model"));

  const ok = await tool.execute({ name: "a", type: "research", mode: "run", task: "t", model: "claude-sonnet-5", __message: message });
  assert.equal(ok.success, true);
  assert.equal(runnerCalls[0]?.model, "claude-sonnet-5");

  // The agent list is live for the same reason the model list is: a file dropped in `agents/`
  // must be spawnable on the next run, and one deleted must stop being offered.
  agents = [{ name: "reviewer", description: "Reviews", base: "research", source: "custom", path: "/rev.md" }];
  const params3 = tool.parameters as { properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(params3.properties["type"]?.enum, ["reviewer"]);
  assert.match(tool.description, /reviewer: Reviews/, "the description is how the model learns an agent exists");

  const gone = await tool.execute({ name: "a", type: "research", mode: "run", task: "t", __message: message });
  assert.equal(gone.success, false);
  assert.match(gone.error ?? "", /Unknown agent 'research'/);
});

test("agent llm resolution honors an explicit sub-agent model across backends", () => {
  const config = baseConfig();
  const sdk = resolveAgentLlmConfig(config.agents?.["research"]?.llm, config.llm, "claude-sonnet-5");
  assert.equal(sdk.backend, "claude-sdk");
  const home = resolveAgentLlmConfig(config.agents?.["research"]?.llm, config.llm, "mimo");
  assert.equal(home.backend, undefined);
});

test("images ride along as base64 blocks when the model has vision", async () => {
  runRegistry.clear();
  const captured: Array<{ content: unknown }> = [];
  const queryFn: SdkQueryFn = ({ prompt }) => {
    return (async function* () {
      const first = await prompt.next();
      if (!first.done) captured.push({ content: first.value.message.content });
      yield { type: "result", subtype: "success", result: "seen" } as never;
    })() as AsyncIterable<never>;
  };

  // Stub preprocessor: emits one data-URL image part like the real one does.
  const preprocessor = {
    preprocessMessage: async () => {},
    preprocessForHandle: async () => {},
    cleanupTempFiles: async () => {},
    buildUserContent: (m: UnifiedMessage) => m.text,
    buildImageContent: async () => [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ],
    addResponseAttachment: () => {},
    consumeEchoMessages: () => [],
    consumeResponseAttachments: () => undefined,
    inboundHadAudio: () => false,
  } as unknown as MessagePreprocessor;

  const backend = new ClaudeSdkBackend(baseConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, preprocessor, queryFn);
  const message: UnifiedMessage = {
    id: "m1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "look",
    attachments: [{ type: "image", path: "/tmp/x.png" }], isForwarded: false, raw: {},
  };
  const out = await backend.handleMessage(message, session("s1", "claude-sonnet-5"));
  assert.equal(out, "seen");

  const content = captured[0]!.content as Array<{ type: string; source?: { media_type: string; data: string } }>;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]!.type, "text");
  assert.equal(content[1]!.type, "image");
  assert.equal(content[1]!.source?.media_type, "image/png");
  assert.equal(content[1]!.source?.data, "QUJD");
});
