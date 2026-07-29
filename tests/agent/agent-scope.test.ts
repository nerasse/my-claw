import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Skill } from "../../src/skills/types.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

// These tests cover the wiring, not the resolvers: tests/config.test.ts already pins the resolution
// table. What can only be caught here is a backend that resolves a scope and then forgets to use it,
// or forgets to tell a tool which agent is calling.

function baseConfig(agents: MyClawConfig["agents"] = {}): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents, memory: { enabled: false },
  };
}

function sdkConfig(agents: MyClawConfig["agents"] = {}): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
    },
    agents, memory: { enabled: false },
  };
}

function msg(text: string, platform: UnifiedMessage["platform"] = "telegram"): UnifiedMessage {
  return { id: `m-${Math.random()}`, platform, userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function session(id: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

function skill(name: string): Skill {
  return { meta: { name, description: `${name} description` }, content: `# ${name}`, path: `/skills/${name}/SKILL.md`, source: "custom" };
}

/** Two skills and two MCP servers, so every assertion can name one that is in and one that is out. */
function fixtures(): { skills: SkillRegistry; mcp: Tool[] } {
  return {
    skills: new SkillRegistry(new Map([["alpha", skill("alpha")], ["beta", skill("beta")]])),
    mcp: [
      { name: "mcp__srv_a__ping", description: "a", parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) },
      { name: "mcp__srv_b__ping", description: "b", parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) },
    ],
  };
}

function llmResponse(message: object): never {
  return new Response(
    JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ) as never;
}

interface HomeRun {
  systemPrompt: string;
  toolNames: string[];
  toolArgs: Record<string, unknown> | undefined;
}

/**
 * One home-loop run that calls `probe` once then finishes, capturing what the LLM was told and what
 * the tool actually received.
 */
async function runHome(
  config: MyClawConfig,
  skills: SkillRegistry,
  opts: { depth?: number; agentKind?: "general" | "research"; platform?: UnifiedMessage["platform"]; dynamic?: Tool[] } = {},
): Promise<HomeRun> {
  runRegistry.clear();
  const registry = new ToolRegistry();
  let toolArgs: Record<string, unknown> | undefined;
  registry.register({
    name: "probe",
    description: "probe",
    parameters: { type: "object", properties: {} },
    async execute(args) { toolArgs = args; return { success: true, output: "ok" }; },
  });
  if (opts.dynamic) registry.setDynamicProvider(() => opts.dynamic ?? []);

  const bridge = new AgentBridge(
    config, registry, skills, undefined, undefined,
    opts.depth ?? 0, undefined, opts.agentKind,
  );
  const sess = session(`telegram/dm/u1-${Math.random()}`);
  const { signal, end } = runRegistry.startRoot(sess.id);

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    call++;
    if (call === 1) {
      return llmResponse({ content: "", tool_calls: [{ id: "tc1", function: { name: "probe", arguments: "{}" } }] });
    }
    return llmResponse({ content: "done" });
  });

  try {
    await bridge.handleMessage(msg("go", opts.platform ?? "telegram"), sess, signal);
    const first = bodies[0];
    const system = first?.messages.find((m) => m.role === "system");
    return {
      systemPrompt: typeof system?.content === "string" ? system.content : "",
      toolNames: (first?.tools ?? []).map((t) => t.function.name),
      toolArgs,
    };
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
}

// --- Prompt catalog (layer 5) ---

test("scope: the prompt catalog of a sub-agent lists only its skills", async () => {
  const { skills } = fixtures();
  const run = await runHome(baseConfig({ general: { skills: ["alpha"] } }), skills, { depth: 1, agentKind: "general" });

  assert.match(run.systemPrompt, /# Available skills/);
  assert.match(run.systemPrompt, /- alpha: alpha description/);
  // The catalog says the agent MUST read_skill anything listed, so an out-of-scope entry here would
  // promise something read_skill then refuses.
  assert.doesNotMatch(run.systemPrompt, /beta/);
});

test("scope: the orchestrator's own list restricts the orchestrator", async () => {
  const { skills } = fixtures();
  const run = await runHome(baseConfig({ orchestrator: { skills: ["beta"] } }), skills, { depth: 0 });
  assert.match(run.systemPrompt, /- beta:/);
  assert.doesNotMatch(run.systemPrompt, /alpha/);
});

test("scope: an unscoped config leaves the whole catalog in the prompt", async () => {
  const { skills } = fixtures();
  const run = await runHome(baseConfig(), skills, { depth: 1, agentKind: "general" });
  assert.match(run.systemPrompt, /- alpha:/);
  assert.match(run.systemPrompt, /- beta:/);
});

test("scope: an empty list removes the skills layer entirely", async () => {
  const { skills } = fixtures();
  const run = await runHome(baseConfig({ research: { skills: [] } }), skills, { depth: 1, agentKind: "research" });
  // buildSystemPrompt skips empty layers, so no catalog and no "MUST read_skill" instruction.
  assert.doesNotMatch(run.systemPrompt, /# Available skills/);
  assert.doesNotMatch(run.systemPrompt, /alpha|beta/);
});

test("scope: a sub-agent inherits the orchestrator's list when it has none", async () => {
  const { skills } = fixtures();
  const run = await runHome(baseConfig({ orchestrator: { skills: ["alpha"] }, general: {} }), skills, { depth: 1, agentKind: "general" });
  assert.match(run.systemPrompt, /- alpha:/);
  assert.doesNotMatch(run.systemPrompt, /beta/);
});

test("scope: a cron run uses the orchestrator's list", async () => {
  const { skills } = fixtures();
  const run = await runHome(baseConfig({ orchestrator: { skills: ["beta"] } }), skills, { platform: "cron" });
  assert.match(run.systemPrompt, /- beta:/);
  assert.doesNotMatch(run.systemPrompt, /alpha/);
});

// --- __agentType reaching the tools ---

test("scope: the home loop tells a tool which agent class called it", async () => {
  // Without this the scope inside list_skills/read_skill silently falls back to the orchestrator,
  // and a restricted sub-agent would read anything.
  const { skills } = fixtures();
  assert.equal((await runHome(baseConfig(), skills, { depth: 0 })).toolArgs?.["__agentType"], "main");
  assert.equal((await runHome(baseConfig(), skills, { depth: 1, agentKind: "general" })).toolArgs?.["__agentType"], "general");
  assert.equal((await runHome(baseConfig(), skills, { depth: 1, agentKind: "research" })).toolArgs?.["__agentType"], "research");
  assert.equal((await runHome(baseConfig(), skills, { platform: "cron" })).toolArgs?.["__agentType"], "cron");
});

// --- MCP scope reaching the tool list the LLM sees ---

test("scope: out-of-scope MCP tools are never offered to the model", async () => {
  const { skills, mcp } = fixtures();
  const run = await runHome(baseConfig({ orchestrator: { mcp: ["srv_a"] } }), skills, { dynamic: mcp });
  assert.ok(run.toolNames.includes("mcp__srv_a__ping"));
  assert.ok(!run.toolNames.includes("mcp__srv_b__ping"));
  assert.ok(run.toolNames.includes("probe"));
});

test("scope: a research sub-agent gets no MCP tool without an explicit grant", async () => {
  const { skills, mcp } = fixtures();
  const denied = await runHome(baseConfig({ orchestrator: { mcp: ["*"] } }), skills, { depth: 1, agentKind: "research", dynamic: mcp });
  assert.ok(!denied.toolNames.some((n) => n.startsWith("mcp__")));

  const granted = await runHome(baseConfig({ research: { mcp: ["srv_b"] } }), skills, { depth: 1, agentKind: "research", dynamic: mcp });
  assert.ok(granted.toolNames.includes("mcp__srv_b__ping"));
  assert.ok(!granted.toolNames.includes("mcp__srv_a__ping"));
});

// --- The SDK backend must behave identically ---

async function runSdk(
  config: MyClawConfig,
  skills: SkillRegistry,
  opts: { depth?: number; agentKind?: "general" | "research"; dynamic?: Tool[] } = {},
): Promise<{ systemPrompt: string }> {
  runRegistry.clear();
  const registry = new ToolRegistry();
  registry.register({ name: "probe", description: "probe", parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "ok" }) });
  if (opts.dynamic) registry.setDynamicProvider(() => opts.dynamic ?? []);

  let options: Record<string, unknown> = {};
  const queryFn: SdkQueryFn = ({ prompt, options: opts2 }) => {
    options = opts2;
    return (async function* () {
      await prompt.next();
      yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } } };
      yield { type: "result", subtype: "success", result: "done" };
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
  };

  const backend = new ClaudeSdkBackend(
    config, registry, skills, undefined, undefined,
    opts.depth ?? 0, undefined, opts.agentKind, undefined, undefined, queryFn,
  );
  const sess = session(`telegram/dm/sdk-${Math.random()}`);
  const { signal, end } = runRegistry.startRoot(sess.id);
  try {
    await backend.handleMessage(msg("go"), sess, signal);
    // The SDK stores its tools in a private field of the server instance, so the assertion goes
    // through prompt layer 6 instead: it renders the very same array the tool server was built from,
    // and it is what the model actually reads.
    return { systemPrompt: String(options["systemPrompt"] ?? "") };
  } finally {
    end(); runRegistry.clear();
  }
}

test("scope: the SDK backend scopes the catalog like the home loop", async () => {
  // The two backends compose the prompt through the same builder but from separate call sites, so a
  // scope applied in one and not the other would be invisible to every other test.
  const { skills } = fixtures();
  const run = await runSdk(sdkConfig({ general: { skills: ["alpha"] } }), skills, { depth: 1, agentKind: "general" });
  assert.match(run.systemPrompt, /- alpha: alpha description/);
  assert.doesNotMatch(run.systemPrompt, /beta/);
});

test("scope: the SDK backend filters MCP tools out of the set it exposes", async () => {
  const { skills, mcp } = fixtures();
  const run = await runSdk(sdkConfig({ orchestrator: { mcp: ["srv_a"] } }), skills, { dynamic: mcp });
  const toolsLayer = run.systemPrompt.slice(run.systemPrompt.indexOf("# Available tools"));
  assert.match(toolsLayer, /- mcp__srv_a__ping:/);
  assert.doesNotMatch(toolsLayer, /mcp__srv_b__ping/);
  assert.match(toolsLayer, /- probe:/);
});

test("scope: the home loop keeps the prompt tool layer and the API payload in step", async () => {
  // Two independent renderings of the same array. If only one were filtered the model would be told
  // about a tool it is not allowed to call, or the reverse.
  const { skills, mcp } = fixtures();
  const run = await runHome(baseConfig({ orchestrator: { mcp: ["srv_a"] } }), skills, { dynamic: mcp });
  const toolsLayer = run.systemPrompt.slice(run.systemPrompt.indexOf("# Available tools"));
  assert.match(toolsLayer, /- mcp__srv_a__ping:/);
  assert.doesNotMatch(toolsLayer, /mcp__srv_b__ping/);
  assert.deepEqual(run.toolNames.filter((n) => n.startsWith("mcp__")), ["mcp__srv_a__ping"]);
});
