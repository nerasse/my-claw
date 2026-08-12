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
  /**
   * Only when `threadId` is a sub-agent handle: the conversation the roster was read from, which
   * is the caller the visibility rule is applied to. Not a claim the server takes on trust -- it
   * is matched against the sub-agent's recorded parent. Absent or unresolvable means an unknown
   * caller, which reaches `global` sub-agents and never a `private` one.
   * See docs/subagent-navigation.md.
   */
  parentThreadId?: string;
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

/** One entry of the tags page: a named alias for a model/effort/context combo (docs/tags.md). */
export interface MyClawAppTagInfo {
  name: string;
  /** The model id the tag pins, or "" for the virtual `Default` tag. */
  model: string;
  effort?: string;
  contextCap?: number;
}

export interface MyClawAppTagsList {
  type: "tags.list";
}

export interface MyClawAppTagsUpsert {
  type: "tags.upsert";
  name: string;
  model: string;
  effort?: string;
  contextCap?: number;
}

export interface MyClawAppTagsDelete {
  type: "tags.delete";
  name: string;
}

export interface MyClawAppTagsResult {
  type: "tags.result";
  tags: MyClawAppTagInfo[];
}

/** Health snapshot, meant to be copy-pasted out of the app. */
export interface MyClawAppDiagSnapshot {
  type: "diag.snapshot";
  threadId?: string;
}

/**
 * A crash, a fatal JS error, or the reason the OS killed the app's process last time, reported
 * by the device on its next connection. `adb` is not reachable on every network the phone lives
 * on, and Android's logcat is a ring buffer, so the device is the only place that can keep this
 * until it has somewhere to send it.
 */
export interface MyClawAppDiagReport {
  type: "diag.report";
  reports: {
    /** `js` and `render` come from the app; `exit` is Android's own post-mortem. */
    kind: "js" | "render" | "exit";
    at: number;
    message: string;
    /** Hermes ships bytecode: unreadable without the composed source map of that exact build. */
    stack?: string;
    appVersion?: string;
    /** ApplicationExitInfo: CRASH, CRASH_NATIVE, ANR, LOW_MEMORY, USER_REQUESTED... */
    reason?: string;
  }[];
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

/** Sets the per-file prompt policy of one workspace; answers instructions.list.result.
 *  Each absent field keeps the current policy, so the app never needs to read before writing. */
export interface MyClawAppInstructionsLayerSet {
  type: "instructions.layer.set";
  workspace: string;
  /** One of CORE.md, SOUL.md, AGENTS.md, USER.md. */
  file: string;
  /** Where the layer is read when this workspace owns no file: "default", "builtin", "none",
   *  or a config.workspaces key. "default" is the no-op reset. */
  inherit?: string;
  /** Drops the layer even when this workspace owns the file. false is the no-op reset. */
  off?: boolean;
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

/** This conversation's context ceiling: a number of tokens, or "full" for the model's own window.
 *  Never above the full window -- the server clamps and answers with what it stored. */
export interface MyClawAppModelContextSet {
  type: "model.context.set";
  threadId: string;
  choice: number | "full";
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
  /**
   * The effort pin written in the same pass as the model, because the two are picked together.
   * `""` removes the pin; absent keeps whatever the target already had.
   */
  effort?: string;
}

/** Removes an agent's model pin so it inherits again. Never valid for "global". */
export interface MyClawAppAgentsModelClear {
  type: "agents.model.clear";
  agent: string;
}

/**
 * Pins the vision fallback model (`llm.visionFallback`): image runs are rerouted to it when
 * the resolved model cannot take images. The picker only offers vision-capable models, and
 * the server refuses anything else: a text-only fallback would silently do nothing at run
 * time. `""` removes the pin, which returns image runs to the resolved model (they fail if
 * it cannot take images).
 */
export interface MyClawAppAgentsFallbackSet {
  type: "agents.fallback.set";
  model: string;
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

/** Declares a workspace key -> absolute path pair. The key is what agents and cron reference. */
export interface MyClawAppWorkspacesAdd {
  type: "workspaces.add";
  key: string;
  path: string;
}

/** Removes a named workspace. Agent pins pointing at it stay and are flagged red. */
export interface MyClawAppWorkspacesRemove {
  type: "workspaces.remove";
  key: string;
}

/** Renames a workspace key, same path. Agents pinned to the old key are rewritten with it. */
export interface MyClawAppWorkspacesRename {
  type: "workspaces.rename";
  from: string;
  to: string;
}

/** Repoints a workspace key at a different absolute path. */
export interface MyClawAppWorkspacesSetPath {
  type: "workspaces.path.set";
  key: string;
  path: string;
}

/**
 * Creates or edits a provider under `llm.providers`. `key` names the entry, so upsert is both
 * the create form and the edit form. Empty strings delete the field, an absent one leaves it
 * alone. `providerType` is the engine ("openai", "claude-sdk", "codex"); the frame's own `type`
 * discriminates the message, so the two cannot share a name. The env key is never carried here:
 * it has its own pages (providers.env.*).
 */
export interface MyClawAppProviderUpsert {
  type: "providers.upsert";
  key: string;
  providerType?: "openai" | "claude-sdk" | "codex";
  baseUrl?: string;
  apiKeyEnv?: string;
  group?: string;
  discover?: boolean;
  promptCache?: boolean;
  pricingProvider?: string;
  fallbackModel?: string;
}

/** Removes a provider. Refused while anything still references it. */
export interface MyClawAppProviderRemove {
  type: "providers.remove";
  key: string;
}

/** Renames the provider key, rewriting every reference in the same file in one write. */
export interface MyClawAppProviderRename {
  type: "providers.rename";
  from: string;
  to: string;
}

/** Writes one `NAME=value` line in ~/.my-claw/.env. The one frame that carries a secret value. */
export interface MyClawAppProviderEnvSet {
  type: "providers.env.set";
  name: string;
  value: string;
}

/** Renames a variable in .env, value preserved, and repoints every provider that read the old
 *  name. The old name disappears from the process: the loader never deletes. */
export interface MyClawAppProviderEnvRename {
  type: "providers.env.rename";
  from: string;
  to: string;
}

/** Drops a variable from .env. Used when a provider is deleted and its key dies with it. */
export interface MyClawAppProviderEnvRemove {
  type: "providers.env.remove";
  name: string;
}

/** Lists the variable names known to the server and who reads each. Names, never values. */
export interface MyClawAppProviderEnvList {
  type: "providers.env.list";
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
  | MyClawAppDiagReport
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
  | MyClawAppInstructionsLayerSet
  | MyClawAppModelList
  | MyClawAppModelGet
  | MyClawAppModelSet
  | MyClawAppModelEffortSet
  | MyClawAppModelContextSet
  | MyClawAppChatStop
  | MyClawAppAgentsConfigGet
  | MyClawAppAgentsModelSet
  | MyClawAppAgentsModelClear
  | MyClawAppAgentsFallbackSet
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
  | MyClawAppWorkspacesAdd
  | MyClawAppWorkspacesRemove
  | MyClawAppWorkspacesRename
  | MyClawAppWorkspacesSetPath
  | MyClawAppProviderUpsert
  | MyClawAppProviderRemove
  | MyClawAppProviderRename
  | MyClawAppProviderEnvSet
  | MyClawAppProviderEnvRename
  | MyClawAppProviderEnvRemove
  | MyClawAppProviderEnvList
  | MyClawAppStatusGet
  | MyClawAppJobsList
  | MyClawAppJobsRuns
  | MyClawAppSubAgentsList
  | MyClawAppJobSave
  | MyClawAppJobDelete
  | MyClawAppNotificationsRegister
  | MyClawAppNotificationsState
  | MyClawAppTagsList
  | MyClawAppTagsUpsert
  | MyClawAppTagsDelete
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
      /** What the model thought before this reply, replayed collapsed -- docs/reasoning-visibility.md. */
      reasoning?: string;
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
  /** A run is answering on this thread right now: the app keeps the Stop button visible. */
  activeRun?: boolean;
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
  /**
   * A statement of the system rather than a reply from the agent: a model fallback, a warning
   * about a failed voice take. Rendered apart, because a warning that looks like the assistant
   * talking is a warning that gets read as content.
   */
  notice?: boolean;
}

/** A run started answering on a thread: the app keeps its Stop affordance until the matching end. */
export interface MyClawAppRunStart {
  type: "chat.run.start";
  threadId: string;
  run?: string;
}

/** A run finished on a thread. `aborted` is a Stop from any surface; `error` is a failed run. */
export interface MyClawAppRunEnd {
  type: "chat.run.end";
  threadId: string;
  reason: "done" | "aborted" | "error";
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

/**
 * Incremental reasoning for the bubble `id` -- docs/reasoning-visibility.md. Sent only by engines
 * that expose the text (OpenAI-compatible, Codex summaries), and only to this channel.
 */
export interface MyClawAppReasoningDelta {
  type: "chat.reasoning.delta";
  id: string;
  threadId: string;
  text: string;
}

/**
 * Running token estimate while a redacted engine thinks (the Claude Code bridge never sends the
 * text). No reasoning text will follow on this bubble, so the app shows a count, not a disclosure.
 */
export interface MyClawAppReasoningTokens {
  type: "chat.reasoning.tokens";
  id: string;
  threadId: string;
  tokens: number;
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
  | "config"
  | "workspaces"
  | "status"
  | "jobs"
  | "subagents"
  | "notifications"
  | "tags"
  | "providers";

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
  /**
   * Effort levels this model accepts; empty means it discards effort. Carried per model so the
   * app's chained picker can offer the step for the model being staged rather than only for the
   * one currently in force.
   */
  effortLevels?: string[];
  /** The model's own full context window, so the app can offer ceilings under it and no higher. */
  context?: number;
  /** For a tag entry: the effort the tag pins, so a config flow can name what applies. */
  effort?: string;
  /** Whether the model accepts image input; the fallback picker only offers vision-capable ones. */
  vision?: boolean;
}

/** Effort state of a thread: what applies now, what is on offer for the active model. */
export interface MyClawAppEffortState {
  /** The level in effect ("" when the model discards effort). */
  level: string;
  /** Levels the active model accepts; empty means no choice is offered. */
  levels: string[];
  supported: boolean;
}

/**
 * What window this thread may use, and what the owner may pick from. The app builds the ceiling
 * list itself (full window, the standing cap, then the graduations under it), so this carries the
 * three numbers that list is derived from rather than a pre-rendered menu. See
 * docs/context-window.md.
 */
export interface MyClawAppContextState {
  /** The model's full window. */
  raw: number;
  /** What the run may actually use once the session choice and the standing cap are applied. */
  effective: number;
  /** The standing agent/global cap, when one is set and actually below the full window. */
  cap?: number;
  /** This conversation's own choice: a ceiling, "full", or absent when it follows policy. */
  choice?: number | "full";
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
  /** `own` is a file in this workspace, `inherited` another workspace's, `fallback` the
   *  template, `off` the layer dropped by the workspace's policy. */
  origin: "own" | "inherited" | "fallback" | "off";
  /** Workspace the content comes from, empty for `fallback`. */
  from: string;
  bytes: number;
  /** sha of the content that applies; a write must echo it back to prove it is not stale. */
  sha: string;
  /** The workspace's effective policy, always normalised. Absent on a server that predates the
   *  feature: the app then hides the layer controls instead of showing a dead one. */
  inherit: string;
  off: boolean;
  /** The layer resolves to nothing on purpose: `off`, `inherit: "none"`, or a source that is cut
   *  and owns no file. The row must not promise a template that is never read, and only the
   *  server knows the third case -- the entry alone does not carry it. */
  empty: boolean;
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
  /** Workspaces whose nested list was cut by the per-workspace cap, so the page can say the list
   *  is incomplete instead of implying the workspace has nothing more. Omitted when none were. */
  nestedTruncated?: string[];
  /** The editable names, so the app never hardcodes the list the server enforces. */
  files: string[];
  maxBytes: number;
  /** File-defined agents and the prompt layers each declares, so the layer screen can say which
   *  agents already cut a layer in their own file. Absent: the section is not rendered. */
  agentLayers?: Array<{ agent: string; layers: string[] }>;
}

export interface MyClawAppInstructionsFile {
  type: "instructions.file";
  workspace: string;
  file: string;
  content: string;
  origin: "own" | "inherited" | "fallback" | "nested" | "off";
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
/** The whole model state of a thread, shared by the frame and the controller that produces it. */
export interface MyClawAppModelState {
  /** The model that will run on this thread: this chat's pick, the agent's pin, or the default. */
  model: string;
  defaultModel: string;
  /**
   * Which of those three it is. "agent" means the chat inherits a pin that lives in
   * `config.agents`, and the row has to say so: a screen that shows the model without its source
   * cannot explain why picking the global default changed nothing (docs/model-resolution.md).
   * Absent on a server that predates the field.
   */
  source?: "session" | "agent" | "agent-file" | "global";
  effort: MyClawAppEffortState;
  context: MyClawAppContextState;
}

export interface MyClawAppModelResult extends MyClawAppModelState {
  type: "model.result";
  threadId: string;
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
  /** The agent's own effort pin, absent when it has none (then the global applies). */
  effort?: string;
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

/** A configured provider, for display only: never a secret, only whether its env key is set.
 *  The editable fields ride along so the edit page can seed its form from the snapshot. */
export interface MyClawAppProviderInfo {
  key: string;
  type: string;
  group?: string;
  baseUrl?: string;
  promptCache?: boolean;
  pricingProvider?: string;
  fallbackModel?: string;
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
  /**
   * The vision fallback model: a declared, vision-capable model image runs are rerouted to
   * when the resolved model cannot take images (llm.visionFallback). "" when none is set.
   */
  fallback: string;
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
  /** A `/status` result also travels structured, so the app can draw a page instead of a bubble. */
  status?: MyClawAppStatusPayload;
}

/**
 * Structured `/status` report for the app's fullscreen diagnostics page. The text form stays the
 * canonical rendering for the chat channels; this is the same report shaped as fields.
 */
export interface MyClawAppStatusPayload {
  /** Null when this thread has no session yet: nothing has ever been asked here. */
  session: {
    id: string;
    platform: string;
    chatType: string;
    createdAt: string;
    lastActiveAt: string;
    messages: number;
    subAgent?: {
      displayName: string;
      type: string;
      visibility: string;
      parentSessionId: string;
    };
  } | null;
  model: {
    current: string;
    /** The agent's configured default, present when the session overrides it. */
    configDefault?: string;
    effort?: string;
    selfHosted: boolean;
    contextLimit: number;
    /** Why the window is what it is ("declared", "capped from …", …). */
    contextNotes: string[];
  };
  context: {
    /** The provider's count on the last call; undefined until a call is recorded. */
    measured?: { tokens: number; pctOfLimit: number };
    estimated: number;
    /** What actually drives auto-compaction. */
    occupied: number;
    autoCompactOn: boolean;
    autoCompactThresholdPct: number;
    autoCompactThresholdTokens: number;
    /** A context handed to another model (engine switch) is reported here. */
    carried?: { model: string; messages: number; tokens: number; dropped: number };
  };
  /** Session-counter figures since /new; null when no call has been made. */
  conversation: {
    calls: number;
    promptTokens: number;
    cacheReadTokens: number;
    completionTokens: number;
  } | null;
  /** The 90-day analytics for this session's own calls; null while there are none. */
  analytics: {
    calls: number;
    errors: number;
    durationMs?: number;
    billedUsd: number;
    referenceUsd: number;
    unpriced: number;
    rows: Array<{
      model: string;
      calls: number;
      promptTokens: number;
      cacheReadTokens: number;
      completionTokens: number;
      /** Absent when the model has no price on record. */
      costUsd?: number;
      costBilled: boolean;
      costApproximate: boolean;
    }>;
  } | null;
  /** Work driven by this session but run elsewhere (sub-agents, browser); null when there is none. */
  delegated: {
    calls: number;
    tokens: number;
    billedUsd: number;
    referenceUsd: number;
  } | null;
  runtime: {
    activeRun: string;
    verbose: boolean;
    approvedTools: string[];
    sdkSessionId?: string;
  };
}

/** The app asks for the fullscreen status report of a conversation. */
export interface MyClawAppStatusGet {
  type: "status.get";
  threadId: string;
}

export interface MyClawAppStatusResult {
  type: "status.result";
  threadId: string;
  /** The same report as text, for clients that only show plain output. */
  text: string;
  status: MyClawAppStatusPayload;
}

/** A job's scope override in the app's editing vocabulary, mirroring agents.scope.set. */
export interface MyClawAppJobScope {
  /** "inherit" removes the field (the cron agent's list applies), "all" is the "*" wildcard,
   *  "list" the names picked — `[]` means "nothing", kept as a decision. Names are never
   *  validated against the live catalogs: the job is the truth, a stale name is red, not refused. */
  mode: "inherit" | "all" | "list";
  names?: string[];
}

/** The wire shape of a scheduled task (src/cron/types.ts), with the run-time unknowns resolved. */
export interface MyClawAppJobEntry {
  id: string;
  name: string;
  prompt: string;
  schedule: {
    kind: "cron" | "interval" | "once";
    expr?: string;
    minutes?: number;
    runAt?: string;
    display: string;
  };
  enabled: boolean;
  /** Suppresses this job's push notifications, successes and failures alike. */
  silent: boolean;
  state: "scheduled" | "paused" | "completed";
  pausedReason?: string;
  /** 1 for "once" jobs, null for recurring ones. Not editable: fixed by the schedule kind. */
  repeat: number | null;
  completedRuns: number;
  /** Display form of the delivery target: "local", "origin", or "telegram:chatId". */
  deliver: string;
  model?: string;
  /** The job's own effort pin, the sibling of `model`. */
  effort?: string;
  workspace?: string;
  skillsMode: "inherit" | "all" | "list";
  skills?: string[];
  mcpMode: "inherit" | "all" | "list";
  mcp?: string[];
  toolsMode: "inherit" | "all" | "list";
  tools?: string[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  createdAt: string;
  /** True when the model is not in the live catalog: shown red, saved anyway. */
  unknownModel: boolean;
  /** True when the workspace key left config.workspaces: the job pauses at its next run. */
  unknownWorkspace: boolean;
  /** Skill/MCP/tool names that match nothing in the live catalogs. Shown red, saved anyway. */
  unknownSkills: string[];
  unknownMcp: string[];
  unknownTools: string[];
}

/**
 * The sub-agents reachable from one conversation. Scoped on purpose: the answer is whatever
 * `SubAgentRunner.list` returns for this thread's session, so a private sub-agent of another
 * conversation is absent rather than hidden. See docs/subagent-navigation.md.
 */
export interface MyClawAppSubAgentsList {
  type: "subagents.list";
  /** The parent conversation, not a sub-agent. */
  threadId: string;
}

export interface MyClawAppSubAgentsListResult {
  type: "subagents.list.result";
  threadId: string;
  agents: MyClawAppSubAgentEntry[];
}

/**
 * One live sub-agent. `threadId` is its session seen as a thread (`sub-<digest>`), which is what
 * the app opens; `id` is the real session id and is what the roster shows, because `displayName`
 * is chosen by the model and is not unique.
 */
export interface MyClawAppSubAgentEntry {
  threadId: string;
  id: string;
  displayName: string;
  type: string;
  messageCount: number;
  status: "idle" | "running";
  visibility: "global" | "private";
  model?: string;
  createdAt: string;
}

/**
 * A nudge, not state: the roster of `threadId` changed, and this carries only what the header
 * counter needs so it stays live without polling. The app refetches when it wants the list.
 */
export interface MyClawAppSubAgentsChanged {
  type: "subagents.changed";
  threadId: string;
  count: number;
  running: number;
}

export interface MyClawAppJobsList {
  type: "jobs.list";
}

/**
 * The run sessions of one job. Every run leaves a real session behind (the scheduler keeps
 * them now), so the app can list them, reopen one as a chat and even answer on it.
 */
export interface MyClawAppJobsRuns {
  type: "jobs.runs";
  jobId: string;
}

export interface MyClawAppJobsRunsResult {
  type: "jobs.runs.result";
  jobId: string;
  runs: MyClawAppJobsRunEntry[];
}

/** One run of a job. `threadId` is the run session seen as a thread (cron-<jobId>-<runTs>). */
export interface MyClawAppJobsRunEntry {
  threadId: string;
  runAt: number;
  messageCount: number;
  title: string;
}

/** Creates (no id) or updates a job. The schedule is parsed server-side and refused when it
 *  is not a cron expr, an "every Xm/h/d" interval, or an ISO timestamp. Jobs made from the
 *  app always deliver "local": a phone has no chat of origin, so no other target is honest. */
export interface MyClawAppJobSave {
  type: "jobs.save";
  id?: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  /** Suppresses this job's push notifications, successes and failures alike. */
  silent: boolean;
  model?: string;
  /** The job's own effort pin; "" clears it so the cron agent's setting applies. */
  effort?: string;
  workspace?: string;
  skills: MyClawAppJobScope;
  mcp: MyClawAppJobScope;
  tools: MyClawAppJobScope;
}

export interface MyClawAppJobDelete {
  type: "jobs.delete";
  id: string;
}

export interface MyClawAppJobsListResult {
  type: "jobs.list.result";
  jobs: MyClawAppJobEntry[];
}

/**
 * The app just registered with a UnifiedPush distributor and hands us its subscription
 * (a Web-Push-shaped endpoint: the URL carries the secret). An empty endpoint unregisters
 * the device. See docs/notifications.md.
 */
export interface MyClawAppNotificationsRegister {
  type: "notifications.register";
  endpoint: string;
  pubKey?: string;
  auth?: string;
}

/**
 * The app's foreground state, sent on AppState changes and when the active thread changes:
 * the one case the "run finished" notification is skipped is a device that is foreground on
 * the very thread that just finished. Everything else is published.
 */
export interface MyClawAppNotificationsState {
  type: "notifications.state";
  foreground: boolean;
  threadId?: string;
}

/** The VAPID public key the device must hand to its distributor at registration. */
export interface MyClawAppNotificationsInfo {
  type: "notifications.info";
  vapidPublicKey: string;
}

/** The thread's history is gone; the app drops its copy instead of guessing from an empty list. */
export interface MyClawAppChatCleared {
  type: "chat.cleared";
  threadId: string;
}

export type MyClawAppServerFrame =
  | MyClawAppChatMessage
  | MyClawAppRunStart
  | MyClawAppRunEnd
  | MyClawAppStreamStart
  | MyClawAppStreamDelta
  | MyClawAppReasoningDelta
  | MyClawAppReasoningTokens
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
  | MyClawAppStatusResult
  | MyClawAppChatCleared
  | MyClawAppChatTranscript
  | MyClawAppAgentsConfigResult
  | MyClawAppAgentFileResult
  | MyClawAppAgentFileSaved
  | MyClawAppConfigResult
  | MyClawAppConfigSaved
  | MyClawAppJobsListResult
  | MyClawAppJobsRunsResult
  | MyClawAppSubAgentsListResult
  | MyClawAppSubAgentsChanged
  | MyClawAppNotificationsInfo
  | MyClawAppTagsResult
  | MyClawAppProviderEnvResult
  | MyClawAppError;

/**
 * The environment variable names the server knows, and the provider each one feeds. Names
 * only: the values live in ~/.my-claw/.env and never cross the wire. The creation form reads
 * it to propose a free name or reuse one that is already set.
 */
export interface MyClawAppProviderEnvResult {
  type: "providers.env.result";
  /** Every `NAME=value` line in .env, in file order. */
  names: string[];
  /** Names present in the process env: the .env ones plus the shell/systemd ones. A name here
   *  is reusable without asking for a value, even when it has no .env line yet. */
  present: string[];
  /** provider key -> the env name it reads (apiKeyEnv). */
  usedBy: Record<string, string>;
}
