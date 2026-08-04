import type { AgentToolType, MyClawConfig } from "../core/config.ts";
import { agentConfigKey, resolveAgentLlm } from "../core/config.ts";
import { resolveAgentLlmConfig } from "../llm/resolver.ts";
import { setAgentContextCap, setAgentModel } from "../core/config-edit.ts";
import type { ModelPicker, PickerTarget } from "./model-picker.ts";
import type { SubAgentInfo } from "../subagents/types.ts";
import { log } from "../utils/logger.ts";

/**
 * `/model <agent> [<model>]` — the persisted, per-agent half of `/model`.
 *
 * Plain `/model <model>` stays what it was: an override for the current chat only. Naming an agent
 * instead writes that agent's default into config.json, which is why the two live in one command
 * and are told apart by whether the first word is an agent name. See docs/agent-model.md.
 */

/** The tool-axis type an agent target resolves to, for reading its currently effective model. */
export const TOOL_TYPE: Record<PickerTarget, AgentToolType> = {
  orchestrator: "main",
  general: "general",
  research: "research",
  cron: "cron",
};

const ALIASES: Record<string, PickerTarget> = {
  main: "orchestrator",
  orchestrator: "orchestrator",
  general: "general",
  research: "research",
  cron: "cron",
};

export const AGENT_TARGET_HELP = "orchestrator (ou main), general, research, cron, ou un id de sous-agent";

/**
 * Strips one matching pair of quotes. No general-purpose tokeniser exists in this codebase and one
 * command does not justify inventing it; the quotes are accepted because an agent name reads like
 * something you would quote, not because any agent name contains a space.
 */
function unquote(token: string): string {
  const m = /^(["'])(.*)\1$/.exec(token);
  return m ? m[2] ?? "" : token;
}

/** Splits `args` into the first token and the untouched remainder, both unquoted. */
function splitFirst(args: string): { first: string; rest: string } {
  const trimmed = args.trim();
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return { first: "", rest: "" };
  return { first: unquote(match[1] ?? ""), rest: unquote((match[2] ?? "").trim()) };
}

/**
 * An agent name, or null when the word is not one. A live sub-agent resolves to its *type*: the
 * config has no per-instance section, and an instance is a session that will be gone tomorrow.
 * This matches how `/skills` and `/mcp` already treat an instance name.
 */
export async function resolveAgentTarget(
  token: string,
  listSubAgents: () => Promise<SubAgentInfo[]>,
): Promise<PickerTarget | null> {
  const lower = token.toLowerCase();
  if (!lower) return null;
  const direct = ALIASES[lower];
  if (direct) return direct;

  const instances = await listSubAgents().catch(() => [] as SubAgentInfo[]);
  const found = instances.find((a) => a.id === token || a.id.toLowerCase() === lower || a.displayName.toLowerCase() === lower);
  if (!found) return null;
  return found.type === "research" ? "research" : "general";
}

/** The model an agent resolves to right now, config defaults included. */
export function currentAgentModel(config: MyClawConfig, target: PickerTarget): string {
  try {
    return resolveAgentLlmConfig(resolveAgentLlm(config, TOOL_TYPE[target]), config.llm).model || "";
  } catch {
    return "";
  }
}

export type AgentModelOutcome =
  /** The first word is not an agent: the caller must fall through to the session behaviour. */
  | { kind: "not-an-agent" }
  | { kind: "message"; text: string }
  | { kind: "menu"; target: PickerTarget; currentModel: string; heading: string };

export interface AgentModelDeps {
  config: MyClawConfig;
  modelPicker: ModelPicker;
  listSubAgents: () => Promise<SubAgentInfo[]>;
  /** Applied after the write so the reply describes the running config, not the intended one. */
  reloadConfigNow?: () => Promise<unknown>;
  /** Config edits are owner business and the reply names a persisted default, so DM only. */
  isDm: boolean;
}

export const AGENT_MODEL_DM_ONLY = "Régler le modèle d'un agent n'est possible qu'en message privé avec le bot.";

/** Writes the pin and reports what actually changed. Shared by both channels' menu callbacks. */
export async function applyAgentModel(
  target: PickerTarget,
  modelId: string,
  deps: Pick<AgentModelDeps, "config" | "modelPicker" | "reloadConfigNow">,
): Promise<string> {
  const key = agentConfigKey(TOOL_TYPE[target]);
  // Taken from the runtime list, which includes discovered models absent from the file.
  const provider = deps.modelPicker.providerFor(modelId);
  const result = await setAgentModel(key, modelId, provider);
  if (!result.ok) return `Échec de l'écriture : ${result.error}`;

  await deps.reloadConfigNow?.().catch((err) => {
    void log("warn", "config reload after /model agent failed", { agent: key, error: String(err) });
  });

  const label = deps.modelPicker.labelFor(modelId);
  const before = result.previous.model ? deps.modelPicker.labelFor(result.previous.model) : "défaut global";
  const providerNote = provider ? ` (provider ${provider})` : "";
  return [
    `Agent ${key} : ${before} -> ${label}${providerNote}`,
    "Enregistré dans config.json. `/config diff config` pour voir l'écriture, `/config rollback` pour l'annuler.",
    target === "orchestrator"
      ? "Le `/model` d'une conversation reste prioritaire sur ce défaut."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Entry point for `/model <args>`. Returns `not-an-agent` for everything that is not an agent name,
 * leaving `/model <model>` untouched.
 */
/**
 * Per-agent context ceiling from the picker. `"full"` writes `0`, which is how the config spells
 * "no ceiling for this agent"; a number is written as-is so it can also sit below the global cap.
 */
export async function applyAgentContext(
  target: PickerTarget,
  choice: import("../llm/context-window.ts").ContextOverride,
  deps: Pick<AgentModelDeps, "config" | "reloadConfigNow">,
): Promise<string> {
  const key = agentConfigKey(TOOL_TYPE[target]);
  const cap = choice === "full" ? 0 : choice;
  const result = await setAgentContextCap(key, cap);
  if (!result.ok) return `Échec de l'écriture : ${result.error}`;

  await deps.reloadConfigNow?.().catch((err) => {
    void log("warn", "config reload after /model agent context failed", { agent: key, error: String(err) });
  });
  return choice === "full"
    ? `Fenêtre de contexte de l'agent ${target} : complète, sans plafond`
    : `Fenêtre de contexte de l'agent ${target} : ${choice.toLocaleString("en-US")} tokens`;
}

export async function handleAgentModelCommand(args: string, deps: AgentModelDeps): Promise<AgentModelOutcome> {
  const { first, rest } = splitFirst(args);
  if (!first) return { kind: "not-an-agent" };

  const target = await resolveAgentTarget(first, deps.listSubAgents);
  if (!target) return { kind: "not-an-agent" };

  if (!deps.isDm) return { kind: "message", text: AGENT_MODEL_DM_ONLY };

  const currentModel = currentAgentModel(deps.config, target);
  const key = agentConfigKey(TOOL_TYPE[target]);

  if (!rest) {
    if (!deps.modelPicker.hasModels()) {
      return { kind: "message", text: `Agent ${key} : ${deps.modelPicker.labelFor(currentModel)} (aucun modèle configuré à proposer)` };
    }
    return {
      kind: "menu",
      target,
      currentModel,
      heading: `Modèle par défaut de l'agent ${key}`,
    };
  }

  const match = deps.modelPicker.find(rest);
  if (!match) {
    return { kind: "message", text: `Modèle inconnu : ${rest}\n\`/models\` liste les modèles configurés.` };
  }
  return { kind: "message", text: await applyAgentModel(target, match.id, deps) };
}
