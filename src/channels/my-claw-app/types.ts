/** Wire protocol for the my-claw-app channel. Spec: docs/my-claw-app-channel.md. */

export interface MyClawAppAttachmentMeta {
  id: string;
  type: "image" | "audio" | "video" | "file";
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  audioAsVoice?: boolean;
}

/**
 * Attachment of a replayed turn. Same shape as the live meta plus `deleted`, set when the blob
 * is gone from the thread: the app still names it, but has nothing to open.
 */
export interface MyClawAppHistoryAttachment extends MyClawAppAttachmentMeta {
  deleted?: boolean;
}

/** Default conversation for devices that do not send a threadId. */
export const DEFAULT_THREAD = "default";

export interface MyClawAppAttachmentRef {
  id: string;
  type: "image" | "audio" | "video" | "file";
  /**
   * Held-the-mic recording rather than an audio file the owner picked. Only the device knows,
   * and the distinction decides the STT language policy: dictation gets the configured language,
   * an arbitrary file gets auto-detection, because forcing a language on unknown speech makes
   * Whisper invent plausible words instead of failing. Honoured only on a stored audio file.
   */
  audioAsVoice?: boolean;
  /** Measured while recording; the server would need to decode the file to learn it. */
  durationMs?: number;
}

export interface MyClawAppChatSend {
  type: "chat.send";
  id: string;
  text: string;
  threadId?: string;
  ts?: string;
  attachments?: MyClawAppAttachmentRef[];
}

export interface MyClawAppSessionList {
  type: "session.list";
}

export interface MyClawAppCommandsList {
  type: "commands.list";
}

export interface MyClawAppFilesList {
  type: "files.list";
  threadId: string;
}

export interface MyClawAppFileDelete {
  type: "files.delete";
  threadId: string;
  id: string;
}

export interface MyClawAppSessionHistory {
  type: "session.history";
  threadId: string;
  limit?: number;
}

export interface MyClawAppSessionArchive {
  type: "session.archive";
  threadId: string;
}

export interface MyClawAppSessionUnarchive {
  type: "session.unarchive";
  threadId: string;
}

export interface MyClawAppSessionDelete {
  type: "session.delete";
  threadId: string;
}

export interface MyClawAppApprovalResponse {
  type: "approval.response";
  id: string;
  accepted: boolean;
}

export interface MyClawAppCapabilitiesFrame {
  type: "device.capabilities";
  accessibility?: boolean;
  notificationListener?: boolean;
  wssConnection?: boolean;
  version?: string;
}

export interface MyClawAppPing {
  type: "ping";
}

/** Health snapshot, meant to be copy-pasted out of the app. */
export interface MyClawAppDiagSnapshot {
  type: "diag.snapshot";
  threadId?: string;
}

/** Tail of the server log files, filtered. `run` is the correlation id stamped on every line. */
export interface MyClawAppLogsTail {
  type: "logs.tail";
  scope?: string;
  level?: "trace" | "debug" | "info" | "warn" | "error";
  run?: string;
  contains?: string;
  limit?: number;
}

export interface MyClawAppSessionRename {
  type: "session.rename";
  threadId: string;
  /** Blank hands the conversation back to its automatic title. */
  title: string;
}

export interface MyClawAppVoiceModeGet {
  type: "voice.mode.get";
}

export interface MyClawAppVoiceModeSet {
  type: "voice.mode.set";
  mode: "cloud" | "local" | "auto";
}

export interface MyClawAppSkillsList {
  type: "skills.list";
}

export interface MyClawAppToolsList {
  type: "tools.list";
}

/** The named workspaces (config.workspaces) plus the default one, for display only. */
export interface MyClawAppWorkspacesList {
  type: "workspaces.list";
}

/** The declared MCP servers with their connection state, for display only. */
export interface MyClawAppMcpList {
  type: "mcp.list";
}

/** The prompt files of every workspace, with their inheritance. See docs/instructions-page.md. */
export interface MyClawAppInstructionsList {
  type: "instructions.list";
}

/** Full text of one prompt file, or of a nested AGENTS.md when `nested` is set. */
export interface MyClawAppInstructionsGet {
  type: "instructions.get";
  workspace: string;
  /** One of CORE.md, SOUL.md, AGENTS.md, USER.md. Ignored when `nested` is set. */
  file?: string;
  /** Path relative to the workspace root, as returned by instructions.list.result. */
  nested?: string;
}

export interface MyClawAppInstructionsSet {
  type: "instructions.set";
  workspace: string;
  file: string;
  content: string;
  /**
   * The sha the editor loaded. Absent means "create this override": the server refuses if the
   * file already exists, just as it refuses a stale sha.
   */
  sha?: string;
}

export interface MyClawAppModelList {
  type: "model.list";
}

export interface MyClawAppModelGet {
  type: "model.get";
  threadId: string;
}

export interface MyClawAppModelSet {
  type: "model.set";
  threadId: string;
  /** The default model id hands the conversation back to the configured default. */
  model: string;
}

export interface MyClawAppModelEffortSet {
  type: "model.effort.set";
  threadId: string;
  level: string;
}

/** Stops the run on this thread, whatever backend is driving it (the `/stop` of the app). */
export interface MyClawAppChatStop {
  type: "chat.stop";
  threadId: string;
}

export interface MyClawAppAgentsConfigGet {
  type: "agents.config.get";
}

export interface MyClawAppAgentsModelSet {
  type: "agents.model.set";
  /** "global" writes `llm.defaultModel`; any agent key writes `agents.<key>.llm`. */
  agent: string;
  model: string;
}

/** Removes an agent's model pin so it inherits again. Never valid for "global". */
export interface MyClawAppAgentsModelClear {
  type: "agents.model.clear";
  agent: string;
}

/** Global default reasoning effort; `level: ""` removes the key so model/provider defaults apply. */
export interface MyClawAppAgentsEffortSet {
  type: "agents.effort.set";
  level: string;
}

/**
 * An agent's skills or MCP scope, in the resolver's own vocabulary: `"inherit"` removes the key
 * (the orchestrator's list applies, or everything), `"all"` is the `["*"]` wildcard, `"list"` the
 * names picked — `[]` means "nothing", kept as a decision. Names are never validated against the
 * live catalogs: the config is the truth, and a stale name is flagged red, not refused.
 */
export interface MyClawAppAgentsScopeSet {
  type: "agents.scope.set";
  agent: string;
  field: "skills" | "mcp";
  mode: "inherit" | "all" | "list";
  names?: string[];
}

/** Pins an agent to a workspace key; `null` or `"default"` removes the pin. Refused if the key
 *  does not exist in `config.workspaces`: the resolver throws on it at run time. */
export interface MyClawAppAgentsWorkspaceSet {
  type: "agents.workspace.set";
  agent: string;
  workspace: string | null;
}

/** Per-agent iteration budget; `null` removes it so the default applies. */
export interface MyClawAppAgentsIterationsSet {
  type: "agents.iterations.set";
  agent: string;
  value: number | null;
}

/** Per-agent context ceiling; `null` removes it so the global cap applies, `0` lifts it. */
export interface MyClawAppAgentsContextCapSet {
  type: "agents.contextcap.set";
  agent: string;
  value: number | null;
}

/** Opens one file-defined agent for editing. Refused for a reserved role (no file). */
export interface MyClawAppAgentFileGet {
  type: "agents.file.get";
  agent: string;
}

/**
 * Writes one file-defined agent back. The app sends *structured fields*; the server owns the flat
 * frontmatter serialization, so a client can never produce a file the loader would reject. The sha
 * round-trip is the same conflict contract as instructions.set. Absent optional fields remove the
 * file's frontmatter key (the tier below applies again).
 */
export interface MyClawAppAgentFileSet {
  type: "agents.file.set";
  agent: string;
  sha: string;
  description: string;
  base?: "general" | "research";
  tools?: string[];
  skillsMode: "absent" | "all" | "list";
  skills?: string[];
  mcpMode: "absent" | "all" | "list";
  mcp?: string[];
  model?: string;
  workspace?: string;
  maxIterations?: number;
  contextCap?: number;
  instructions?: string[];
  prompt: string;
}

/** Creates a new agent as a custom-tier file with the mandatory description. */
export interface MyClawAppAgentFileCreate {
  type: "agents.file.create";
  name: string;
  description: string;
}

/** Deletes a file-defined agent. Refused for the built-in tier (repo-synced, resyncs anyway). */
export interface MyClawAppAgentFileDelete {
  type: "agents.file.delete";
  agent: string;
}

/** Adds or removes one name in the global `tools.disabled` denylist. */
export interface MyClawAppToolsToggle {
  type: "tools.toggle";
  name: string;
  disabled: boolean;
}

/** Declares a new MCP server. Credentials (env/headers) are deliberately absent from the spec. */
export interface MyClawAppMcpAdd {
  type: "mcp.add";
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

export interface MyClawAppMcpRemove {
  type: "mcp.remove";
  name: string;
}

export interface MyClawAppMcpEnable {
  type: "mcp.enable";
  name: string;
  enabled: boolean;
}

/** The raw config.json text, for the one surface that has no structured editor yet. */
export interface MyClawAppConfigGet {
  type: "config.get";
}

export interface MyClawAppConfigSet {
  type: "config.set";
  sha: string;
  content: string;
}

/** Accepted from the device. Plain-text frames are treated as chat.send (M1 console). */
export type MyClawAppClientFrame =
  | MyClawAppChatSend
  | MyClawAppSessionList
  | MyClawAppCommandsList
  | MyClawAppFilesList
  | MyClawAppFileDelete
  | MyClawAppSessionHistory
  | MyClawAppSessionArchive
  | MyClawAppSessionUnarchive
  | MyClawAppSessionDelete
  | MyClawAppApprovalResponse
  | MyClawAppCapabilitiesFrame
  | MyClawAppDiagSnapshot
  | MyClawAppLogsTail
  | MyClawAppSessionRename
  | MyClawAppVoiceModeGet
  | MyClawAppVoiceModeSet
  | MyClawAppSkillsList
  | MyClawAppToolsList
  | MyClawAppWorkspacesList
  | MyClawAppMcpList
  | MyClawAppInstructionsList
  | MyClawAppInstructionsGet
  | MyClawAppInstructionsSet
  | MyClawAppModelList
  | MyClawAppModelGet
  | MyClawAppModelSet
  | MyClawAppModelEffortSet
  | MyClawAppChatStop
  | MyClawAppAgentsConfigGet
  | MyClawAppAgentsModelSet
  | MyClawAppAgentsModelClear
  | MyClawAppAgentsEffortSet
  | MyClawAppAgentsScopeSet
  | MyClawAppAgentsWorkspaceSet
  | MyClawAppAgentsIterationsSet
  | MyClawAppAgentsContextCapSet
  | MyClawAppAgentFileGet
  | MyClawAppAgentFileSet
  | MyClawAppAgentFileCreate
  | MyClawAppAgentFileDelete
  | MyClawAppToolsToggle
  | MyClawAppMcpAdd
  | MyClawAppMcpRemove
  | MyClawAppMcpEnable
  | MyClawAppConfigGet
  | MyClawAppConfigSet
  | MyClawAppPing;

export interface MyClawAppToolCallEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  durationMs?: number;
  ok: boolean;
  output: string;
  truncated: boolean;
}

/** Tool card, sent between two text bubbles of the same turn. Suppressed when verbose is off. */
export interface MyClawAppToolCall extends MyClawAppToolCallEntry {
  type: "chat.tool";
  threadId: string;
  turnId: string;
  ts: string;
}

export type MyClawAppHistoryEntry =
  | {
      id: string;
      role: "user" | "assistant";
      text: string;
      ts: string;
      attachments?: MyClawAppHistoryAttachment[];
      /** What was heard, per recording id, so each replayed bubble carries its own words. */
      transcripts?: Record<string, string>;
    }
  | ({ role: "tool"; ts: string } & MyClawAppToolCallEntry);

export interface MyClawAppSessionSummary {
  threadId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
  /**
   * Filed away by the owner. The listing carries both states so the app can split them into
   * its two lists from one round-trip, and show the archived count without asking again.
   */
  archived?: boolean;
}

export interface MyClawAppChatMessage {
  type: "chat.message";
  id: string;
  text: string;
  threadId: string;
  attachments: MyClawAppAttachmentMeta[];
  replyToId?: string;
  ts?: string;
  /** Correlation id of the run that produced this reply, quotable in a bug report. */
  run?: string;
}

export interface MyClawAppStreamStart {
  type: "chat.stream.start";
  id: string;
  threadId: string;
  replyToId?: string;
  ts?: string;
  run?: string;
}

export interface MyClawAppStreamDelta {
  type: "chat.stream.delta";
  id: string;
  threadId: string;
  text: string;
}

export interface MyClawAppStreamDone {
  type: "chat.stream.done";
  id: string;
  threadId: string;
}

export interface MyClawAppStreamAbort {
  type: "chat.stream.abort";
  id: string;
  threadId: string;
  error?: string;
}

export interface MyClawAppApprovalRequest {
  type: "approval.request";
  id: string;
  threadId: string;
  toolName: string;
  args: Record<string, unknown>;
  replyToId?: string;
  expiresAt: number;
}

export interface MyClawAppSessionListResult {
  type: "session.list.result";
  sessions: MyClawAppSessionSummary[];
}

export interface MyClawAppCommandsResult {
  type: "commands.list.result";
  commands: Array<{ name: string; description: string }>;
}

export interface MyClawAppSessionFile {
  id: string;
  filename: string;
  type: "image" | "audio" | "video" | "file";
  mimeType: string;
  sizeBytes: number;
  ts: string;
}

export interface MyClawAppDiagSnapshotResult {
  type: "diag.snapshot.result";
  text: string;
}

export interface MyClawAppLogsTailResult {
  type: "logs.tail.result";
  text: string;
  lines: number;
  /** Echoed back so the app can show what the tail was filtered on. */
  query: { scope?: string; level?: string; run?: string; contains?: string; limit?: number };
}

export interface MyClawAppFilesListResult {
  type: "files.list.result";
  threadId: string;
  files: MyClawAppSessionFile[];
  totalBytes: number;
}

export interface MyClawAppChatHistory {
  type: "chat.history";
  threadId: string;
  messages: MyClawAppHistoryEntry[];
}

/** Which request was refused, so the app can show it where the user is looking. */
export type MyClawAppErrorScope =
  | "chat"
  | "files"
  | "session"
  | "diag"
  | "logs"
  | "voice"
  | "model"
  | "skills"
  | "agents"
  | "mcp"
  | "tools"
  | "instructions"
  | "config";

export interface MyClawAppError {
  type: "error";
  message: string;
  scope: MyClawAppErrorScope;
}

/**
 * What the server heard in a voice note, addressed to the message that carried it. Sent instead
 * of the generic echo for this channel: the app renders it inside the recording's own bubble, and
 * a separate message would push the conversation apart to say something about a bubble above it.
 */
export interface MyClawAppChatTranscript {
  type: "chat.transcript";
  threadId: string;
  /** The chat.send id the device generated, so the bubble is found without guessing. */
  replyToId: string;
  /** One entry per recording, keyed by attachment id: a message may carry several. */
  items: Array<{ id: string; text: string }>;
}

export interface MyClawAppVoiceModeResult {
  type: "voice.mode.result";
  /** What the owner asked for. */
  mode: "cloud" | "local" | "auto";
  /** What "auto" actually resolves to right now, so the app can stop guessing. */
  resolved: "cloud" | "local";
  /** False when no GROQ_API_KEY is set: "cloud" would fail, and the app must say so. */
  cloudAvailable: boolean;
}

export interface MyClawAppModelOption {
  id: string;
  label: string;
  /** "/"-separated menu path; the app renders groups the way the picker does. */
  group?: string;
  /** Provider key this model belongs to, so the app can group models by provider. */
  provider?: string;
}

/** Effort state of a thread: what applies now, what is on offer for the active model. */
export interface MyClawAppEffortState {
  /** The level in effect ("" when the model discards effort). */
  level: string;
  /** Levels the active model accepts; empty means no choice is offered. */
  levels: string[];
  supported: boolean;
}

export interface MyClawAppModelListResult {
  type: "model.list.result";
  models: MyClawAppModelOption[];
  defaultModel: string;
}

/** One skill of the server catalog. `path` is display-only: where the file lives on the server,
 *  so the owner knows where to edit. Reading goes through source+name, never through this path. */
export interface MyClawAppSkillEntry {
  name: string;
  description: string;
  version?: string;
  source: "built-in" | "custom" | "workspace";
  path: string;
}

export interface MyClawAppSkillsListResult {
  type: "skills.list.result";
  skills: MyClawAppSkillEntry[];
}

export interface MyClawAppWorkspaceEntry {
  key: string;
  path: string;
  /** The configured default workspace. */
  default: boolean;
}

export interface MyClawAppWorkspacesListResult {
  type: "workspaces.list.result";
  workspaces: MyClawAppWorkspaceEntry[];
}

/**
 * One declared MCP server, for display only. The wiring stays on the server: `command`, `args`,
 * `env`, `url` and `headers` routinely carry credentials, and none of them is needed to say which
 * servers exist and which ones answer. A server that failed to connect is listed too, since
 * hiding it removes exactly the entry worth reporting.
 */
export interface MyClawAppMcpEntry {
  /** The config key under `mcp`, which is also the tool namespace `mcp__<name>__`. */
  name: string;
  transport: "stdio" | "sse" | "http";
  state: "connected" | "disabled" | "failed";
  toolCount: number;
  /** Present only for `failed`, same text `/mcp` already shows the owner. */
  lastError?: string;
  /** Absent for a server never attempted, i.e. a disabled one. */
  lastAttemptAt?: string;
  /** Declared `mcp.<name>.enabled`. Absent is enabled; the app toggles this key. */
  enabled?: boolean;
  /** Declared wiring, minus secrets (`env`/`headers` stay on the server). */
  command?: string;
  args?: string[];
  url?: string;
}

export interface MyClawAppMcpListResult {
  type: "mcp.list.result";
  servers: MyClawAppMcpEntry[];
}

/**
 * One tool of the server catalog. `source` tells where it comes from: statically built into the
 * server, an owner-authored plugin from `tools.d/`, or an external MCP server. MCP tools carry
 * their server name; the others never do. `disabled` mirrors the global `tools.disabled`
 * denylist, so the page can show what is off without hiding it. Parameters are deliberately
 * absent: the wire is for reading a catalog, and a schema dump belongs to a detail page.
 */
export interface MyClawAppToolEntry {
  name: string;
  description: string;
  source: "built-in" | "plugin" | "mcp";
  /** Present for source "mcp": the config key under `mcp`, also the tool namespace prefix. */
  server?: string;
  /** Whether the global tools.disabled denylist switches it off. */
  disabled: boolean;
}

export interface MyClawAppToolsListResult {
  type: "tools.list.result";
  tools: MyClawAppToolEntry[];
  /** Names in `tools.disabled` that no tool carries anymore. Shown red so the denylist can be
   *  cleaned: an entry like that does nothing, so it has to be visible to be removed. */
  missing: string[];
}

/**
 * One prompt file in one workspace. There is never a "missing" entry: a workspace that does not
 * carry the file inherits the default workspace's copy, and that is what the agent reads, so the
 * page shows the resolution rather than a hole.
 */
export interface MyClawAppInstructionEntry {
  workspace: string;
  file: string;
  /** `own` is a file in this workspace, `inherited` the default one's, `fallback` the template. */
  origin: "own" | "inherited" | "fallback";
  /** Workspace the content comes from, empty for `fallback`. */
  from: string;
  bytes: number;
  /** sha of the content that applies; a write must echo it back to prove it is not stale. */
  sha: string;
}

/** A nested AGENTS.md found under a workspace. Read-only: injected in tool results, not in the prompt. */
export interface MyClawAppNestedInstruction {
  workspace: string;
  path: string;
  bytes: number;
}

export interface MyClawAppInstructionsListResult {
  type: "instructions.list.result";
  entries: MyClawAppInstructionEntry[];
  nested: MyClawAppNestedInstruction[];
  /** The editable names, so the app never hardcodes the list the server enforces. */
  files: string[];
  maxBytes: number;
}

export interface MyClawAppInstructionsFile {
  type: "instructions.file";
  workspace: string;
  file: string;
  content: string;
  origin: "own" | "inherited" | "fallback" | "nested";
  from: string;
  sha: string;
  /** A nested AGENTS.md cannot be written back. */
  editable: boolean;
}

/**
 * Answer to instructions.set. `conflict` marks the one failure the app must handle differently:
 * the file changed on the server, so the editor has to reload before offering to save again.
 */
export interface MyClawAppInstructionsSaved {
  type: "instructions.saved";
  workspace: string;
  file: string;
  ok: boolean;
  sha: string;
  conflict: boolean;
  error?: string;
}

/**
 * Answer to model.get, model.set and model.effort.set: the state the server actually stored,
 * never an optimistic echo of what the app hoped for.
 */
export interface MyClawAppModelResult {
  type: "model.result";
  threadId: string;
  /** The model that will run on this thread: override or the configured default. */
  model: string;
  defaultModel: string;
  effort: MyClawAppEffortState;
}

/**
 * One agent, as it resolves right now: its own pin when it has one, otherwise what it inherits.
 * `skills`/`mcp`/`workspace`/`contextCap`/`maxIterations` are the raw config entry; null means
 * absent (and inherited), [] is a deliberate "nothing".
 */
export interface MyClawAppAgentInfo {
  /** The config key, e.g. "orchestrator". The app renders whatever the server sends. */
  key: string;
  label: string;
  description: string;
  /** The model that runs for this agent: own pin or inherited. */
  model: string;
  provider?: string;
  /** There is an entry in `agents.<key>.llm`. */
  pinned: boolean;
  /** Where the effective default comes from: "global", "orchestrator", or the key itself. */
  inheritsFrom: string;
  skills?: string[] | null;
  mcp?: string[] | null;
  workspace?: string | null;
  contextCap?: number | null;
  maxIterations?: number | null;
  /**
   * Scope entries (config override or the agent file) that match nothing in the live catalogs:
   * a skill that was removed, an MCP server undeclared, a workspace key gone. The app highlights
   * them in red instead of hiding them — the entry still exists in config, so it must be visible
   * to be cleaned up.
   */
  unknownSkills?: string[];
  unknownMcp?: string[];
  unknownWorkspace?: boolean;
  /**
   * Set only for file-defined agents (docs/file-agents.md). Absent marks a reserved role, which
   * exists without a file and therefore has nothing to show a tier or a path for.
   */
  source?: string;
  path?: string;
  /** The tool baseline the agent narrows from: `general` or `research`. */
  base?: string;
  /** Workspace layer the file was found in. Distinct from `workspace`, which is where it runs. */
  layer?: string;
}

/** A configured provider, for display only: never a secret, only whether its env key is set. */
export interface MyClawAppProviderInfo {
  key: string;
  type: string;
  group?: string;
  discover: boolean;
  /** Models currently known to belong to this provider. */
  models: number;
  keyEnv?: string;
  keyPresent: boolean;
}

/**
 * Answer to agents.config.get and to every agents.* mutation: the state the server stored. The
 * payload is deliberately one whole snapshot, so the app never stitches fields from separate
 * answers and a failed write cannot masquerade as a success.
 */
export interface MyClawAppAgentsConfigResult {
  type: "agents.config.result";
  defaultModel: string;
  defaultProvider?: string;
  /** "" when no global effort is set. */
  defaultEffort: string;
  /** Levels on offer for the global effort, in canonical order. */
  effortLevels: string[];
  providers: MyClawAppProviderInfo[];
  agents: MyClawAppAgentInfo[];
}

/**
 * Answer to agents.file.get, agents.file.set and agents.file.create: the file as structured
 * fields, never raw markdown — the app edits fields, the server serializes. `editable` is false
 * for the built-in tier (repo-synced at boot); the app offers a fork instead. The sha round-trip
 * is the conflict contract of instructions.set.
 */
export interface MyClawAppAgentFileResult {
  type: "agents.file.result";
  name: string;
  source: "built-in" | "custom" | "workspace";
  path: string;
  editable: boolean;
  sha: string;
  description: string;
  base?: "general" | "research";
  tools?: string[];
  skillsMode: "absent" | "all" | "list";
  skills?: string[];
  mcpMode: "absent" | "all" | "list";
  mcp?: string[];
  model?: string;
  workspace?: string;
  maxIterations?: number;
  contextCap?: number;
  instructions?: string[];
  prompt: string;
  /** The names the `tools:` picker may offer: this agent's baseline, narrowed to what exists. */
  toolOptions: string[];
  /** `tools:` entries outside the baseline. They are dropped at run time, so they are flagged
   *  red instead of being silently saved into a set that never applies. */
  unknownTools: string[];
}

export interface MyClawAppAgentFileSaved {
  type: "agents.file.saved";
  name: string;
  ok: boolean;
  sha: string;
  conflict: boolean;
  error?: string;
}

/** The raw config.json text and the sha the next write must echo. */
export interface MyClawAppConfigResult {
  type: "config.result";
  content: string;
  sha: string;
  maxBytes: number;
}

/**
 * Answer to config.set. `conflict` is the failure the editor must handle on its own: the file
 * changed, so it has to reload before saving again. On success the hot-reload watcher has already
 * applied the change; `changed`/`rebootRequired` tell the app what the reload did.
 */
export interface MyClawAppConfigSaved {
  type: "config.saved";
  ok: boolean;
  sha: string;
  conflict: boolean;
  changed: string[];
  rebootRequired: string[];
  error?: string;
}

/**
 * Output of a command executed by the server (`/status`, `/clear`, ...). Rendered by the app as
 * a distinct bubble so a command result never masquerades as an agent answer.
 */
export interface MyClawAppCommandResult {
  type: "chat.command.result";
  threadId: string;
  /** The chat.send id that carried the command, when one did. */
  replyToId?: string;
  text: string;
}

/** The thread's history is gone; the app drops its copy instead of guessing from an empty list. */
export interface MyClawAppChatCleared {
  type: "chat.cleared";
  threadId: string;
}

export type MyClawAppServerFrame =
  | MyClawAppChatMessage
  | MyClawAppStreamStart
  | MyClawAppStreamDelta
  | MyClawAppStreamDone
  | MyClawAppStreamAbort
  | MyClawAppToolCall
  | MyClawAppApprovalRequest
  | MyClawAppSessionListResult
  | MyClawAppCommandsResult
  | MyClawAppFilesListResult
  | MyClawAppDiagSnapshotResult
  | MyClawAppLogsTailResult
  | MyClawAppChatHistory
  | MyClawAppVoiceModeResult
  | MyClawAppModelListResult
  | MyClawAppSkillsListResult
  | MyClawAppToolsListResult
  | MyClawAppWorkspacesListResult
  | MyClawAppMcpListResult
  | MyClawAppInstructionsListResult
  | MyClawAppInstructionsFile
  | MyClawAppInstructionsSaved
  | MyClawAppModelResult
  | MyClawAppCommandResult
  | MyClawAppChatCleared
  | MyClawAppChatTranscript
  | MyClawAppAgentsConfigResult
  | MyClawAppAgentFileResult
  | MyClawAppAgentFileSaved
  | MyClawAppConfigResult
  | MyClawAppConfigSaved
  | MyClawAppError;
