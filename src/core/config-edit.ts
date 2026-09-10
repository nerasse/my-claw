import { readFile, stat, mkdir } from "node:fs/promises";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { CONFIG_PATH, tagNameOf, type EffortLevel, type TagRouteCandidate } from "./config.ts";
import { PROMPT_FILES } from "../agent/prompt/files.ts";
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
  | { ok: true; previous: { model?: string; provider?: string; effort?: EffortLevel; fallback?: string } }
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
 * Per-agent effort pin, written without touching the model: `agents.<agent>.llm.effort`.
 * `"clear"` removes it so the agent falls back on the global default. An emptied `llm` or
 * agent entry is dropped, exactly like `clearAgentModel` does.
 */
export async function setAgentEffort(agent: string, effort: EffortLevel | "clear"): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  const llm = objectAt(entry, "llm");
  const previous = {
    effort: typeof llm["effort"] === "string" ? (llm["effort"] as EffortLevel) : undefined,
  };

  if (effort === "clear") delete llm["effort"];
  else llm["effort"] = effort;
  // An emptied object left behind would read as a deliberate, meaningless setting.
  if (Object.keys(llm).length === 0) delete entry["llm"];
  if (Object.keys(entry).length === 0) delete agents[agent];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant effort agent ${agent} ${effort === "clear" ? "défaut" : effort}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, effort: effort === "clear" ? null : effort });
  return { ok: true, previous };
}

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
 * Creates or replaces a tag route that configs reference as `tag:<name>` (docs/tags.md). The
 * reserved name `Default` is virtual and must not be written. New routes contain concrete models
 * only; an emptied tags section is removed so the file does not carry a meaningless setting.
 */
export async function setTag(
  name: string,
  value: {
    model?: string;
    effort?: string;
    contextCap?: number;
    route?: TagRouteCandidate[];
    fallbackToGlobalDefault?: boolean;
  },
): Promise<ConfigEditResult> {
  if (name === "Default") return { ok: false, error: "Le nom de tag « Default » est réservé." };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const route = value.route ?? (value.model ? [{ model: value.model, ...(value.effort ? { effort: value.effort as EffortLevel } : {}), ...(value.contextCap !== undefined ? { contextCap: value.contextCap } : {}) }] : []);
  if (
    route.length === 0 ||
    (value.route && route.some((candidate) => !candidate.model || tagNameOf(candidate.model) !== undefined)) ||
    route.some((candidate) => candidate.contextCap !== undefined && (!Number.isFinite(candidate.contextCap) || candidate.contextCap <= 0))
  ) {
    return { ok: false, error: "Une route doit contenir au moins un modèle concret, sans tag imbriqué, avec des caps positifs." };
  }
  if (!value.route && value.model && tagReferenceWouldCycle(read.data, name, value.model)) {
    return { ok: false, error: `Le modèle « ${value.model} » refermerait une boucle de tags (le résolveur ne peut pas l'étendre).` };
  }

  const tags = objectAt(read.data, "tags");
  tags[name] = value.route
    ? { route, ...(value.fallbackToGlobalDefault ? { fallbackToGlobalDefault: true } : {}) }
    : { model: route[0]!.model, ...(route[0]!.effort ? { effort: route[0]!.effort } : {}), ...(route[0]!.contextCap !== undefined ? { contextCap: route[0]!.contextCap } : {}) };

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant tag ${name}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { tag: name, model: value.model });
  return { ok: true, previous: { model: value.model } };
}

/** Whether `name -> model` would close a tag reference loop in the config on disk. */
function tagReferenceWouldCycle(data: Record<string, unknown>, name: string, model: string): boolean {
  const seen = new Set<string>([name]);
  const tags = (data.tags as Record<string, { model?: string }> | undefined) ?? {};
  const llm = data.llm as Record<string, unknown> | undefined;
  let current = model;
  while (true) {
    const ref = tagNameOf(current);
    if (ref === undefined) return false;
    if (seen.has(ref)) return true;
    seen.add(ref);
    // Missing references are valid at runtime: they follow the virtual Default tag. The cycle
    // check must follow the same edge, or deleting a tag could turn an otherwise valid update
    // into a Default -> missing -> Default loop that only fails on the first run.
    const defaultModel = (llm?.defaultModel ?? llm?.model) as string | undefined;
    const next = ref === "Default" ? defaultModel : tags[ref]?.model ?? defaultModel;
    if (!next) return false;
    current = next;
  }
}

export async function deleteTag(name: string): Promise<ConfigEditResult> {
  if (name === "Default") return { ok: false, error: "Le nom de tag « Default » est réservé." };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const tags = objectAt(read.data, "tags");
  delete tags[name];
  if (Object.keys(tags).length === 0) delete (read.data as Record<string, unknown>)["tags"];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant suppression tag ${name}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { tag: name, removed: true });
  return { ok: true, previous: { model: undefined } };
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

/**
 * Persists the app UI preferences (tool/reasoning auto-expand). Same philosophy as
 * `setVoiceSttMode`: a toggle in the app is a durable choice, so it goes to the file and is
 * hot-reloaded. `uiPrefs` is read per frame, so the next render of a card honours the new value
 * without a restart.
 */
export async function setUiPrefs(prefs: { expandTools?: boolean; expandReasoning?: boolean }): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const uiPrefs = objectAt(read.data, "uiPrefs");
  const patch: Record<string, unknown> = {};
  if (typeof prefs.expandTools === "boolean") { uiPrefs["expandTools"] = prefs.expandTools; patch.expandTools = prefs.expandTools; }
  if (typeof prefs.expandReasoning === "boolean") { uiPrefs["expandReasoning"] = prefs.expandReasoning; patch.expandReasoning = prefs.expandReasoning; }

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant uiPrefs ${JSON.stringify(patch)}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { uiPrefs: patch });
  return { ok: true, previous: {} };
}

export async function setAgentModel(
  /** Any agent name, not just a reserved role: config is the override layer for file agents too. */
  agent: string,
  modelId: string,
  provider: string | undefined,
  /**
   * The effort written in the same pass as the model, because the two are picked together.
   * `"clear"` removes the pin; `undefined` leaves whatever the agent already had.
   */
  effort?: EffortLevel | "clear",
): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const agents = objectAt(read.data, "agents");
  const entry = objectAt(agents, agent);
  const llm = objectAt(entry, "llm");

  const previous = {
    model: typeof llm["defaultModel"] === "string" ? (llm["defaultModel"] as string) : undefined,
    provider: typeof llm["defaultProvider"] === "string" ? (llm["defaultProvider"] as string) : undefined,
    effort: typeof llm["effort"] === "string" ? (llm["effort"] as EffortLevel) : undefined,
  };

  llm["defaultModel"] = modelId;
  if (provider) {
    llm["defaultProvider"] = provider;
  } else {
    // A model with no provider of its own follows the global default; leaving a stale provider
    // behind would pin it to the wrong endpoint.
    delete llm["defaultProvider"];
  }
  if (effort === "clear") delete llm["effort"];
  else if (effort !== undefined) llm["effort"] = effort;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant /model ${agent} ${modelId}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { agent, model: modelId, provider: provider ?? null, effort: effort === "clear" ? null : (effort ?? null) });
  return { ok: true, previous };
}

/**
 * Pins the global default model. Same shape as `setAgentModel`, one level up: `llm.defaultModel`
 * is what every agent and session falls back to when neither has its own choice, and the legacy
 * `llm.model` key is deliberately left alone (deleting it can flip the file into the legacy
 * migration path; `defaultModel` wins over it anyway).
 */
export async function setDefaultModel(
  modelId: string,
  provider: string | undefined,
  effort?: EffortLevel | "clear",
): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const llm = objectAt(read.data, "llm");

  const previous = {
    model: typeof llm["defaultModel"] === "string" ? (llm["defaultModel"] as string) : undefined,
    provider: typeof llm["defaultProvider"] === "string" ? (llm["defaultProvider"] as string) : undefined,
    effort: typeof llm["effort"] === "string" ? (llm["effort"] as EffortLevel) : undefined,
  };

  llm["defaultModel"] = modelId;
  if (provider) {
    llm["defaultProvider"] = provider;
  } else {
    // Same rule as the agent pin: a stale provider would send the model to the wrong endpoint.
    delete llm["defaultProvider"];
  }
  if (effort === "clear") delete llm["effort"];
  else if (effort !== undefined) llm["effort"] = effort;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant défaut global ${modelId}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { defaultModel: modelId, provider: provider ?? null, effort: effort === "clear" ? null : (effort ?? null) });
  return { ok: true, previous };
}

/**
 * Pins the vision fallback model: image runs are rerouted to it when the resolved model cannot
 * take images (llm.visionFallback). `""` removes the pin, which sends image runs back to the
 * resolved model. Validation that the target is a declared, vision-capable model happens at the
 * call site, mirroring the run-time guard in the resolver.
 */
export async function setVisionFallback(modelId: string): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const llm = objectAt(read.data, "llm");
  const previous = {
    fallback: typeof llm["visionFallback"] === "string" ? (llm["visionFallback"] as string) : undefined,
  };

  if (modelId === "") delete llm["visionFallback"];
  else llm["visionFallback"] = modelId;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant fallback image ${modelId || "aucun"}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { visionFallback: modelId === "" ? null : modelId });
  return { ok: true, previous };
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
    effort: typeof llm?.["effort"] === "string" ? (llm["effort"] as EffortLevel) : undefined,
  };

  if (llm) {
    delete llm["defaultModel"];
    delete llm["defaultProvider"];
    // The effort is the model's sibling: a cleared model pin must not leave an orphaned effort
    // behind, or the agent would silently keep the effort of a model it no longer runs.
    delete llm["effort"];
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
 * in `config.workspaces` is refused: resolution falls back to the default workspace for a removed
 * key, so saving a pin that does not exist would silently point the agent at the wrong directory
 * without any error to explain it.
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

const WORKSPACE_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

function workspaceErrorOf(key: string, path: string | undefined): string | null {
  if (key === "default" || !WORKSPACE_KEY_RE.test(key)) {
    return `Invalid workspace key: "${key}" (the key "default" is reserved; letters, digits, "-", "_")`;
  }
  if (key === "builtin" || key === "none") {
    // A prompt source keyword is not a legal workspace: `inherit: "none"` in a policy would read
    // this workspace's files instead of nothing. A config that already declares such a key keeps
    // working (a declared key wins over the keyword), it just cannot be created here any more.
    return `Invalid workspace key: "${key}" (reserved: it names a prompt source, not a workspace)`;
  }
  if (path !== undefined && !path.startsWith("/")) {
    return `Invalid workspace path: "${path}" (must be absolute)`;
  }
  return null;
}

/**
 * Declares a new workspace in `config.workspaces`. The key is what agents and cron reference;
 * the path is the only thing the key stands for. The directory is created so the skills and
 * agents watchers can open their tiers under it, exactly as boot does for the named workspaces.
 */
export async function addWorkspace(key: string, path: string): Promise<ConfigEditResult> {
  const invalid = workspaceErrorOf(key, path);
  if (invalid) return { ok: false, error: invalid };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const workspaces = objectAt(read.data, "workspaces");
  if (workspaces[key] !== undefined) {
    return { ok: false, error: `Workspace already exists: ${key}` };
  }
  workspaces[key] = path;
  await mkdir(path, { recursive: true });

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant ajout workspace ${key}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { workspaceAdded: key, path });
  return { ok: true, previous: {} };
}

/** Removes a named workspace. Agent pins and file fields pointing at it stay: they are exactly
 *  what the app's red highlight exists to surface, so they are flagged rather than silently
 *  rewritten. */
export async function removeWorkspace(key: string): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const workspaces = read.data["workspaces"];
  if (workspaces === null || typeof workspaces !== "object" || Array.isArray(workspaces) || (workspaces as Record<string, unknown>)[key] === undefined) {
    return { ok: false, error: `Workspace not declared: ${key}` };
  }
  delete (workspaces as Record<string, unknown>)[key];
  if (Object.keys(workspaces as Record<string, unknown>).length === 0) delete read.data["workspaces"];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant retrait workspace ${key}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { workspaceRemoved: key });
  return { ok: true, previous: {} };
}

/**
 * Renames a workspace key, same path. Every `agents.<key>.workspace` pin that referenced the old
 * name is rewritten to the new one in the same write: a rename that silently broke the agents it
 * scopes would be a trap nobody asked for. Agent *files* with a `workspace:` field are not
 * touched -- they live outside config.json and surface through the red flag instead.
 */
export async function renameWorkspace(from: string, to: string): Promise<ConfigEditResult> {
  const invalid = workspaceErrorOf(to, undefined);
  if (invalid) return { ok: false, error: invalid };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const workspaces = read.data["workspaces"];
  if (workspaces === null || typeof workspaces !== "object" || Array.isArray(workspaces) || (workspaces as Record<string, unknown>)[from] === undefined) {
    return { ok: false, error: `Workspace not declared: ${from}` };
  }
  if ((workspaces as Record<string, unknown>)[to] !== undefined) {
    return { ok: false, error: `Workspace already exists: ${to}` };
  }
  (workspaces as Record<string, unknown>)[to] = (workspaces as Record<string, unknown>)[from];
  delete (workspaces as Record<string, unknown>)[from];

  const agents = read.data["agents"];
  if (agents !== null && typeof agents === "object" && !Array.isArray(agents)) {
    for (const entry of Object.values(agents as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const cast = entry as Record<string, unknown>;
      if (cast["workspace"] === from) cast["workspace"] = to;
    }
  }

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant renommage workspace ${from}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { workspaceRenamed: { from, to } });
  return { ok: true, previous: {} };
}

/** Repoints a workspace key at a different directory. Same validation as the boot path check. */
export async function setWorkspacePath(key: string, path: string): Promise<ConfigEditResult> {
  const invalid = workspaceErrorOf(key, path);
  if (invalid) return { ok: false, error: invalid };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const workspaces = read.data["workspaces"];
  if (workspaces === null || typeof workspaces !== "object" || Array.isArray(workspaces) || (workspaces as Record<string, unknown>)[key] === undefined) {
    return { ok: false, error: `Workspace not declared: ${key}` };
  }
  (workspaces as Record<string, unknown>)[key] = path;
  await mkdir(path, { recursive: true });

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant changement de chemin ${key}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { workspacePath: { key, path } });
  return { ok: true, previous: {} };
}

/**
 * Sets the per-file prompt policy of one workspace (config.workspacePrompts). Absent fields are
 * left untouched; an explicit "default" inherit and a false off are the no-op values, so the
 * field is dropped rather than stored, and an entry left empty is removed entirely -- a policy
 * that says nothing should not stay in the file. See docs/workspace-prompt-inheritance.md.
 */
export async function setWorkspacePromptPolicy(
  workspace: string,
  file: string,
  inherit: string | undefined,
  off: boolean | undefined,
): Promise<ConfigEditResult> {
  if (!(PROMPT_FILES as readonly string[]).includes(file)) {
    return { ok: false, error: `unknown prompt file: ${file}` };
  }
  const read = await readConfigFile();
  if (!read.ok) return read;

  const workspaces = read.data["workspaces"];
  if (workspace !== "default" && !(workspaces && typeof workspaces === "object" && workspace in (workspaces as Record<string, unknown>))) {
    return { ok: false, error: `unknown workspace: ${workspace}` };
  }

  const section = objectAt(read.data, "workspacePrompts");
  const entry: Record<string, unknown> = {};
  if (inherit !== undefined && inherit !== "default") entry.inherit = inherit;
  if (off !== undefined && off !== false) entry.off = off;
  const workspacePolicy = objectAt(section, workspace);
  if (Object.keys(entry).length > 0) {
    workspacePolicy[file] = entry;
  } else {
    delete workspacePolicy[file];
  }
  // A policy that says nothing is not a policy: drop the empty containers.
  if (Object.keys(workspacePolicy).length === 0) delete section[workspace];
  if (Object.keys(section).length === 0) delete read.data["workspacePrompts"];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant politique prompt ${workspace}/${file}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { workspace, file, inherit, off });
  return { ok: true, previous: {} };
}

/** The provider key is the model namespace (`llm.providers.<key>`), so it must be typable. */
export const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The fields the app may write. Optional strings are deleted when they arrive empty: the file
 * must not carry settings that say nothing. `headers` and `apiKeyEnv` values are not here --
 * headers stay owner-only, and the env key has its own page (providers.env.*).
 */
export interface ProviderPatch {
  type?: "openai" | "codex" | "anthropic";
  baseUrl?: string;
  apiKeyEnv?: string;
  group?: string;
  discover?: boolean;
  promptCache?: boolean;
  reasoningReplay?: boolean;
  pricingProvider?: string;
  fallbackModel?: string;
}

const PROVIDER_TYPES = ["openai", "codex", "anthropic"] as const;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A type's shape, checked against the *resulting* entry so a patch that flips the type is
 * validated the same way as one that builds it. SDK types hold no endpoint and no key of their
 * own: the Claude SDK and Codex backends own their token stores and their targets.
 */
function providerShapeError(spec: Record<string, unknown>): string | null {
  const type = spec["type"] ?? "openai";
  if (spec["baseUrl"] && type !== "openai") {
    return `${type} providers do not take a baseUrl (the backend owns its targets)`;
  }
  if (spec["apiKeyEnv"] && type !== "openai") {
    return `${type} providers do not take an apiKeyEnv (subscription auth)`;
  }
  if (type === "openai" && !spec["baseUrl"]) {
    return "openai providers need a baseUrl";
  }
  return null;
}

function providersAt(data: Record<string, unknown>): Record<string, unknown> {
  return objectAt(objectAt(data, "llm"), "providers");
}

/**
 * Creates or edits one provider in one validation pass, exactly what the wire frame `providers.upsert`
 * means: a key that is already declared is merged field by field, a new one is created. The key
 * "tags" is reserved: it is the synthetic row the server injects into the providers listing, it
 * has no config entry of its own. Empty optional strings delete the field: the file must not
 * carry settings that say nothing.
 */
export async function upsertProvider(key: string, patch: ProviderPatch): Promise<ConfigEditResult> {
  if (!PROVIDER_KEY_RE.test(key)) {
    return { ok: false, error: `Invalid provider key: "${key}" (letters, digits, "-", "_")` };
  }
  if (key === "tags") return { ok: false, error: `The provider key "${key}" is reserved` };
  if (patch.type !== undefined && !(PROVIDER_TYPES as readonly string[]).includes(patch.type)) {
    return { ok: false, error: `Invalid provider type: ${patch.type}` };
  }
  if (patch.apiKeyEnv !== undefined && patch.apiKeyEnv !== "" && !ENV_NAME_RE.test(patch.apiKeyEnv)) {
    return { ok: false, error: `Invalid environment variable name: ${patch.apiKeyEnv}` };
  }
  const read = await readConfigFile();
  if (!read.ok) return read;

  const providers = providersAt(read.data);
  const existing = providers[key];
  const created = existing === undefined;
  const spec: Record<string, unknown> =
    existing === null || typeof existing !== "object" || Array.isArray(existing)
      ? { type: patch.type ?? "openai" }
      : { ...(existing as Record<string, unknown>) };
  if (patch.type !== undefined) spec["type"] = patch.type;
  for (const field of ["baseUrl", "apiKeyEnv", "group", "pricingProvider", "fallbackModel"] as const) {
    if (patch[field] === undefined) continue;
    if (patch[field] === "") delete spec[field];
    else spec[field] = patch[field];
  }
  if (patch.discover !== undefined) spec["discover"] = patch.discover;
  if (patch.promptCache !== undefined) spec["promptCache"] = patch.promptCache;
  if (patch.reasoningReplay !== undefined) spec["reasoningReplay"] = patch.reasoningReplay;
  const shapeError = providerShapeError(spec);
  if (shapeError) return { ok: false, error: shapeError };
  providers[key] = spec;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant ${created ? "ajout" : "édition"} provider ${key}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { providerUpserted: key, created });
  return { ok: true, previous: {} };
}

/**
 * Repoints every provider that reads `from` at `to`, in one write: an env rename whose variable
 * is shared by two providers must not leave one of them dangling after the .env line moves.
 */
export async function repointEnvKey(from: string, to: string): Promise<ConfigEditResult> {
  if (!ENV_NAME_RE.test(to)) {
    return { ok: false, error: `Invalid environment variable name: ${to}` };
  }
  if (from === to) return { ok: true, previous: {} };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const providers = providersAt(read.data);
  let touched = 0;
  for (const [key, entry] of Object.entries(providers)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const cast = entry as Record<string, unknown>;
    if (cast["apiKeyEnv"] === from) {
      cast["apiKeyEnv"] = to;
      touched += 1;
    }
  }
  if (touched === 0) return { ok: true, previous: {} };

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant repointage ${from} -> ${to}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { envRepointed: { from, to, touched } });
  return { ok: true, previous: {} };
}

/**
 * Removes a declared provider. Anything that still points at it is refused with the list:
 * a silent removal would leave a default that resolves nowhere and curated models that never
 * run. Discovered models are not in the file and die with the catalog cache; curated ones
 * (llm.models) are the owner's declaration and are never touched behind their back.
 */
export interface RemoveProviderOptions {
  /**
   * Drop what points at the entry instead of refusing: the curated models declared under it, and
   * the default-provider role when it holds it. The refusal alone was a dead end -- the app offers
   * the delete, the server always says no, and hand-editing the file left the declarations behind,
   * pointing at a provider that no longer exists.
   */
  withModels?: boolean;
}

export async function removeProvider(key: string, options: RemoveProviderOptions = {}): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;
  const providers = providersAt(read.data);
  if (providers[key] === undefined) {
    return { ok: false, error: `Provider not declared: ${key}` };
  }

  const llm = objectAt(read.data, "llm");
  const blocking: string[] = [];
  if (llm["defaultProvider"] === key) blocking.push(`llm.defaultProvider`);
  const models = llm["models"];
  const entries: unknown[] = Array.isArray(models) ? models : [];
  const declared: Record<string, unknown>[] = [];
  if (entries.length > 0) {
    for (const model of entries) {
      if (model && typeof model === "object" && (model as Record<string, unknown>)["provider"] === key) {
        declared.push(model as Record<string, unknown>);
      }
    }
  }
  for (const model of declared) {
    const id = model["id"];
    blocking.push(`curated model ${typeof id === "string" ? id : "(unnamed)"}`);
  }
  if (blocking.length > 0 && options.withModels !== true) {
    return { ok: false, error: `Cannot remove ${key}: still referenced by ${blocking.join(", ")}` };
  }

  if (options.withModels === true) {
    if (declared.length > 0) {
      llm["models"] = entries.filter((model) => !declared.includes(model as Record<string, unknown>));
    }
    if (llm["defaultProvider"] === key) delete llm["defaultProvider"];
  }
  delete providers[key];
  if (Object.keys(providers).length === 0) delete llm["providers"];
  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant retrait provider ${key}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { providerRemoved: key, withModels: options.withModels === true });
  return { ok: true, previous: {} };
}

/**
 * Renames a provider key, same entry. Every reference in the same file follows in one write --
 * curated models and the default provider -- so the rename never leaves a dangling default,
 * exactly like `renameWorkspace` rewrites the agent pins it would otherwise break.
 */
export async function renameProvider(from: string, to: string): Promise<ConfigEditResult> {
  if (!PROVIDER_KEY_RE.test(to)) {
    return { ok: false, error: `Invalid provider key: "${to}" (letters, digits, "-", "_")` };
  }
  if (to === "tags") return { ok: false, error: `The provider key "${to}" is reserved` };
  const read = await readConfigFile();
  if (!read.ok) return read;

  const providers = providersAt(read.data);
  if (providers[from] === undefined) {
    return { ok: false, error: `Provider not declared: ${from}` };
  }
  if (providers[to] !== undefined) {
    return { ok: false, error: `Provider already exists: ${to}` };
  }
  providers[to] = providers[from];
  delete providers[from];

  const llm = objectAt(read.data, "llm");
  if (llm["defaultProvider"] === from) llm["defaultProvider"] = to;
  const models = llm["models"];
  if (Array.isArray(models)) {
    for (const model of models) {
      if (model && typeof model === "object" && (model as Record<string, unknown>)["provider"] === from) {
        (model as Record<string, unknown>)["provider"] = to;
      }
    }
  }

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant renommage provider ${from}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { providerRenamed: { from, to } });
  return { ok: true, previous: {} };
}

/** Everything a declared model may carry. `id` names it; every other field is an override. */
export interface ModelDeclaration {
  id: string;
  label?: string;
  apiId?: string;
  provider?: string;
  group?: string;
  family?: string;
  vision?: boolean;
  limit?: { context?: number; output?: number };
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  thinkingTypes?: { adaptive: boolean; enabled: boolean };
  /** Milliseconds allowed with no byte back. `0` disarms the timer -- docs/llm-timeout.md. */
  timeoutMs?: number;
}

/** `@` is the endpoint separator of the reference grammar, so an id may not contain one. */
const MODEL_ID_RE = /^[^\s@]+$/;
const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

function positiveInt(value: number | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) return `${field} must be a positive integer, got ${value}`;
  return null;
}

/**
 * Same check, with zero allowed, because on a timeout `0` is a decision and not an empty field: it
 * means "no wall of ours, Stop is the only one" (docs/llm-timeout.md). Reusing `positiveInt` here
 * would refuse the one value the feature exists to express.
 */
function nonNegativeInt(value: number | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) return `${field} must be zero or a positive integer, got ${value}`;
  return null;
}

/**
 * Everything refused before the file is touched. See docs/model-declarations.md for the table.
 *
 * The provider check has teeth beyond a typo: `parseModelRef` reads the head of a qualified id as
 * the provider whenever a provider by that name exists, so `litellm/foo` declared on `groq` sends
 * every request to litellm and nothing in the config says so.
 */
function modelDeclarationError(entry: ModelDeclaration, providers: Record<string, unknown>): string | null {
  if (!entry.id || !MODEL_ID_RE.test(entry.id)) {
    return `Invalid model id: "${entry.id}" (no whitespace, no "@")`;
  }
  if (tagNameOf(entry.id) !== undefined) return `The prefix "tag:" is reserved for tag references`;
  if (entry.provider !== undefined && entry.provider !== "" && providers[entry.provider] === undefined) {
    return `Provider not declared: ${entry.provider}`;
  }
  const head = entry.id.includes("/") ? entry.id.slice(0, entry.id.indexOf("/")) : undefined;
  if (head !== undefined && providers[head] !== undefined && entry.provider !== undefined && entry.provider !== head) {
    return `The id is qualified with "${head}", so it cannot be declared on "${entry.provider}"`;
  }
  if (entry.apiId !== undefined && entry.apiId !== "" && !MODEL_ID_RE.test(entry.apiId)) {
    return `Invalid apiId: "${entry.apiId}" (no whitespace, no "@")`;
  }
  const windowError = positiveInt(entry.limit?.context, "limit.context") ?? positiveInt(entry.limit?.output, "limit.output");
  if (windowError) return windowError;
  const timeoutError = nonNegativeInt(entry.timeoutMs, "timeoutMs");
  if (timeoutError) return timeoutError;
  const unknown = (entry.supportedEffortLevels ?? []).find((level) => !(EFFORT_LEVELS as readonly string[]).includes(level));
  if (unknown) return `Unknown effort level: ${unknown}`;
  if (entry.thinkingTypes !== undefined) {
    const { adaptive, enabled } = entry.thinkingTypes;
    if (typeof adaptive !== "boolean" || typeof enabled !== "boolean") {
      return "thinkingTypes needs both adaptive and enabled";
    }
  }
  return null;
}

function modelsAt(data: Record<string, unknown>): Record<string, unknown>[] {
  const llm = objectAt(data, "llm");
  const existing = llm["models"];
  if (Array.isArray(existing)) return existing as Record<string, unknown>[];
  const created: Record<string, unknown>[] = [];
  llm["models"] = created;
  return created;
}

/**
 * Creates or replaces one entry of `llm.models`, which is what `models.upsert` means.
 *
 * Replaced, not merged: the app sends the declaration it wants stored, so a field it stops sending
 * is a field the owner cleared. The merge that does happen is with *discovery*, field by field, in
 * `mergeModels` -- so an entry here only has to carry what differs from what the provider says.
 */
export async function upsertModel(entry: ModelDeclaration): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const providers = providersAt(read.data);
  const invalid = modelDeclarationError(entry, providers);
  if (invalid) return { ok: false, error: invalid };

  const stored: Record<string, unknown> = { id: entry.id, label: entry.label || entry.id };
  for (const field of ["apiId", "provider", "group", "family"] as const) {
    if (entry[field]) stored[field] = entry[field];
  }
  for (const field of ["vision", "supportsEffort"] as const) {
    if (entry[field] !== undefined) stored[field] = entry[field];
  }
  if (entry.supportedEffortLevels?.length) stored["supportedEffortLevels"] = entry.supportedEffortLevels;
  if (entry.thinkingTypes) stored["thinkingTypes"] = entry.thinkingTypes;
  const limit: Record<string, number> = {};
  if (entry.limit?.context) limit["context"] = entry.limit.context;
  if (entry.limit?.output) limit["output"] = entry.limit.output;
  if (Object.keys(limit).length > 0) stored["limit"] = limit;
  // Not `if (entry.timeoutMs)`: `0` is the value that disarms the timer, and truthiness would
  // silently drop it and leave the transport default in place.
  if (entry.timeoutMs !== undefined) stored["timeoutMs"] = entry.timeoutMs;

  const models = modelsAt(read.data);
  const at = models.findIndex((m) => m && typeof m === "object" && m["id"] === entry.id);
  const created = at < 0;
  if (created) models.push(stored);
  else models[at] = stored;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant ${created ? "ajout" : "édition"} modèle ${entry.id}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { modelUpserted: entry.id, created });
  return { ok: true, previous: {} };
}

/**
 * Deletes one entry of `llm.models`. For an id discovery also serves, this is the reset: the
 * declaration disappears and the provider's own answer applies again.
 *
 * An unknown id is refused rather than reported as done. "Nothing to delete" and "deleted" look
 * identical from the app, and the difference is exactly what tells the owner the id they are
 * staring at came from discovery and not from their file.
 */
export async function removeModel(id: string): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const llm = objectAt(read.data, "llm");
  const models = Array.isArray(llm["models"]) ? (llm["models"] as Record<string, unknown>[]) : [];
  const at = models.findIndex((m) => m && typeof m === "object" && m["id"] === id);
  if (at < 0) return { ok: false, error: `No model declared with the id "${id}"` };
  models.splice(at, 1);
  llm["models"] = models;

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant suppression modèle ${id}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { modelRemoved: id });
  return { ok: true, previous: {} };
}

export interface DeviceEntry {
  token: string;
  name?: string;
  enabled?: boolean;
  kind?: "app" | "web";
  owner?: string;
  createdAt?: string;
  lastSeenAt?: string;
}

/**
 * Writes one entry under `channels.my-claw-app.devices`.
 *
 * Pairing mints a credential, so it goes through the same snapshot + atomic write as every other
 * edit here: a device that appears out of nowhere is visible in `/config diff` and removable with
 * `/config rollback`. The token is never logged, only the id.
 */
export async function upsertDevice(deviceId: string, entry: DeviceEntry): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const channels = objectAt(read.data, "channels");
  const channel = objectAt(channels, "my-claw-app");
  const devices = objectAt(channel, "devices");
  devices[deviceId] = { ...(devices[deviceId] as Record<string, unknown> | undefined), ...entry };

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant ajout device ${deviceId}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { deviceAdded: deviceId, kind: entry.kind });
  return { ok: true, previous: {} };
}

/** Drops a device entry. Returns ok even when it was already gone: revoking twice is not an error. */
export async function removeDevice(deviceId: string): Promise<ConfigEditResult> {
  const read = await readConfigFile();
  if (!read.ok) return read;

  const channels = objectAt(read.data, "channels");
  const channel = objectAt(channels, "my-claw-app");
  const devices = objectAt(channel, "devices");
  if (!(deviceId in devices)) return { ok: true, previous: {} };
  delete devices[deviceId];

  await snapshot(CONFIG_PATH, { origin: "pre-write", note: `avant revocation device ${deviceId}` });
  await writeFileAtomically(CONFIG_PATH, `${JSON.stringify(read.data, null, INDENT)}\n`, { mode: read.mode });
  await journal("edit", artifactId(CONFIG_PATH), { deviceRemoved: deviceId });
  return { ok: true, previous: {} };
}
