import { describe, test, expect, afterEach } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  handleSkillsCommand,
  handleAgentsCommand,
  handleMcpCommand,
  handleInstructionsCommand,
  type IntrospectParams,
} from "../../src/channels/introspect-commands.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { FileAgent } from "../../src/agents/types.ts";
import { cleanupGeneratedTempFiles } from "../../src/utils/media.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { McpServerStatus } from "../../src/mcp/manager.ts";
import type { Skill } from "../../src/skills/types.ts";
import type { SubAgentInfo } from "../../src/subagents/types.ts";
import type { OutgoingMessage } from "../../src/channels/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

function skill(name: string): Skill {
  return { meta: { name, description: `${name} does things` }, content: `# ${name}`, path: `/s/${name}/SKILL.md`, source: "custom" };
}

function agent(name: string, base: "general" | "research", extra: Partial<FileAgent["meta"]> = {}): FileAgent {
  return {
    name,
    meta: { description: `${name} agent`, base, instructions: ["CORE", "SOUL", "AGENTS", "USER"], ...extra },
    prompt: `Mandate of ${name}.`,
    path: `/a/${name}.md`,
    source: "built-in",
  };
}

/** The two shipped built-ins, so the command tests see the catalog a real boot would have. */
function agentRegistry(): AgentRegistry {
  return new AgentRegistry(new Map([
    ["general", agent("general", "general")],
    ["research", agent("research", "research")],
  ]));
}

function tool(name: string) {
  return { name, description: `${name} tool`, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) };
}

const SERVERS: McpServerStatus[] = [
  { name: "mailcow", transport: "stdio", state: "connected", toolCount: 2 },
  { name: "weather", transport: "stdio", state: "failed", toolCount: 0, lastError: "spawn ENOENT" },
  { name: "off", transport: "http", state: "disabled", toolCount: 0 },
];

const INSTANCES: SubAgentInfo[] = [
  { id: "subagent/deploy-a1b2", displayName: "deploy", type: "general", messageCount: 14, status: "idle" },
];

function params(agents: MyClawConfig["agents"], args = "", overrides: Partial<IntrospectParams> = {}): IntrospectParams {
  const tools = new ToolRegistry();
  for (const n of ["read", "grep", "find", "ls", "fetch", "web_search", "list_skills", "read_skill", "manage_skills", "bash", "memory", "cron", "spawn"]) {
    tools.register(tool(n));
  }
  tools.setDynamicProvider(() => [tool("mcp__mailcow__list"), tool("mcp__weather__now")]);
  return {
    args,
    config: {
      whitelist: [], blacklist: [], channels: {},
      llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
      agents,
    },
    skillRegistry: new SkillRegistry(new Map([["alpha", skill("alpha")], ["beta", skill("beta")]])),
    agentRegistry: agentRegistry(),
    toolRegistry: tools,
    mcpStatus: () => SERVERS,
    listSubAgents: async () => INSTANCES,
    platform: "telegram",
    ...overrides,
  };
}

describe("/skills", () => {
  test("no argument reports the orchestrator", async () => {
    const out = await handleSkillsCommand(params({ orchestrator: { skills: ["alpha"] }, general: { skills: ["beta"] } }));
    expect(out).toContain("Skills de orchestrator");
    expect(out).toContain("- alpha:");
    expect(out).not.toContain("- beta:");
  });

  test("counts in-scope against the whole store", async () => {
    const out = await handleSkillsCommand(params({ general: { skills: ["beta"] } }, "general"));
    expect(out).toContain("1 sur 2");
    expect(out).toContain("Périmètre : beta");
  });

  test("reports a configured name that matches no skill", async () => {
    // A typo narrows an agent silently, so it has to be visible where the effect is felt.
    const out = await handleSkillsCommand(params({ general: { skills: ["beta", "typo"] } }, "general"));
    expect(out).toContain("Configuré mais introuvable : typo");
  });

  test("reports write access, which only the orchestrator has", async () => {
    expect(await handleSkillsCommand(params({}))).toContain("Écriture (manage_skills) : oui");
    expect(await handleSkillsCommand(params({}, "general"))).toContain("Écriture (manage_skills) : non");
  });

  test("an empty scope says so instead of printing an empty list", async () => {
    const out = await handleSkillsCommand(params({ research: { skills: [] } }, "research"));
    expect(out).toContain("0 sur 2");
    expect(out).toContain("Aucune skill dans ce périmètre");
  });

  test("a live sub-agent id resolves through its type", async () => {
    // Scope is per type, so naming an instance must answer with that type's scope, not invent one.
    const out = await handleSkillsCommand(params({ general: { skills: ["beta"] } }, "subagent/deploy-a1b2"));
    expect(out).toContain("subagent/deploy-a1b2 (type general)");
    expect(out).toContain("- beta:");
    expect(out).not.toContain("- alpha:");
  });

  test("an unknown name lists the accepted values", async () => {
    const out = await handleSkillsCommand(params({}, "nope"));
    expect(out).toContain("Agent inconnu : nope");
    expect(out).toContain("orchestrator");
    expect(out).toContain("subagent/");
  });
});

describe("/agents", () => {
  test("separates the reserved roles from the file-defined agents", async () => {
    const out = await handleAgentsCommand(params({ general: { skills: ["beta"], mcp: ["mailcow"] } }));
    // Roles are not spawnable and have no file, so they cannot sit in the same list as the agents.
    expect(out).toContain("Rôles");
    expect(out).toContain("- orchestrator |");
    // cron inherits the orchestrator and the output must say why rather than omit it.
    expect(out).toContain("- cron (hérite de orchestrator) |");
    expect(out).toContain("Agents (fichiers)");
    for (const t of ["general", "research"]) expect(out).toContain(`- ${t} [built-in] |`);
    expect(out).toContain("subagent/deploy-a1b2 | deploy | general | 14 messages | idle");
    // The one agent invisible to list_agents, which is why it is named explicitly.
    expect(out).toContain("browser :");
  });

  test("shows each agent's tier and description, so shadowing is visible", async () => {
    const registry = agentRegistry();
    registry.setAll(new Map([
      ["reviewer", { ...agent("reviewer", "research"), source: "workspace" as const, layer: "proj" }],
    ]));
    const out = await handleAgentsCommand(params({}, "", { agentRegistry: registry }));
    expect(out).toContain("- reviewer [workspace:proj] |");
    expect(out).toContain("reviewer agent");
  });

  test("an agent with no file at all reads as none, not as a missing section", async () => {
    const out = await handleAgentsCommand(params({}, "", { agentRegistry: new AgentRegistry() }));
    expect(out).toContain("Agents (fichiers)\n- (aucun)");
    // The roles still stand: they exist without a file.
    expect(out).toContain("- orchestrator |");
  });

  test("reports each agent's iterations, scope and tool count", async () => {
    const out = await handleAgentsCommand(params({ orchestrator: { maxIterations: 7 }, research: { mcp: ["mailcow"] } }));
    expect(out).toMatch(/- orchestrator \| 7 itérations/);
    expect(out).toMatch(/- research \[built-in\] \|.*mcp: mailcow/);
    expect(out).toMatch(/outils: research \(\d+\)/);
  });

  test("a file's tools narrow the count the command reports", async () => {
    const registry = new AgentRegistry(new Map([
      ["narrow", agent("narrow", "general", { tools: ["read", "grep"] })],
    ]));
    const out = await handleAgentsCommand(params({}, "", { agentRegistry: registry }));
    expect(out).toContain("outils: general (2)");
  });

  test("says none when no sub-agent is alive", async () => {
    const out = await handleAgentsCommand(params({}, "", { listSubAgents: async () => [] }));
    expect(out).toContain("- (aucun)");
  });
});

describe("/mcp", () => {
  test("lists every declared server, in scope or not", async () => {
    const out = await handleMcpCommand(params({ general: { mcp: ["mailcow"] } }, "general"));
    expect(out).toContain("1 sur 3 dans le périmètre");
    expect(out).toContain("mailcow | stdio | connected | 2 outils [dans le périmètre]");
    expect(out).toContain("[hors périmètre]");
  });

  test("keeps a failed server visible with its reason", async () => {
    // Listing only live connections would hide exactly the servers worth reporting.
    const out = await handleMcpCommand(params({}));
    expect(out).toContain("weather | stdio | failed | spawn ENOENT");
    expect(out).toContain("off | http | disabled");
  });

  test("research without an explicit grant has no server and no warning", async () => {
    const out = await handleMcpCommand(params({ orchestrator: { mcp: ["*"] } }, "research"));
    expect(out).toContain("0 sur 3");
    expect(out).toContain("Périmètre : aucun");
    expect(out).not.toContain("lecture seule");
  });

  test("research with a grant warns that the read-only guarantee is gone", async () => {
    const out = await handleMcpCommand(params({ research: { mcp: ["mailcow"] } }, "research"));
    expect(out).toContain("Périmètre : mailcow");
    expect(out).toContain("la garantie « research est en lecture seule » ne tient plus");
  });

  test("reports a scoped server that is not declared anywhere", async () => {
    const out = await handleMcpCommand(params({ general: { mcp: ["ghost"] } }, "general"));
    expect(out).toContain("Configuré mais non déclaré : ghost");
  });

  test("says so when config.mcp is empty", async () => {
    const out = await handleMcpCommand(params({}, "", { mcpStatus: () => [] }));
    expect(out).toContain("Aucun serveur déclaré");
  });
});

describe("/instructions", () => {
  async function dump(p: IntrospectParams): Promise<{ text: string; body: string; filename: string }> {
    const res = await handleInstructionsCommand(p);
    expect(typeof res).not.toBe("string");
    const msg = res as OutgoingMessage;
    const att = msg.attachments?.[0];
    expect(att?.path).toBeTruthy();
    tempDirs.push(dirname(att!.path!));
    return { text: msg.text, body: await readFile(att!.path!, "utf-8"), filename: att!.filename ?? "" };
  }

  test("answers with a summary and the full prompt as a file", async () => {
    // 11-14 KB would be 3 to 4 split messages, and the splitter can cut inside a code fence.
    const { text, body, filename } = await dump(params({}));
    expect(filename).toBe("prompt-main.md");
    expect(text).toContain(`${body.length} octets`);
    expect(body).toContain("# Available skills");
    expect(body).toContain("# Available tools");
  });

  test("the dump is scoped like the agent it describes", async () => {
    const { text, body } = await dump(params({ general: { skills: ["beta"] } }, "general"));
    expect(body).toContain("- beta: beta does things");
    expect(body).not.toContain("alpha");
    expect(text).toContain("périmètre beta");
  });

  test("out-of-scope MCP tools are absent from the tool layer", async () => {
    const { body } = await dump(params({ orchestrator: { mcp: ["mailcow"] } }));
    expect(body).toContain("- mcp__mailcow__list:");
    expect(body).not.toContain("mcp__weather__now");
  });

  test("cron is dumped without a platform hint, and says so", async () => {
    // A cron run has no channel: borrowing the caller's hint would lie on the layer being checked.
    const { text } = await dump(params({}, "cron"));
    expect(text).toContain("plateforme : cron");
    expect(text).toContain("Couche platform hint : absente");
  });

  test("an SDK-backed agent carries the steering note the backend appends", async () => {
    const sdk = params({}, "");
    sdk.config = {
      ...sdk.config,
      llm: {
        providers: { anthropic: { type: "claude-sdk" } },
        models: [{ id: "claude-sonnet-5", label: "S", provider: "anthropic" }],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-5",
      },
    };
    const { text, body } = await dump(sdk);
    expect(text).toContain("backend : claude-sdk");
    expect(body).toContain("# Mid-run steering");
    expect(text).toContain("note de pilotage SDK");
  });

  test("a home-loop agent carries no steering note", async () => {
    const { body } = await dump(params({}));
    expect(body).not.toContain("# Mid-run steering");
  });

  test("names what a static dump cannot reproduce", async () => {
    const { text } = await dump(params({}));
    expect(text).toContain("les skills suggérées dépendent du texte du message");
    expect(text).toContain("AGENTS.md imbriqués");
  });

  test("an unknown agent returns a plain error and writes no file", async () => {
    const res = await handleInstructionsCommand(params({}, "nope"));
    expect(typeof res).toBe("string");
    expect(String(res)).toContain("Agent inconnu");
  });

  test("the temp dir it creates is recognised by the attachment cleanup", async () => {
    // The command paths never cleaned attachments, so this leaked a temp file per call.
    const res = (await handleInstructionsCommand(params({}))) as OutgoingMessage;
    const path = res.attachments![0]!.path!;
    expect(await readFile(path, "utf-8")).not.toBe("");
    await cleanupGeneratedTempFiles(res.attachments);
    await expect(readFile(path, "utf-8")).rejects.toThrow();
  });
});
