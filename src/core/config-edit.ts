import { readFile, stat } from "node:fs/promises";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { CONFIG_PATH, type AgentConfigKey } from "./config.ts";
import { snapshot, journal, artifactId } from "./config-store.ts";

/**
 * Targeted edits to config.json from a chat command.
 *
 * Everything here re-reads the file from disk instead of serialising the live config object. The
 * in-memory config is not the file: the boot sequence merges ~28 provider-discovered models into
 * `llm.models` and injects secrets from .env over it. Writing it back would persist a cache and
 * leak credentials into a file the owner reads.
 *
 * The write goes through the same snapshot + atomic-write path as `/config rollback`, so a bad
 * change is visible in `/config diff` and undoable with `/config rollback` for free.
 */

export type ConfigEditResult =
  | { ok: true; previous: { model?: string; provider?: string } }
  | { ok: false; error: string };

const INDENT = 2;

/** Reads and parses config.json, refusing to touch a file it cannot parse. */
async function readConfigFile(): Promise<{ ok: true; data: Record<string, unknown>; mode: number } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    return { ok: false, error: `Config illisible : ${String(err)}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Overwriting here would destroy whatever the owner was mid-way through editing.
    return { ok: false, error: `Config non parsable, aucune écriture : ${String(err)}` };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Config invalide : l'objet racine attendu n'est pas un objet." };
  }
  const mode = await stat(CONFIG_PATH).then((s) => s.mode & 0o777, () => 0o600);
  return { ok: true, data: data as Record<string, unknown>, mode };
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/**
 * Pins an agent's default model in config.json.
 *
 * The provider is written alongside the model on purpose. Most models exist only in the runtime
 * catalogue, not in the file, so after a restart with the discovery endpoint down `findModel()`
 * would not resolve the id and the request would go to whatever `llm.defaultProvider` happens to
 * be -- an Anthropic model id sent to a local endpoint. Recording the provider makes the pin
 * survive a cold, offline start.
 */
/**
 * Per-agent context ceiling. `undefined` removes the key so the agent falls back on the global
 * `context.cap`, which is how a menu offers a way back to the standing policy.
 */
export async function setAgentContextCap(agent: AgentConfigKey, cap: number | undefined): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  const context = objectAt(entry, "context");
  const previous = { model: undefined, provider: undefined };

  if (cap === undefined) delete context["cap"];
  else context["cap"] = cap;
  // An emptied object left behind would read as a deliberate, meaningless setting.
  if (Object.keys(context).length === 0) delete (entry as Record<string, unknown>)["context"];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant /model ${agent} context ${cap ?? "defaut"}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, contextCap: cap ?? null });
  return { ok: true, previous };
}

/**
 * Persists the speech-to-text engine choice.
 *
 * The `voice_mode` tool only mutates the live config object, which is right for "use local just
 * for this one": it evaporates on restart. A switch the owner flips in the app means the opposite,
 * so it is written to the file. `voice` is hot-reloaded and read per call, so the next voice note
 * uses the new engine without a restart.
 */
export async function setVoiceSttMode(mode: "cloud" | "local" | "auto"): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const voice = objectAt(read.data, "voice");
  const stt = objectAt(voice, "stt");
  stt["mode"] = mode;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant bascule stt ${mode}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { voiceSttMode: mode });
  return { ok: true, previous: {} };
}

export async function setAgentModel(
  agent: AgentConfigKey,
  modelId: string,
  provider: string | undefined,
): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  const llm = objectAt(entry, "llm");

  const previous = {
    model: typeof llm["defaultModel"] === "string" ? (llm["defaultModel"] as string) : undefined,
    provider: typeof llm["defaultProvider"] === "string" ? (llm["defaultProvider"] as string) : undefined,
  };

  llm["defaultModel"] = modelId;
  if (provider) {
    llm["defaultProvider"] = provider;
  } else {
    // A model with no provider of its own follows the global default; leaving a stale provider
    // behind would pin it to the wrong endpoint.
    delete llm["defaultProvider"];
  }

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant /model ${agent} ${modelId}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, model: modelId, provider: provider ?? null });
  return { ok: true, previous };
}
