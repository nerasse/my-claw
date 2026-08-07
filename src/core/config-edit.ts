import { readFile, stat } from "node:fs/promises";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { CONFIG_PATH, type EffortLevel } from "./config.ts";
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
export async function setAgentContextCap(agent: string, cap: number | undefined): Promise<ConfigEditResult> {
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
  /** Any agent name, not just a reserved role: config is the override layer for file agents too. */
  agent: string,
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

/**
 * Pins the global default model. Same shape as `setAgentModel`, one level up: `llm.defaultModel`
 * is what every agent and session falls back to when neither has its own choice, and the legacy
 * `llm.model` key is deliberately left alone (deleting it can flip the file into the legacy
 * migration path; `defaultModel` wins over it anyway).
 */
export async function setDefaultModel(modelId: string, provider: string | undefined): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const llm = objectAt(read.data, "llm");

  const previous = {
    model: typeof llm["defaultModel"] === "string" ? (llm["defaultModel"] as string) : undefined,
    provider: typeof llm["defaultProvider"] === "string" ? (llm["defaultProvider"] as string) : undefined,
  };

  llm["defaultModel"] = modelId;
  if (provider) {
    llm["defaultProvider"] = provider;
  } else {
    // Same rule as the agent pin: a stale provider would send the model to the wrong endpoint.
    delete llm["defaultProvider"];
  }

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant défaut global ${modelId}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { defaultModel: modelId, provider: provider ?? null });
  return { ok: true, previous };
}

/**
 * Sets the global default reasoning effort, or removes the key when `undefined` so a model's own
 * level (or the provider's default) applies again.
 */
export async function setDefaultEffort(level: EffortLevel | undefined): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const llm = objectAt(read.data, "llm");

  if (level === undefined) delete llm["effort"];
  else llm["effort"] = level;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant effort global ${level ?? "défaut"}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { defaultEffort: level ?? null });
  return { ok: true, previous: {} };
}

/**
 * Removes an agent's model pin so it falls back on the inherited default again. The emptied `llm`
 * object is dropped with it, so an unpinned agent leaves no meaningless `llm: {}` behind.
 */
export async function clearAgentModel(agent: string): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = agents[agent];
  // An agent with no entry at all has no pin: nothing to remove, and nothing to create either,
  // or an unpinned agent would leave an empty `agents.<key>: {}` behind.
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: true, previous: {} };
  }
  const cast = entry as Record<string, unknown>;
  const raw = cast["llm"];
  const llm = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const previous = {
    model: typeof llm?.["defaultModel"] === "string" ? (llm["defaultModel"] as string) : undefined,
    provider: typeof llm?.["defaultProvider"] === "string" ? (llm["defaultProvider"] as string) : undefined,
  };

  if (llm) {
    delete llm["defaultModel"];
    delete llm["defaultProvider"];
    // An emptied object left behind would read as a deliberate, meaningless setting.
    if (Object.keys(llm).length === 0) delete cast["llm"];
  }
  // Same for the agent entry: `agents.<key>: {}` means nothing but looks like a setting.
  if (Object.keys(cast).length === 0) delete agents[agent];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant clear modèle ${agent}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, model: null });
  return { ok: true, previous };
}

/**
 * An agent's skills/MCP scope in config.json.
 *
 * The three values mirror the resolver's vocabulary exactly: `"inherit"` removes the key (the
 * agent follows the orchestrator's list, or everything), `"all"` writes the `["*"]` wildcard, and
 * `"list"` writes the names the user picked — `[]` is kept as a deliberate "nothing", never
 * conflated with an absent field. Names are not validated against the live catalogs on purpose:
 * the config is the truth and the app's red highlighting is what flags a name that no longer
 * exists, so saving an entry that will come back is allowed.
 */
export async function setAgentScope(
  agent: string,
  field: "skills" | "mcp",
  mode: "inherit" | "all" | "list",
  names: string[] = [],
): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  // A config entry reduced to nothing is a meaningless setting, so it is dropped with it.
  if (mode === "inherit") {
    delete entry[field];
  } else if (mode === "all") {
    entry[field] = ["*"];
  } else {
    entry[field] = [...new Set(names)].filter((n) => n.length > 0);
  }
  if (Object.keys(entry).length === 0) delete agents[agent];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant scope ${agent}.${field}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, [field]: mode });
  return { ok: true, previous: {} };
}

/**
 * Pins an agent to a workspace key, or removes the pin (`null` or `"default"`). A key that is not
 * in `config.workspaces` is refused: `resolveWorkspaceKey` throws on it at run time, so saving it
 * would only queue a failure for that agent's first run.
 */
export async function setAgentWorkspace(agent: string, workspace: string | null): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  if (workspace && workspace !== "default") {
    const workspaces = read.data["workspaces"];
    if (workspaces === null || typeof workspaces !== "object" || Array.isArray(workspaces) || !(workspace in (workspaces as Record<string, unknown>))) {
      return { ok: false, error: `Unknown workspace key: ${workspace}` };
    }
  }

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  if (!workspace || workspace === "default") delete entry["workspace"];
  else entry["workspace"] = workspace;
  if (Object.keys(entry).length === 0) delete agents[agent];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant workspace ${agent}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, workspace: workspace ?? null });
  return { ok: true, previous: {} };
}

/** Sets an agent's per-agent iteration budget, or removes it (`null`) so the default applies. */
export async function setAgentMaxIterations(agent: string, value: number | null): Promise<ConfigEditResult> {
  if (value !== null && (!Number.isInteger(value) || value <= 0)) {
    return { ok: false, error: "maxIterations must be a positive integer" };
  }
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  if (value === null) delete entry["maxIterations"];
  else entry["maxIterations"] = value;
  if (Object.keys(entry).length === 0) delete agents[agent];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant itérations ${agent}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, maxIterations: value ?? null });
  return { ok: true, previous: {} };
}

/** Adds or removes one name in the global `tools.disabled` denylist. Absent list = nothing off. */
export async function setToolDisabled(name: string, disabled: boolean): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const tools = objectAt(read.data, "tools");
  const list = Array.isArray(tools["disabled"]) ? (tools["disabled"] as unknown[]) : [];
  if (disabled) {
    if (!list.includes(name)) list.push(name);
    tools["disabled"] = list;
  } else {
    const next = list.filter((n) => n !== name);
    if (next.length > 0) tools["disabled"] = next;
    else delete tools["disabled"];
  }
  if (Object.keys(tools).length === 0) delete read.data["tools"];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant toggle tool ${name}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { tool: name, disabled });
  return { ok: true, previous: {} };
}

export interface McpAddSpec {
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Declares a new MCP server under `mcp.<name>`. The name becomes the tool namespace
 * `mcp__<name>__`, so it must be typable; the spec must match the transport. Credentials
 * (`env`, `headers`) are deliberately not in the spec: they belong to a config the app only
 * reads, never writes.
 */
export async function addMcpServer(name: string, spec: McpAddSpec): Promise<ConfigEditResult> {
  if (!MCP_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid MCP server name: "${name}" (letters, digits, "-", "_")` };
  }
  if (spec.transport === "stdio" && !spec.command?.trim()) {
    return { ok: false, error: "stdio servers need a command" };
  }
  if (spec.transport !== "stdio" && !spec.url?.trim()) {
    return { ok: false, error: `${spec.transport} servers need a url` };
  }
  const read = await readConfigFile();
  if (!read.ok) return read;

  const mcp = objectAt(read.data, "mcp");
  if (mcp[name] !== undefined) {
    return { ok: false, error: `MCP server already exists: ${name}` };
  }
  mcp[name] = {
    transport: spec.transport,
    ...(spec.command ? { command: spec.command } : {}),
    ...(spec.args && spec.args.length > 0 ? { args: spec.args } : {}),
    ...(spec.url ? { url: spec.url } : {}),
  };

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant ajout mcp ${name}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { mcpAdded: name, transport: spec.transport });
  return { ok: true, previous: {} };
}

/** Removes a declared MCP server. Agent scopes referencing it are left alone: they show up red
 *  in the app until the owner cleans them, which is exactly what the flag exists for. */
export async function removeMcpServer(name: string): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const mcp = objectAt(read.data, "mcp");
  if (mcp[name] === undefined) {
    return { ok: false, error: `MCP server not declared: ${name}` };
  }
  delete mcp[name];
  if (Object.keys(mcp).length === 0) delete read.data["mcp"];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant retrait mcp ${name}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { mcpRemoved: name });
  return { ok: true, previous: {} };
}

/** Enables or disables a declared MCP server. Enabling removes the key: absent is enabled. */
export async function setMcpEnabled(name: string, enabled: boolean): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const mcp = objectAt(read.data, "mcp");
  const server = mcp[name];
  if (server === null || typeof server !== "object" || Array.isArray(server)) {
    return { ok: false, error: `MCP server not declared: ${name}` };
  }
  const cast = server as Record<string, unknown>;
  if (enabled) delete cast["enabled"];
  else cast["enabled"] = false;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant bascule mcp ${name}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { mcpEnabled: name, enabled });
  return { ok: true, previous: {} };
}
