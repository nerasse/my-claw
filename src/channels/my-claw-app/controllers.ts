/**
 * The contracts the entry point injects into the my-claw-app adapter, and the per-socket state
 * they run against. They live apart from the adapter so a handler module can name them without
 * importing the class that owns them.
 */

import type {
  MyClawAppAgentFileResult,
  MyClawAppAgentFileSet,
  MyClawAppAgentsConfigResult,
  MyClawAppInstructionsFile,
  MyClawAppInstructionsListResult,
  MyClawAppJobEntry,
  MyClawAppJobSave,
  MyClawAppJobsRunEntry,
  MyClawAppMcpAdd,
  MyClawAppMcpEntry,
  MyClawAppModelEndpoint,
  MyClawAppModelState,
  MyClawAppNotificationsRegister,
  MyClawAppProviderEnvResult,
  MyClawAppProviderUpsert,
  MyClawAppModelUpsert,
  MyClawAppUnavailableModel,
  MyClawAppSessionInstructions,
  MyClawAppSkillEntry,
  MyClawAppStatusPayload,
  MyClawAppSubAgentEntry,
  MyClawAppTagsResult,
  MyClawAppTagRouteCandidate,
  MyClawAppToolEntry,
  MyClawAppWorkspacesListResult,
} from "./types.ts";

export interface MyClawAppSessionData {
  deviceId: string;
  /** Conversation namespace of the device (config `owner`, else the device id). */
  owner: string;
  lastSeen: number;
  /**
   * Set on a socket opened at /my-claw-app/pair. It is unauthenticated and speaks a protocol of
   * its own, so every chat handler refuses it before reading anything else -- docs/web-pairing.md.
   */
  pairing?: true;
  code?: string;
  origin?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Speech-to-text engine control, injected for the same reason as the diagnostics provider: the
 * adapter must not reach into the global config or the voice runtime itself.
 */
export interface MyClawAppVoiceController {
  /** Configured choice, what it resolves to now, and whether cloud is usable at all. */
  status(): { mode: "cloud" | "local" | "auto"; resolved: "cloud" | "local"; cloudAvailable: boolean };
  /** Persisted, not just applied: a switch flipped in the app must survive a restart. */
  setMode(mode: "cloud" | "local" | "auto"): Promise<void>;
}

/**
 * App display preferences (auto-expand of tool cards and reasoning blocks), injected for the same
 * reason as the voice controller: the adapter must not reach into the global config itself.
 */
export interface MyClawAppUiPrefsController {
  /** What the server currently owns, with defaults filled in for anything absent. */
  status(): { expandTools: boolean; expandReasoning: boolean };
  /** Persisted, not just applied: a toggle flipped in the app must survive a restart. */
  set(prefs: { expandTools?: boolean; expandReasoning?: boolean }): Promise<{ expandTools: boolean; expandReasoning: boolean }>;
}

/** Supplied by the entry point: the adapter must not reach into the global config itself. */
export interface MyClawAppDiagnosticsProvider {
  snapshot(owner: string, threadId: string): Promise<string>;
  logs(query: { scope?: string; level?: string; run?: string; contains?: string; limit: number }): Promise<{ text: string; lines: number }>;
}

/**
 * Model control, injected for the same reason as the voice controller: the adapter must not
 * reach into the global config, the model picker or the session manager itself.
 */
export interface MyClawAppModelController {
  list(): { models: Array<{ id: string; label: string; group?: string; effortLevels?: string[]; context?: number }>; defaultModel: string; unavailable: MyClawAppUnavailableModel[] };
  /**
   * Creates or replaces one `llm.models` declaration. Absent on a controller with no config to
   * edit, which the handler refuses rather than reporting as a silent success.
   */
  upsert?(entry: MyClawAppModelUpsert): Promise<void>;
  /** Deletes a declaration, which for a discovered id resets it to what the provider answers. */
  remove?(id: string): Promise<void>;
  /**
   * Re-runs provider discovery now and reports how it went. Absent on a controller that has no
   * catalogue to refresh, which the handler answers as a refusal rather than as a silent success.
   */
  refresh?(): Promise<{ models: number; failed: string[]; enabled: boolean }>;
  /**
   * The routes this model can be pinned to, empty for a model whose provider has none. Lazy: the
   * menu asks when it opens on one model, never for the whole catalogue.
   */
  endpoints(model: string, sort?: "price" | "context" | "output" | "uptime"): Promise<MyClawAppModelEndpoint[]>;
  /** What runs on this thread now: override or configured default, plus effort and context state. */
  current(owner: string, threadId: string): Promise<MyClawAppModelState>;
  /** Persists the override (or clears it, back to the default) and reports what was stored. */
  set(owner: string, threadId: string, modelId: string): Promise<MyClawAppModelState>;
  setEffort(owner: string, threadId: string, level: string): Promise<MyClawAppModelState>;
  /** Persists this conversation's context ceiling ("full" for the model's own window). */
  setContext(owner: string, threadId: string, choice: number | "full"): Promise<MyClawAppModelState>;
}

/**
 * Agent defaults (model, effort) and the read-only provider table, injected for the same reason
 * as the model controller: the adapter must not reach into config.json or the model picker itself.
 * Every mutation answers with the whole config snapshot, never an optimistic echo.
 */
export interface MyClawAppAgentsController {
  get(): MyClawAppAgentsConfigResult;
  /**
   * Pins `agents.<agent>.llm.defaultModel`, or `llm.defaultModel` for agent "global". The effort
   * rides in the same pass: `""` removes the pin, undefined leaves the target's own value.
   */
  setModel(agent: string, modelId: string, effort?: string): Promise<MyClawAppAgentsConfigResult>;
  /** Unpins an agent so it inherits again. Refuses "global". */
  clearModel(agent: string): Promise<MyClawAppAgentsConfigResult>;
  /** Pins the vision fallback model (`llm.visionFallback`); "" removes the pin. */
  setFallback(model: string): Promise<MyClawAppAgentsConfigResult>;
  /** Writes the `agents.<agent>.skills|mcp` override. */
  setScope(agent: string, field: "skills" | "mcp", mode: "inherit" | "all" | "list", names: string[]): Promise<MyClawAppAgentsConfigResult>;
  /** Pins `agents.<agent>.workspace`; null removes the pin. */
  setWorkspace(agent: string, workspace: string | null): Promise<MyClawAppAgentsConfigResult>;
  /** Writes `agents.<agent>.maxIterations`; null removes it. */
  setMaxIterations(agent: string, value: number | null): Promise<MyClawAppAgentsConfigResult>;
  /** Writes `agents.<agent>.context.cap`; null removes it. */
  setContextCap(agent: string, value: number | null): Promise<MyClawAppAgentsConfigResult>;
  /** The structured file of a file-defined agent, or null for a reserved role. */
  fileGet(agent: string): Promise<MyClawAppAgentFileResult | null>;
  /** Writes the agent file back; throws on conflict or a file the loader would reject. */
  fileSet(agent: string, fields: MyClawAppAgentFileSet): Promise<MyClawAppAgentFileResult>;
  /** Creates a custom-tier agent file. */
  fileCreate(name: string, description: string): Promise<MyClawAppAgentFileResult>;
  /** Deletes a file-defined agent (custom/workspace tiers only). */
  fileDelete(agent: string): Promise<void>;
}

/** Tag route CRUD (docs/tags.md). The virtual `Default` tag is synthesized into the listing by
 * the entry point. Every mutation answers with the fresh listing, never an optimistic echo. */
export interface MyClawAppTagsController {
  list(): MyClawAppTagsResult;
  upsert(fields: { name: string; model?: string; effort?: string; contextCap?: number; route?: MyClawAppTagRouteCandidate[]; fallbackToGlobalDefault?: boolean }): Promise<MyClawAppTagsResult>;
  delete(name: string): Promise<MyClawAppTagsResult>;
}

/** Provider CRUD and its env key, injected so the adapter never reads config.json or .env
 *  itself. Every provider mutation answers with the fresh agents snapshot, like tags. */
export interface MyClawAppProvidersController {
  /** Creates or edits one entry under llm.providers. */
  upsert(patch: MyClawAppProviderUpsert): Promise<MyClawAppAgentsConfigResult>;
  /** Removes one entry; refused while anything still references it. */
  remove(key: string): Promise<MyClawAppAgentsConfigResult>;
  /** Renames the entry key, rewriting references in the same file. */
  rename(from: string, to: string): Promise<MyClawAppAgentsConfigResult>;
  /** Writes one `NAME=value` line in .env. The one operation that carries a secret value. */
  envSet(name: string, value: string): Promise<void>;
  /** Renames a line in .env and repoints the providers that read the old name. */
  envRename(from: string, to: string): Promise<void>;
  /** Drops a line from .env. */
  envRemove(name: string): Promise<void>;
  /** The names in .env and which provider reads each. Never the values. */
  envList(): Promise<MyClawAppProviderEnvResult>;
}

/** Skill catalog, injected for the same reason as the model controller: the adapter must not
 *  reach into the skill registry or the filesystem itself. */
export interface MyClawAppSkillsController {
  list(): { skills: MyClawAppSkillEntry[] };
  /** Raw SKILL.md text of one skill, or null when it does not exist. */
  read(source: string, name: string, workspace?: string): Promise<string | null>;
  /** The named workspaces plus the default one, for display only. */
  workspaces(): Array<{ key: string; path: string; default: boolean }>;
  /** Moves or copies a skill directory between tiers, then answers with the fresh catalog. */
  transfer(input: MyClawAppSkillTransfer): Promise<{ skills: MyClawAppSkillEntry[] }>;
}

/** What the adapter hands the host once a transfer frame passed its format checks. */
export interface MyClawAppSkillTransfer {
  mode: "copy" | "move";
  source: "built-in" | "custom" | "workspace";
  name: string;
  workspace?: string;
  target: { source: "custom" | "workspace"; workspace?: string };
  overwrite?: boolean;
}

/** Declared MCP servers and their live state, injected so the adapter never touches the manager. */
export interface MyClawAppMcpController {
  list(): MyClawAppMcpEntry[];
  /** Declares a new server; returns the fresh listing. */
  add(spec: MyClawAppMcpAdd): Promise<MyClawAppMcpEntry[]>;
  /** Removes a declared server; returns the fresh listing. */
  remove(name: string): Promise<MyClawAppMcpEntry[]>;
  /** Enables/disables a declared server; returns the fresh listing. */
  setEnabled(name: string, enabled: boolean): Promise<MyClawAppMcpEntry[]>;
}

/** Tool catalog (built-in + plugins + MCP), injected so the adapter never reaches into the registry. */
export interface MyClawAppToolsController {
  list(): { tools: MyClawAppToolEntry[]; missing: string[] };
  /** Toggles the global tools.disabled denylist; returns the fresh catalog. */
  toggle(name: string, disabled: boolean): Promise<{ tools: MyClawAppToolEntry[]; missing: string[] }>;
}

/** The raw config.json, for the one surface with no structured editor. */
export interface MyClawAppConfigController {
  get(): Promise<{ content: string; sha: string; maxBytes: number }>;
  /** Validates through the config parser before writing; returns what the hot reload applied. */
  set(sha: string, content: string): Promise<{
    ok: boolean;
    sha: string;
    conflict: boolean;
    changed: string[];
    rebootRequired: string[];
    error?: string;
  }>;
}

/** Workspace CRUD, injected so the adapter never touches config.json or the filesystem itself.
 *  Every mutation answers with the fresh listing, never an optimistic echo. */
export interface MyClawAppWorkspacesController {
  list(): MyClawAppWorkspacesListResult["workspaces"];
  /** Declares a key -> path pair; the directory is created so the tiers can open under it. */
  add(key: string, path: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
  /** Removes a named workspace; agent pins pointing at it stay and are flagged red. */
  remove(key: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
  /** Renames a key; agents pinned to the old key are rewritten with it. */
  rename(from: string, to: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
  /** Repoints a key at a new absolute path. */
  setPath(key: string, path: string): Promise<MyClawAppWorkspacesListResult["workspaces"]>;
}

/** The prompt files the app may read and edit. See docs/instructions-page.md. */
export interface MyClawAppInstructionsController {
  list(): Promise<Omit<MyClawAppInstructionsListResult, "type">>;
  read(req: InstructionsTarget): Promise<Omit<MyClawAppInstructionsFile, "type"> | null>;
  write(
    req: InstructionsTarget & { content: string; sha: string | undefined },
  ): Promise<{ ok: boolean; sha: string; conflict: boolean; error?: string }>;
  /** Sets the per-file prompt policy; answers with the fresh listing, never an optimistic echo. */
  setPolicy(
    workspace: string,
    file: string,
    inherit: string | undefined,
    off: boolean | undefined,
  ): Promise<Omit<MyClawAppInstructionsListResult, "type">>;
}

/**
 * What one instructions read or write addresses. `nested` may be absolute, and then it is only
 * accepted against `sessionId`: the controller checks the file is one that session actually read,
 * so no path typed by a device ever reaches the disk on its own word.
 */
export interface InstructionsTarget {
  workspace: string;
  file?: string;
  nested?: string;
  /** Resolved by the adapter from the frame's threadId, so no owner mapping leaves this file. */
  sessionId?: string;
}

/**
 * Scheduled jobs CRUD, injected so the adapter never reaches into the cron store or the live
 * catalogs itself. Every mutation answers with the fresh listing, never an optimistic echo.
 * Model and scope names are never validated at save: the job is the truth, and the listing
 * carries the unknown flags that paint a stale name red instead of refusing it.
 */
export interface MyClawAppJobsController {
  list(): Promise<MyClawAppJobEntry[]>;
  /** Creates (no id) or updates a job. Refused when the schedule does not parse. */
  save(fields: MyClawAppJobSave): Promise<MyClawAppJobEntry[]>;
  /** Removes a job. Refused when no job carries that id. */
  remove(id: string): Promise<MyClawAppJobEntry[]>;
  /** The run sessions of one job, newest first. Refused when the job does not exist. */
  runs(jobId: string): Promise<MyClawAppJobsRunEntry[]>;
}

/**
 * The live sub-agents of a conversation (docs/subagent-navigation.md). Every method takes the
 * caller session, because reachability is decided against it: an unreachable sub-agent answers
 * exactly like a missing one, so neither the adapter nor the app can tell them apart.
 */
export interface MyClawAppSubAgentsController {
  list(callerSessionId: string): Promise<MyClawAppSubAgentEntry[]>;
  /** Deletes the session. The transcript does not survive. Returns the runner's own report. */
  kill(threadId: string, callerSessionId: string): Promise<string>;
  /** Archives the transcript and starts the sub-agent over, identity and workspace kept. */
  reset(threadId: string, callerSessionId: string): Promise<string>;
}

/**
 * Push endpoints and foreground state for the device notifications (docs/notifications.md).
 * Injected so the adapter never writes the push store itself.
 */
export interface MyClawAppNotificationsController {
  /** The VAPID public key the device hands its distributor at registration, if push is on. */
  info(): Promise<string | undefined>;
  register(deviceId: string, frame: MyClawAppNotificationsRegister): Promise<void>;
  unregister(deviceId: string): Promise<void>;
  setForeground(deviceId: string, state: { foreground: boolean; threadId?: string }): Promise<void>;
}

/**
 * A command handler can answer plain text, or -- for /status -- the text plus the structured
 * payload the app draws as a fullscreen page.
 */
export type MyClawAppCommandOutput = {
  text: string;
  status?: MyClawAppStatusPayload;
  /** A long aside the app folds away (a compaction summary), never part of the outcome line. */
  details?: string;
};

/** Text slash commands, executed server-side like on the other channels. */
/** The instructions report of one conversation, built by the host from the live registries. */
export type MyClawAppSessionInstructionsProvider = (sessionId: string) => Promise<MyClawAppSessionInstructions>;

export type MyClawAppCommandHandler = (
  owner: string,
  threadId: string,
  command: string,
  args: string,
) => Promise<string | MyClawAppCommandOutput | undefined>;
