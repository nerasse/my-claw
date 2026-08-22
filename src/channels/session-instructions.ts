import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { composeSystemPrompt, type PromptPart } from "../agent/prompt/builder.ts";
import { OWNER_STEERING_NOTE, needsOwnerSteeringNote } from "../agent/owner-steering.ts";
import { resolveAgent as resolveAgentDefinition } from "../agents/resolve.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { resolveWorkspaceDir, resolveWorkspaceKey, type AgentToolType, type MyClawConfig } from "../core/config.ts";
import { hooks } from "../hooks/index.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import type { SessionData } from "../sessions/store.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { ToolRegistry } from "../tools/registry.ts";

/**
 * What one conversation is actually loaded with: every prompt layer as the run composes it, plus
 * the nested AGENTS.md its runs picked up along the way.
 *
 * This is `/instructions` answered per session instead of per agent type, and shaped as fields
 * rather than as one markdown dump. It shares `composeSystemPrompt` with the run, so a layer that
 * is on this page is a layer the model receives. See docs/session-instructions.md.
 */
export interface SessionInstructionLayer {
  id: PromptPart["id"];
  label: string;
  bytes: number;
  text: string;
  /** Which step of the resolution ladder produced it, for the four prompt files. */
  origin?: "own" | "inherited" | "fallback" | "off";
  /** Workspace key the content comes from, "" for a shipped template. */
  from?: string;
  /** Set when the layer is one of the prompt files, so the app can open it in the editor. */
  edit?: { workspace: string; file: string };
}

export interface SessionInstructionNested {
  /** Absolute path with symlinks resolved: the identity the collector dedups on, and how the
   *  file is addressed back for reading and editing. */
  path: string;
  /** Relative to the workspace when it sits inside it, absolute otherwise. */
  label: string;
  /** Size on disk now, which is not what was injected if the file changed since. */
  bytes: number;
  /** Number of runs of this session that injected it. */
  count: number;
  firstAt: string;
  lastAt: string;
  /** The file no longer exists: it stays listed, because it did shape this conversation. */
  missing: boolean;
  /** This session turned the file off: it is never injected now, and the page greys it. */
  disabled?: boolean;
  /** This session unloaded the record: shown as such until a tool touches the directory again. */
  unloaded?: boolean;
}

export interface SessionSkillState {
  name: string;
  description: string;
  /** True when this session filtered the skill out of its catalog. */
  off: boolean;
}

export interface SessionInstructionsReport {
  /** How the agent is named to the reader: "orchestrator", or a sub-agent's type. */
  agent: string;
  workspace: string;
  workspaceDir: string;
  model: string;
  backend: string;
  platform: string;
  /** Sum of the layers, the size of the system prompt itself. */
  totalBytes: number;
  layers: SessionInstructionLayer[];
  nested: SessionInstructionNested[];
  /** Layer ids the session turned off (agent, skills, tools, platform, runtime, suggested). */
  layersOff: string[];
  /** Skill names the session filtered out of the catalog. */
  skillsOff: string[];
  /** Every skill in scope, with the ones the session turned off flagged. Lets the page toggle more. */
  skills: SessionSkillState[];
  /** Long-term memory recall off for this session: the run skips memory injection entirely. */
  memoryRecallOff: boolean;
  /** What this page cannot show, stated rather than left to be guessed. */
  notes: string[];
}

export interface SessionInstructionsParams {
  /** Null when nothing has ever run in this thread: the layers are still the truth of what it
   *  would load, so the page is built anyway. */
  session: SessionData | null;
  sessionId: string;
  config: MyClawConfig;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  agentRegistry: AgentRegistry;
  platform: string;
}

/** A sub-agent session resolves through its type; every other thread is the orchestrator. */
function agentTypeOf(session: SessionData | null): AgentToolType {
  return session?.meta?.type ?? "main";
}

function keyForDir(config: MyClawConfig, dir: string): string {
  const target = resolve(dir);
  if (resolve(resolveWorkspaceDir(config.workspace)) === target) return "default";
  for (const [key, path] of Object.entries(config.workspaces ?? {})) {
    if (resolve(path) === target) return key;
  }
  return "";
}

export async function sessionInstructionsReport(p: SessionInstructionsParams): Promise<SessionInstructionsReport> {
  const toolType = agentTypeOf(p.session);
  const definition = resolveAgentDefinition(p.config, p.agentRegistry, toolType);
  // The agent's own pin only applies to a session that has no workspace of its own, exactly as
  // the run resolves it: the page must not claim a tree the tools will not open.
  const workspaceKey = p.session?.workspace ?? definition.workspace ?? "default";
  const workspaceDir = resolveWorkspaceKey(p.config, p.session?.workspace ?? definition.workspace);

  const run = tryResolveRunModel(
    p.config,
    {
      agent: toolType,
      ...(p.session?.modelOverride ? { sessionModel: p.session.modelOverride } : {}),
      ...(definition.fileModel ? { fileModel: definition.fileModel } : {}),
    },
    availabilityWorld(),
  );
  const model = run?.model ?? p.config.llm.defaultModel ?? p.config.llm.model ?? "";
  const backend = run?.backend ?? "openai";

  const skillsAll = p.skillRegistry.list(definition.skills, definition.workspace);
  const skillsOff = p.session?.skillsOff ?? [];
  const skillStates = skillsAll.map((s) => ({ name: s.name, description: s.description, off: skillsOff.includes(s.name) }));
  const promptSkills = skillsOff.length > 0 ? skillsAll.filter((s) => !skillsOff.includes(s.name)) : skillsAll;
  const tools = p.toolRegistry.getForAgent(definition.base, p.config.tools?.disabled, definition.mcp, definition.allow);

  const parts = await composeSystemPrompt({
    platform: p.platform,
    model,
    sessionId: p.sessionId,
    tools,
    skills: promptSkills,
    ...(definition.prompt ? { agentPrompt: definition.prompt } : {}),
    instructions: definition.instructions,
    layersOff: p.session?.promptLayersOff,
    workspaceDir,
    defaultWorkspaceDir: resolveWorkspaceDir(p.config.workspace),
    workspaceKey,
    ...(p.config.workspaces ? { workspaces: p.config.workspaces } : {}),
    ...(p.config.workspacePrompts ? { workspacePrompts: p.config.workspacePrompts } : {}),
  });

  const layers: SessionInstructionLayer[] = parts.map((part) => ({
    id: part.id,
    label: part.label,
    bytes: Buffer.byteLength(part.text, "utf-8"),
    text: part.text,
    ...(part.origin ? { origin: part.origin } : {}),
    ...(part.from !== undefined ? { from: part.from === "" ? "" : keyForDir(p.config, part.from) } : {}),
    // The editor writes into the session's own workspace, which is what "edit what this
    // conversation reads" means: an inherited layer becomes an override of the copy shown.
    ...(part.file ? { edit: { workspace: workspaceKey, file: part.file } } : {}),
  }));

  // The Claude engines append the steering note after the composition, so no file holds it and no
  // layer above carries it. It is shown for what it is: text the model receives that nothing can edit.
  if (needsOwnerSteeringNote(backend)) {
    layers.push({
      id: "runtime",
      label: "steering note",
      bytes: Buffer.byteLength(OWNER_STEERING_NOTE, "utf-8"),
      text: OWNER_STEERING_NOTE.trim(),
    });
  }

  const root = resolve(workspaceDir);
  const disabledPaths = p.session?.nestedDisabled ?? [];
  const unloadedPaths = p.session?.nestedUnloaded ?? [];
  const nested: SessionInstructionNested[] = [];
  for (const record of p.session?.nestedAgents ?? []) {
    const size = await stat(record.path).then((s) => s.size, () => -1);
    nested.push({
      path: record.path,
      label: record.path.startsWith(root + sep) ? relative(root, record.path) : record.path,
      bytes: size < 0 ? record.bytes : size,
      count: record.count,
      firstAt: record.firstAt,
      lastAt: record.lastAt,
      missing: size < 0,
      ...(disabledPaths.includes(record.path) ? { disabled: true } : {}),
    });
  }
  // The unloaded ones were purged from `nestedAgents`, so they no longer have a record: they are
  // listed as a fact until a tool touches their directory and the lazy reload brings them back.
  const known = new Set(nested.map((n) => n.path));
  for (const path of unloadedPaths) {
    if (known.has(path)) continue;
    const size = await stat(path).then((s) => s.size, () => -1);
    nested.push({
      path,
      label: path.startsWith(root + sep) ? relative(root, path) : path,
      bytes: size < 0 ? 0 : size,
      count: 0,
      firstAt: "",
      lastAt: "",
      missing: size < 0,
      unloaded: true,
      ...(disabledPaths.includes(path) ? { disabled: true } : {}),
    });
  }
  nested.sort((a, b) => a.label.localeCompare(b.label));

  // A plugin may rewrite the whole prompt after composition. Rendering the result as a layer would
  // double the payload for a case that is normally empty, so it is reported as a fact instead.
  const composed = layers.map((l) => l.text).filter(Boolean).join("\n\n");
  const transformed = (await hooks.transform("transform:system:prompt", { prompt: composed, sessionId: p.sessionId, model })).prompt;

  const notes = [
    "Les skills suggérées dépendent du texte du message : la couche n'apparaît que sur un run réel.",
    "Les souvenirs rappelés sont injectés dans le message, pas dans le prompt système.",
    "Un AGENTS.md imbriqué est injecté dans un résultat d'outil quand un outil touche son répertoire, une fois par run.",
  ];
  if (transformed !== composed) {
    notes.unshift(
      `Un hook réécrit le prompt avant l'envoi (${Buffer.byteLength(transformed, "utf-8")} octets contre ${Buffer.byteLength(composed, "utf-8")}) : les couches ci-dessous sont la composition, pas l'envoi final.`,
    );
  }

  return {
    agent: toolType === "main" ? "orchestrator" : toolType,
    workspace: workspaceKey,
    workspaceDir,
    model,
    backend,
    platform: p.platform,
    totalBytes: layers.reduce((sum, l) => sum + l.bytes, 0),
    layers,
    nested,
    layersOff: p.session?.promptLayersOff ?? [],
    skillsOff,
    skills: skillStates,
    memoryRecallOff: p.session?.memoryRecallOff ?? false,
    notes,
  };
}
