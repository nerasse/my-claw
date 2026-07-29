import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAgentSkills,
  resolveAgentMcp,
  resolveMaxIterations,
  scopeAllows,
  type AgentScope,
  type AgentToolType,
  type MyClawConfig,
} from "../core/config.ts";
import { resolveAgentLlmConfig } from "../llm/resolver.ts";
import { buildSystemPrompt } from "../agent/prompt/builder.ts";
import { OWNER_STEERING_NOTE } from "../agent/claude-sdk/backend.ts";
import { hooks } from "../hooks/index.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { SubAgentInfo } from "../subagents/types.ts";
import type { OutgoingMessage } from "./types.ts";

/**
 * Shared bodies for `/skills`, `/agents`, `/mcp` and `/instructions` on every channel, following the
 * `config-commands.ts` pattern: no channel knowledge here, the caller supplies the live registries.
 * See docs/agent-scoping.md.
 */
export interface IntrospectParams {
  args: string;
  config: MyClawConfig;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  mcpStatus: () => McpServerStatus[];
  listSubAgents: () => Promise<SubAgentInfo[]>;
  /** The channel the command came from, so the platform-hint layer of a dump matches reality. */
  platform: string;
}

const CONFIG_AGENTS = ["orchestrator", "general", "research"] as const;
const VALID = "orchestrator (ou main), general, research, cron, ou un id de sous-agent (`subagent/nom-xxxx`)";

interface ResolvedAgent {
  toolType: AgentToolType;
  /** How the agent is named back to the user: a config type, or a live instance with its type. */
  label: string;
}

/**
 * Scope is per agent *type*, so a live sub-agent resolves through its `meta.type`. Naming an
 * instance is still accepted because that is how the owner sees agents in `/agents`.
 */
async function resolveAgent(args: string, listSubAgents: () => Promise<SubAgentInfo[]>): Promise<ResolvedAgent | string> {
  const token = args.trim().split(/\s+/)[0] ?? "";
  if (!token) return { toolType: "main", label: "orchestrator" };

  const lower = token.toLowerCase();
  if (lower === "main" || lower === "orchestrator") return { toolType: "main", label: "orchestrator" };
  if (lower === "general" || lower === "research" || lower === "cron") {
    return { toolType: lower, label: lower };
  }

  const instances = await listSubAgents();
  const found = instances.find((a) => a.id === token || a.id.toLowerCase() === lower || a.displayName.toLowerCase() === lower);
  if (found) return { toolType: found.type, label: `${found.id} (type ${found.type})` };

  return `Agent inconnu : ${token}\nValeurs acceptées : ${VALID}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

function scopeLabel(scope: AgentScope): string {
  if (scope === "all") return "* (tout)";
  return scope.length === 0 ? "aucun" : scope.join(", ");
}

/** Resolved model for an agent, or a marker: a broken provider must not take the command down. */
function modelFor(config: MyClawConfig, toolType: AgentToolType): string {
  const key = toolType === "general" || toolType === "research" ? toolType : undefined;
  try {
    return resolveAgentLlmConfig(key ? config.agents?.[key]?.llm : undefined, config.llm).model || "(aucun)";
  } catch (err) {
    return `(non résolu : ${String(err).slice(0, 60)})`;
  }
}

function backendFor(config: MyClawConfig, toolType: AgentToolType): string {
  const key = toolType === "general" || toolType === "research" ? toolType : undefined;
  try {
    return resolveAgentLlmConfig(key ? config.agents?.[key]?.llm : undefined, config.llm).backend ?? "openai";
  } catch {
    return "inconnu";
  }
}

function toolCount(p: IntrospectParams, toolType: AgentToolType): number {
  return p.toolRegistry.getForAgent(toolType, p.config.tools?.disabled, resolveAgentMcp(p.config, toolType)).length;
}

/** Scope entries matching no installed skill: reported so a typo is visible where it is felt. */
function missingSkillNames(p: IntrospectParams, scope: AgentScope): string[] {
  if (scope === "all") return [];
  const known = p.skillRegistry.names();
  return scope.filter((name) => !known.includes(name));
}

export async function handleSkillsCommand(p: IntrospectParams): Promise<string> {
  const agent = await resolveAgent(p.args, p.listSubAgents);
  if (typeof agent === "string") return agent;

  const scope = resolveAgentSkills(p.config, agent.toolType);
  const inScope = p.skillRegistry.list(scope);
  const total = p.skillRegistry.names().length;

  const lines = [`Skills de ${agent.label} — ${inScope.length} sur ${total}`, ""];
  if (inScope.length === 0) {
    lines.push("_Aucune skill dans ce périmètre._");
  } else {
    for (const s of inScope.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- ${s.name}: ${s.description} (${s.source})`);
    }
  }

  lines.push("", `Périmètre : ${scopeLabel(scope)}`);
  // manage_skills is main-only, so read access and write access differ per agent.
  const canWrite = p.toolRegistry
    .getForAgent(agent.toolType, p.config.tools?.disabled, resolveAgentMcp(p.config, agent.toolType))
    .some((t) => t.name === "manage_skills");
  lines.push(`Écriture (manage_skills) : ${canWrite ? "oui" : "non"}`);

  const missing = missingSkillNames(p, scope);
  if (missing.length > 0) lines.push(`Configuré mais introuvable : ${missing.join(", ")}`);

  return lines.join("\n");
}

export async function handleAgentsCommand(p: IntrospectParams): Promise<string> {
  const lines: string[] = ["Types configurés"];
  for (const key of CONFIG_AGENTS) {
    const toolType: AgentToolType = key === "orchestrator" ? "main" : key;
    const skills = resolveAgentSkills(p.config, toolType);
    const mcp = resolveAgentMcp(p.config, toolType);
    lines.push(
      `- ${key} | ${resolveMaxIterations(p.config, key)} itérations | ${modelFor(p.config, toolType)}` +
        ` | outils: ${toolType} (${toolCount(p, toolType)}) | skills: ${scopeLabel(skills)} | mcp: ${scopeLabel(mcp)}`,
    );
  }
  // cron has no config entry of its own and inherits the orchestrator, which is worth stating rather
  // than leaving the reader to wonder why it is missing.
  lines.push(
    `- cron (pas d'entrée de config, hérite de orchestrator) | outils: cron (${toolCount(p, "cron")})` +
      ` | skills: ${scopeLabel(resolveAgentSkills(p.config, "cron"))} | mcp: ${scopeLabel(resolveAgentMcp(p.config, "cron"))}`,
  );

  lines.push("", "Sous-agents vivants");
  const instances = await p.listSubAgents();
  if (instances.length === 0) {
    lines.push("- (aucun)");
  } else {
    for (const a of instances) {
      lines.push(`- ${a.id} | ${a.displayName} | ${a.type} | ${a.messageCount} messages | ${a.status}`);
    }
  }

  lines.push(
    "",
    "Spécial",
    "- browser : sous-agent codé en dur, registre d'outils privé, aucune skill, aucun MCP, invisible de list_agents",
  );
  return lines.join("\n");
}

export async function handleMcpCommand(p: IntrospectParams): Promise<string> {
  const agent = await resolveAgent(p.args, p.listSubAgents);
  if (typeof agent === "string") return agent;

  const scope = resolveAgentMcp(p.config, agent.toolType);
  const servers = p.mcpStatus();
  const inScope = servers.filter((s) => scopeAllows(scope, s.name));

  const lines = [`Serveurs MCP pour ${agent.label} — ${inScope.length} sur ${servers.length} dans le périmètre`, ""];
  if (servers.length === 0) {
    lines.push("_Aucun serveur déclaré dans config.mcp._");
  } else {
    for (const s of servers) {
      const mark = scopeAllows(scope, s.name) ? "dans le périmètre" : "hors périmètre";
      const detail = s.state === "failed" ? ` | ${s.lastError ?? "échec sans détail"}` : ` | ${plural(s.toolCount, "outil")}`;
      lines.push(`- ${s.name} | ${s.transport} | ${s.state}${detail} [${mark}]`);
    }
  }

  lines.push("", `Périmètre : ${scopeLabel(scope)}`);
  const missing = scope === "all" ? [] : scope.filter((n) => !servers.some((s) => s.name === n));
  if (missing.length > 0) lines.push(`Configuré mais non déclaré : ${missing.join(", ")}`);

  if (agent.toolType === "research" && (scope === "all" || scope.length > 0)) {
    lines.push(
      "",
      "Attention : l'agent research a des serveurs MCP. Ses outils intégrés sont en lecture seule," +
        " ceux d'un serveur MCP ne le sont pas : la garantie « research est en lecture seule » ne tient plus.",
    );
  }
  return lines.join("\n");
}

/** Markers of the layers a dump can contain, checked against the composed text rather than recomputed. */
const LAYER_MARKERS: Array<[string, string]> = [
  ["# Available skills", "catalogue de skills"],
  ["# Available tools", "liste d'outils"],
  ["Runtime: date=", "ligne runtime"],
  ["# Mid-run steering", "note de pilotage SDK"],
];

export async function handleInstructionsCommand(p: IntrospectParams): Promise<OutgoingMessage | string> {
  const agent = await resolveAgent(p.args, p.listSubAgents);
  if (typeof agent === "string") return agent;

  const skillScope = resolveAgentSkills(p.config, agent.toolType);
  const skills = p.skillRegistry.list(skillScope);
  const tools = p.toolRegistry.getForAgent(agent.toolType, p.config.tools?.disabled, resolveAgentMcp(p.config, agent.toolType));
  const model = modelFor(p.config, agent.toolType);
  const backend = backendFor(p.config, agent.toolType);
  // A cron run has no channel, so it never receives a platform hint. Borrowing the invoking
  // channel's would make the dump lie on exactly the layer a reader is checking.
  const platform = agent.toolType === "cron" ? "cron" : p.platform;

  let prompt = await buildSystemPrompt({
    platform,
    model,
    sessionId: "instructions",
    tools,
    skills,
  });
  // Shown as sent, not as built: a plugin may rewrite the prompt, and the SDK backend appends its
  // steering note after this hook.
  prompt = (await hooks.transform("transform:system:prompt", { prompt, sessionId: "instructions", model })).prompt;
  if (backend === "claude-sdk") prompt += OWNER_STEERING_NOTE;

  const present = LAYER_MARKERS.filter(([marker]) => prompt.includes(marker)).map(([, label]) => label);
  const summary = [
    `Instructions de ${agent.label} — ${prompt.length} octets`,
    `Modèle : ${model} | backend : ${backend} | plateforme : ${platform}`,
    `Skills : ${skills.length} (périmètre ${scopeLabel(skillScope)}) | outils : ${tools.length}`,
    `Couches présentes : ${present.join(", ") || "aucune"}`,
  ];
  if (agent.toolType === "cron") summary.push("Couche platform hint : absente (un run cron n'a pas de canal)");
  summary.push(
    "",
    "Non reproductible dans un dump statique :",
    "- les skills suggérées dépendent du texte du message",
    "- les AGENTS.md imbriqués sont injectés dans les résultats d'outils pendant un run, pas dans le prompt",
  );

  const dir = await mkdtemp(join(tmpdir(), "prompt-"));
  const file = join(dir, `prompt-${agent.toolType}.md`);
  await writeFile(file, prompt, "utf-8");

  return {
    text: summary.join("\n"),
    attachments: [{ type: "file", path: file, filename: `prompt-${agent.toolType}.md`, mimeType: "text/markdown" }],
  };
}
