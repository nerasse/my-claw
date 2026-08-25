/** Wire protocol for the my-claw-app channel. Spec: docs/my-claw-app-channel.md. */
import type { ChatLocation, ChatLocationInput } from "../types.ts";

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
  /** Device location; any client-supplied address is ignored by the server. */
  location?: ChatLocationInput;
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

/** Geocodes a staged location without persisting anything: the composer's preview. */
export interface MyClawAppLocationPreview {
  type: "location.preview";
  id: string;
  location: ChatLocationInput;
}

export interface MyClawAppLocationPreviewResult {
  type: "location.preview.result";
  id: string;
  location: ChatLocation;
}export interface MyClawAppCommandsList {
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
  /**
   * How many messages at the tail of the session to skip, counted from the end. Absent means the
   * newest page. The cursor is an offset rather than a message id because a session is
   * append-only: what came before a given point never changes, so the offset stays valid, and
   * nothing has to be stable across the split into bubbles the app performs on top.
   */
  before?: number;
}

/**
 * Requests a delta of entries since the client's last known state.
 *
 * The client says what it already has (`since` entry id) and on which branch it sits (`leaf`).
 * The server returns everything written since that point, plus the current head and leaf.
 *
 * This replaces the full history reload on reconnect: the app merges the delta into what it
 * already holds instead of replacing the thread.
 */
export interface MyClawAppSessionSync {
  type: "session.sync";
  threadId: string;
  /** The id of the last entry the client has. Null or absent for a fresh open. */
  since?: string | null;
  /** The leaf the client is showing. Absent means "whatever the server has". */
  leaf?: string;
  /** Maximum entries to return. Defaults to SYNC_LIMIT (500), capped there. */
  limit?: number;
}

/**
 * Asks for a tool output in full. Cards are pushed with the output clipped to TOOL_OUTPUT_LIMIT,
 * because a thread's history would otherwise carry every byte every tool ever printed for the
 * sake of the few a reader opens. The session keeps the whole thing, so a reader who does open
 * one asks for it here, by card id.
 */
export interface MyClawAppToolFull {
  type: "chat.tool.full";
  threadId: string;
  /** The card id, i.e. `toolCardId(callId)`, not the model's raw call id. */
  id: string;
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

/** Pins the conversation at the end of the pinned list, or unpins it. */
/**
 * Asks the server to re-run provider discovery now, instead of waiting for the six-hour cycle.
 * Answered by a fresh `model.list.result` plus one `model.refresh.result` saying what happened.
 */
export interface MyClawAppModelRefresh {
  type: "model.refresh";
}

/**
 * What the owner has typed and not sent on this conversation. Empty text clears it. Debounced
 * device-side: this is the one frame with a keystroke behind it -- docs/draft-sync.md.
 */
export interface MyClawAppDraftSet {
  type: "draft.set";
  threadId: string;
  text: string;
}

export interface MyClawAppSessionPin {
  type: "session.pin";
  threadId: string;
  pinned: boolean;
}

/**
 * The pinned list, in the order the owner dragged it to. Ids the owner cannot see are not
 * touched: a conversation pinned from another device while this list was on screen keeps its pin
 * and lands after the ones sent here, because a reorder is a statement about what was dragged,
 * not about what exists.
 */
export interface MyClawAppSessionPinOrder {
  type: "session.pin.order";
  threadIds: string[];
}

export interface MyClawAppApprovalResponse {
  type: "approval.response";
  id: string;
  /**
   * The grant the owner actually chose. `accepted: true` alone used to mean `allow-session`,
   * so approving one call silently whitelisted the tool for the rest of the conversation.
   * The device now says which of the two it means.
   */
  decision: "allow-once" | "allow-session" | "deny";
}

export interface MyClawAppApprovalHistory {
  type: "approval.history";
  /** Absent = every conversation of this owner. */
  threadId?: string;
  limit?: number;
  /** ISO cursor for paging: only decisions older than this. */
  before?: string;
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

/** One entry of the Tags page: a named alias for an ordered concrete model route. */
export interface MyClawAppTagRouteCandidate {
  model: string;
  effort?: string;
  contextCap?: number;
}

export interface MyClawAppTagInfo {
  name: string;
  /** The first model, kept for old clients. Empty for the virtual `Default` tag. */
  model?: string;
  effort?: string;
  contextCap?: number;
  route?: MyClawAppTagRouteCandidate[];
  fallbackToGlobalDefault?: boolean;
}

export interface MyClawAppTagsList {
  type: "tags.list";
}

export interface MyClawAppTagsUpsert {
  type: "tags.upsert";
  name: string;
  model?: string;
  effort?: string;
  contextCap?: number;
  route?: MyClawAppTagRouteCandidate[];
  fallbackToGlobalDefault?: boolean;
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

/**
 * Sets the workspace a conversation runs in. The session is created on the spot if it does not
 * exist yet, so the app can pick a workspace for a new thread before its first message; an
 * existing one switches from the next run onward. The choice wins over the orchestrator's
 * configured pin, exactly like the pin applied at creation did.
 */
export interface MyClawAppSessionWorkspaceSet {
  type: "session.workspace.set";
  threadId: string;
  /** Workspace key: "default" or a config.workspaces key. */
  workspace: string;
}

/**
 * Runs the maintenance gate now instead of at the next 15-minute tick (docs/auto-update.md).
 *
 * Carries nothing: what to install is the registry's answer, not the caller's opinion, and the
 * decision to install at all belongs to the same script the timer runs.
 */
export interface MyClawAppUpdateRun {
  type: "update.run";
}

export interface MyClawAppVoiceModeGet {
  type: "voice.mode.get";
}

export interface MyClawAppVoiceModeSet {
  type: "voice.mode.set";
  mode: "cloud" | "local" | "auto";
}

export interface MyClawAppUiPrefsGet {
  type: "uiPrefs.get";
}

export interface MyClawAppUiPrefsSet {
  type: "uiPrefs.set";
  /** Only the fields present are touched; the rest stay as they are. */
  prefs: { expandTools?: boolean; expandReasoning?: boolean };
}

export interface MyClawAppSkillsList {
  type: "skills.list";
}

/**
 * Moves or copies one skill directory between tiers. `target.source` is never "built-in": that
 * tier is resynced from the release by hash at every boot, so a write there is undone on the
 * next upgrade. Answered with a fresh skills.list.result.
 */
export interface MyClawAppSkillsTransfer {
  type: "skills.copy" | "skills.move";
  source: "built-in" | "custom" | "workspace";
  name: string;
  /** Workspace key of the source, when its tier is "workspace". */
  workspace?: string;
  target: { source: "custom" | "workspace"; workspace?: string };
  /** Replaces a skill of the same name already in the target tier. */
  overwrite?: boolean;
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
  /**
   * A nested AGENTS.md: a path relative to the workspace root, as returned by
   * instructions.list.result, or an absolute path as returned by session.instructions.result.
   * An absolute path is only accepted together with the `threadId` that listed it, and only when
   * that session actually read the file: the session's trace is the allowlist, never the device's
   * word. See docs/session-instructions.md.
   */
  nested?: string;
  /** The conversation an absolute `nested` path was listed by. Ignored for a relative one. */
  threadId?: string;
}

export interface MyClawAppInstructionsSet {
  type: "instructions.set";
  workspace: string;
  /** One of the four prompt files, or "" when `nested` names the target instead. */
  file: string;
  content: string;
  /**
   * The sha the editor loaded. Absent means "create this override": the server refuses if the
   * file already exists, just as it refuses a stale sha. A nested file is never created this way.
   */
  sha?: string;
  /** Same addressing as instructions.get: a nested AGENTS.md instead of a prompt file. */
  nested?: string;
  threadId?: string;
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

/**
 * The endpoints one OpenRouter model can be routed to, asked for when a menu opens on it. Lazy on
 * purpose: it is one HTTP call per model, and the catalogue is four hundred of them.
 */
export interface MyClawAppModelEndpoints {
  type: "model.endpoints";
  /** The model reference, as listed by `model.list`. */
  model: string;
  /**
   * How to order the routes. Absent is "price", which is what pinning is usually about. The
   * server sorts rather than the client so every surface orders one model's providers the same way.
   */
  sort?: "price" | "context" | "output" | "uptime";
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
 * alone. `providerType` is the engine ("openai", "codex", "anthropic"); the frame's own `type`
 * discriminates the message, so the two cannot share a name. The env key is never carried here:
 * it has its own pages (providers.env.*).
 */
export interface MyClawAppProviderUpsert {
  type: "providers.upsert";
  key: string;
  providerType?: "openai" | "codex" | "anthropic";
  baseUrl?: string;
  apiKeyEnv?: string;
  group?: string;
  discover?: boolean;
  promptCache?: boolean;
  reasoningReplay?: boolean;
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

/**
 * Creates or replaces one entry of `llm.models`, the hand-declared half of the catalogue.
 *
 * The entry is stored as sent, and merged over discovery field by field: it only has to carry what
 * differs from what the provider answers. Deleting it is therefore also "reset to discovered".
 * See docs/model-declarations.md.
 */
export interface MyClawAppModelUpsert {
  type: "models.upsert";
  id: string;
  label?: string;
  apiId?: string;
  provider?: string;
  group?: string;
  family?: string;
  vision?: boolean;
  context?: number;
  output?: number;
  supportsEffort?: boolean;
  effortLevels?: string[];
  thinkingAdaptive?: boolean;
  thinkingEnabled?: boolean;
}

/** Deletes a declaration. For an id discovery also serves, this is the reset to its answer. */
export interface MyClawAppModelRemove {
  type: "models.remove";
  id: string;
}

/** Accepted from the device. Plain-text frames are treated as chat.send (M1 console). */
/** Pairing socket: a browser announcing itself before the challenge -- docs/web-pairing.md. */
export interface MyClawAppPairHello {
  type: "pair.hello";
  /** A browser is given a grant to exchange for a cookie; a native client is given the token. */
  kind?: "web" | "native";
  label?: string;
  userAgent?: string;
  /**
   * Re-attaches to a challenge this client already raised, instead of asking for a new one.
   * The token proves it, and a refused resume falls back to a fresh challenge.
   */
  resume?: { code: string; token: string };
}

/** Pairing socket: presenting a code, from a `myclaw device add` link or typed by hand. */
export interface MyClawAppPairClaim {
  type: "pair.claim";
  code: string;
}

/** Chat socket: an already paired device inspecting a pairing code before approving it. */
export interface MyClawAppDevicePairLookup {
  type: "device.pair.lookup";
  code: string;
}

export interface MyClawAppDevicePairApprove {
  type: "device.pair.approve";
  code: string;
  name: string;
}

export interface MyClawAppDevicePairDeny {
  type: "device.pair.deny";
  code: string;
}

export interface MyClawAppDeviceList {
  type: "device.list";
}

export interface MyClawAppDeviceRevoke {
  type: "device.revoke";
  deviceId: string;
}

export type MyClawAppClientFrame =
  | MyClawAppChatSend
  | MyClawAppLocationPreview
  | MyClawAppSessionList
  | MyClawAppCommandsList
  | MyClawAppFilesList
  | MyClawAppFileDelete
  | MyClawAppSessionHistory
  | MyClawAppSessionSync
  | MyClawAppToolFull
  | MyClawAppSessionArchive
  | MyClawAppSessionUnarchive
  | MyClawAppSessionDelete
  | MyClawAppSessionPin
  | MyClawAppSessionPinOrder
  | MyClawAppDraftSet
  | MyClawAppModelRefresh
  | MyClawAppApprovalResponse
  | MyClawAppApprovalHistory
  | MyClawAppCapabilitiesFrame
  | MyClawAppDiagSnapshot
  | MyClawAppDiagReport
  | MyClawAppLogsTail
  | MyClawAppSessionRename
  | MyClawAppSessionWorkspaceSet
  | MyClawAppVoiceModeGet
  | MyClawAppVoiceModeSet
  | MyClawAppUiPrefsGet
  | MyClawAppUiPrefsSet
  | MyClawAppUpdateRun
  | MyClawAppSkillsList
  | MyClawAppSkillsTransfer
  | MyClawAppToolsList
  | MyClawAppWorkspacesList
  | MyClawAppMcpList
  | MyClawAppInstructionsList
  | MyClawAppInstructionsGet
  | MyClawAppInstructionsSet
  | MyClawAppInstructionsLayerSet
  | MyClawAppModelList
  | MyClawAppModelEndpoints
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
  | MyClawAppModelUpsert
  | MyClawAppModelRemove
  | MyClawAppStatusGet
  | MyClawAppSessionInstructionsGet
  | MyClawAppSessionInstructionsSet
  | MyClawAppJobsList
  | MyClawAppJobsRuns
  | MyClawAppSubAgentsList
  | MyClawAppSubAgentsKill
  | MyClawAppPairHello
  | MyClawAppPairClaim
  | MyClawAppDevicePairLookup
  | MyClawAppDevicePairApprove
  | MyClawAppDevicePairDeny
  | MyClawAppDeviceList
  | MyClawAppDeviceRevoke
  | MyClawAppSubAgentsReset
  | MyClawAppSubAgentsCallers
  | MyClawAppSubAgentsHandoff
  | MyClawAppJobSave
  | MyClawAppJobDelete
  | MyClawAppNotificationsRegister
  | MyClawAppNotificationsState
  | MyClawAppTagsList
  | MyClawAppTagsUpsert
  | MyClawAppTagsDelete
  | MyClawAppPing;

export type MyClawAppSpawnStatus = "running" | "complete" | "error" | "aborted";

/** Which tool opened the card. `spawn` and `send` share one lifecycle and differ only in label. */
export type MyClawAppSpawnAction = "spawn" | "send";

export interface MyClawAppSpawnState {
  subagentId: string;
  displayName: string;
  agentType: string;
  mode: string;
  /** `spawn` created the sub-agent, `send` drove an existing one. Wording only: same lifecycle. */
  action: MyClawAppSpawnAction;
  status: MyClawAppSpawnStatus;
  resultLength?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface MyClawAppToolCallEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  durationMs?: number;
  ok: boolean;
  output: string;
  truncated: boolean;
  /** Persisted spawn lifecycle, so a reload cannot resurrect a completed spinner. */
  spawn?: MyClawAppSpawnState;
  /**
   * The call was still executing when this snapshot was taken, so the card keeps its spinner.
   *
   * Only history sets it. The live path opens a card with `chat.tool.start` and closes it with
   * `chat.tool`, but neither frame is replayed to a window that was offline -- so a reload during
   * a tool call used to rebuild it as a finished, successful, empty-output call. The assistant
   * turn is persisted before its tools run, which is why the half-finished call is in the session
   * at all. See docs/my-claw-app-channel.md.
   */
  running?: boolean;
}

/** Tool call started: sent the moment execution begins so the card can show a spinner. The
 *  matching `chat.tool` frame reuses the same `id` to upsert the result into this card. */
export interface MyClawAppToolStart {
  type: "chat.tool.start";
  /** Same id as the `chat.tool` that follows. */
  id: string;
  threadId: string;
  turnId: string;
  name: string;
  args: Record<string, unknown>;
  ts: string;
}

/** Live output from a running tool (bash), appended to the card the start frame opened. The
 *  `chat.tool` frame that follows settles it. Streamed in throttled chunks. */
export interface MyClawAppToolDelta {
  type: "chat.tool.delta";
  /** Same id as the start/end pair. */
  id: string;
  threadId: string;
  turnId: string;
  stdout: string;
  stderr: string;
  ts: string;
  /**
   * Set only on a replay: the output before this chunk was dropped from the live turn journal to
   * hold its budget, so the card is marked truncated instead of reading as short but complete.
   * The full output is fetchable with `chat.tool.full` once the call settles --
   * docs/live-turn-replay.md.
   */
  clipped?: boolean;
}

/** A sub-agent spawned mid-run. Annotates the `spawn` tool card (by toolCallId) with its
 *  sub-agent identity and a running state, or opens a standalone card for a programmatic spawn. */
export interface MyClawAppSpawnStart {
  type: "chat.spawn.start";
  /** The tool-start card id when spawned from a tool, else the sub-agent id. */
  id: string;
  subagentId: string;
  threadId: string;
  turnId: string;
  displayName: string;
  agentType: string;
  mode: string;
  action: MyClawAppSpawnAction;
  ts: string;
}

/** Settles a spawn card: the sub-agent finished (complete), errored, or was aborted. */
export interface MyClawAppSpawnEnd {
  type: "chat.spawn.end";
  /** Same id as the start. */
  id: string;
  subagentId: string;
  threadId: string;
  turnId: string;
  status: "complete" | "error" | "aborted";
  resultLength?: number;
  error?: string;
  ts: string;
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
      location?: ChatLocation;
      /** What was heard, per recording id, so each replayed bubble carries its own words. */
      transcripts?: Record<string, string>;
      /** What the model thought before this reply, replayed collapsed -- docs/reasoning-visibility.md. */
      reasoning?: string;
      /** How much it thought, when the engine redacts the text and only counts it. */
      reasoningTokens?: number;
      /** The answer to a slash command, drawn as its own kind of bubble rather than as a reply. */
      command?: boolean;
      /** The aside folded under a command answer (a compaction summary). */
      details?: string;
      /**
       * Why the run this bubble stands for died. Replays the error the app drew live, which was
       * only ever a stream frame: the thread reopened showing a question with nothing under it.
       */
      error?: string;
      /**
       * This bubble is a compaction boundary, and how many turns above it the summary stands for.
       * The summary is stored as a `user` turn because that is the role the prompt needs it in, so
       * without this marker the app draws it as something the owner typed -- a wall of
       * `[Prior context summarized]` in his own voice, which is exactly how it looked.
       *
       * On a boundary entry `text` is the summary alone: the instructions wrapped around it are
       * addressed to the model, and the turns it stands for are replayed above it in full.
       */
      summaryOf?: number;
    }
  | ({ role: "tool"; ts: string } & MyClawAppToolCallEntry);

/** One page of replayed history, and whether anything sits before it. */
export interface MyClawAppHistoryPage {
  entries: MyClawAppHistoryEntry[];
  hasMore: boolean;
  /** The thread's unsent draft, filled on the newest page only. */
  draft?: string;
  /**
   * The cursor for the page before this one. The app cannot compute it: one stored message can
   * become two bubbles (an assistant turn plus its tool card) and a `role:"tool"` message becomes
   * none of its own, so the count of entries it received says nothing about how far back it now is.
   */
  nextBefore: number;
}

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
  /**
   * Where this conversation sits in the owner's pinned list, absent when it is not pinned. One
   * field for both facts, and it is the server's: every device shows the same pins in the same
   * order. Dense, starting at 0.
   */
  pinRank?: number;
  /** A run is answering on this thread right now: the app keeps the Stop button visible. */
  activeRun?: boolean;
  /** Workspace key the conversation runs in: "default" or a config.workspaces key. */
  workspace?: string;
  /**
   * The conversation holds unsent text. One bit, not the text: the listing is refetched on every
   * reconnect and shipping every draft in it would be paid for by every device, every time.
   */
  hasDraft?: boolean;
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

/**
 * A prompt the owner sent, mirrored to their other windows.
 *
 * The sending device draws its own bubble from its own send and never waits for this, so the
 * echo carries that device's id: whoever already has it ignores it, and everyone else gains the
 * question their incoming answer is a reply to. Without it a second window showed an answer
 * hanging under nothing until the thread was reloaded from disk.
 *
 * Shaped like a replayed user turn rather than like `chat.message`: it is the same bubble the
 * history would rebuild, so the app renders it through the same path.
 */
export interface MyClawAppChatUser {
  type: "chat.user";
  threadId: string;
  id: string;
  text: string;
  ts?: string;
  attachments?: MyClawAppHistoryAttachment[];
  location?: ChatLocation;
}

export interface MyClawAppLocationCapabilities {
  type: "location.capabilities";
  enabled: boolean;
  address: boolean;
  provider: "geoapify";
}

/** The server-confirmed location for the user bubble identified by `replyToId`. */
export interface MyClawAppChatLocation {
  type: "chat.location";
  threadId: string;
  replyToId: string;
  location: ChatLocation;
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
  /**
   * Whether "always allow in this conversation" is on offer. False for the per-invocation
   * tools (bash, memory), where every call is a distinct decision and a session grant would
   * hand over the shell for good.
   */
  allowSessionOffered: boolean;
}

/**
 * Closes a prompt the owner never answered, so the sheet does not sit there waiting on a run
 * that is already gone. `reason` is what the journal recorded.
 */
export interface MyClawAppApprovalResolved {
  type: "approval.resolved";
  id: string;
  threadId: string;
  reason: "expired" | "cancelled" | "answered-elsewhere";
}

export interface MyClawAppApprovalHistoryEntry {
  id: string;
  threadId: string;
  toolName: string;
  args: string;
  outcome: "allow-once" | "allow-session" | "deny" | "expired" | "cancelled";
  requestedAt: string;
  decidedAt: string;
  durationMs: number;
  auto: boolean;
}

export interface MyClawAppApprovalHistoryResult {
  type: "approval.history.result";
  threadId?: string;
  entries: MyClawAppApprovalHistoryEntry[];
  stats: { total: number; allowed: number; denied: number; expired: number };
}

export interface MyClawAppSessionListResult {
  type: "session.list.result";
  sessions: MyClawAppSessionSummary[];
}

export interface MyClawAppSessionWorkspaceSetResult {
  type: "session.workspace.set.result";
  threadId: string;
  /** The key the server stored, echoed back so the app renders reality, not the request. */
  workspace: string;
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
  /** Echo of the request cursor: absent or 0 is the newest page, which replaces the thread. */
  before?: number;
  /** Whether anything remains before this page, so the app stops asking at the top. */
  hasMore?: boolean;
  /** What to send as `before` to get the page just older than this one. */
  nextBefore?: number;
  /**
   * The conversation's unsent draft, on the newest page only. Opening a thread is exactly when its
   * draft is wanted, and a page reaching backwards has no business carrying it -- docs/draft-sync.md.
   */
  draft?: string;
  /**
   * Whether a run is in flight for this conversation, as of this page. Carried on the page rather
   * than read from `session.list`: the two are separate round trips, and the app decides what of
   * its own screen to keep from this very answer. When the list won that race the flag was still
   * false, and every sealed bubble of the turn in progress was dropped as stale.
   */
  activeRun?: boolean;
}

/**
 * The answer to `session.sync`: a delta of entries since the client's cursor.
 *
 * Three cases, distinguished by `reset`:
 * - Absent: `entries` is a delta to append, same branch.
 * - `"unknown-cursor"`: the cursor was not found, `entries` is a fresh page, replace the thread.
 * - `"branch-switch"`: the server's leaf diverges from the client's, `entries` is a fresh page.
 */
export interface MyClawAppSessionSyncResult {
  type: "session.sync.result";
  threadId: string;
  /** Entries since the client's cursor, in write order. */
  entries: MyClawAppHistoryEntry[];
  /** The current leaf of the session (where the next append goes). */
  leaf: string | null;
  /** The id of the last entry in the file (may differ from leaf after a branch). */
  head: string | null;
  /** Whether a run is in flight for this conversation. */
  activeRun?: boolean;
  /** Why the delta was replaced by a full page. */
  reset?: "unknown-cursor" | "branch-switch";
  /** Whether entries were truncated by the limit. */
  truncated?: boolean;
}

/**
 * The answer to `chat.tool.full`: one card's output, whole.
 *
 * `found` false is a card whose session no longer holds the call (a compaction dropped the turn,
 * or the thread was rewritten). The app then keeps what it already has rather than blanking a
 * block the reader was looking at.
 */
export interface MyClawAppChatToolFull {
  type: "chat.tool.full.result";
  threadId: string;
  id: string;
  output: string;
  found: boolean;
}

/**
 * A draft changed somewhere else. Sent to the owner's *other* windows only: the device that typed
 * it already has it. Applied only when the receiving composer is empty or unfocused, or it would
 * overwrite what is being typed there.
 */
export interface MyClawAppDraftChanged {
  type: "draft.changed";
  threadId: string;
  text: string;
  /** Server clock: device clocks drift, and last-write-wins on a drifting clock loses the wrong write. */
  ts: number;
}

/** Which request was refused, so the app can show it where the user is looking. */
export type MyClawAppErrorScope =
  | "chat"
  | "location"
  | "files"
  | "session"
  | "diag"
  | "logs"
  | "voice"
  | "uiPrefs"
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

/**
 * The answer to `update.run`, sent *before* the unit can stop the service: the socket is expected
 * to drop right after `started: true`, and the version of the next `hello` is the real verdict.
 */
export interface MyClawAppUpdateResult {
  type: "update.result";
  started: boolean;
  /** The version that is running right now, so the app can compare after reconnecting. */
  version: string;
  /** busy: a run is in flight. denied: no privilege to start the unit. failed: systemd said no. */
  reason?: "busy" | "denied" | "failed";
  detail?: string;
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

export interface MyClawAppUiPrefsResult {
  type: "uiPrefs.result";
  /** Keep tool cards expanded after their run settles (default false). */
  expandTools: boolean;
  /** Keep the reasoning block expanded after the turn settles (default false). */
  expandReasoning: boolean;
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
  /** For a tag entry: the first candidate's effort, so a config flow can name what applies. */
  effort?: string;
  /** Whether the model accepts image input; the fallback picker only offers vision-capable ones. */
  vision?: boolean;
  /**
   * The model is served by several providers and one of them can be pinned: the picker then
   * offers a routing step and asks `model.endpoints` for the list. Absent means "one route",
   * which is every provider but OpenRouter.
   */
  routes?: boolean;
  /** A `llm.models` entry contributes this model, wholly (custom) or partly (override). */
  declared?: boolean;
  /** Discovery also serves this id, so deleting the declaration resets it instead of removing it. */
  discovered?: boolean;
}

/**
 * A model that exists and cannot run. Never offered by a picker, always shown by the management
 * view: a filtered list cannot say what it removed, which is how three declarations survived their
 * own deletion from a gateway unnoticed (docs/model-declarations.md).
 */
export interface MyClawAppUnavailableModel {
  id: string;
  label: string;
  provider?: string;
  declared?: boolean;
  discovered?: boolean;
  /** The availability verdict of run-model.ts. */
  state: "stale" | "no-key" | "no-auth";
  /** Ready to print: "litellm no longer lists it", "LITELLM_API_KEY is not set". */
  reason: string;
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
  /**
   * How much of `effective` this conversation already holds, in the units the provider bills
   * (the same number the compaction gate reads). Absent when the thread has no session yet, so
   * the app shows nothing rather than a confident 0%.
   */
  used?: number;
}

export interface MyClawAppModelListResult {
  type: "model.list.result";
  /** What may run: unchanged semantics, so no picker in the app can regress into offering a 400. */
  models: MyClawAppModelOption[];
  defaultModel: string;
  /** Known and not runnable, with the reason. Read by the management view only. */
  unavailable: MyClawAppUnavailableModel[];
}

/**
 * What a hand-fired discovery found. The listing itself travels as `model.list.result`, so the
 * app has one code path for a catalogue; this frame only says how the pass went.
 */
export interface MyClawAppModelRefreshResult {
  type: "model.refresh.result";
  /** Models in the catalogue after the pass: config plus everything discovered. */
  models: number;
  /**
   * Providers that opt into discovery but did not answer in full, by config key. Their previous
   * models are still listed: a provider that cannot be reached is not evidence that its models
   * disappeared, so the pass keeps the last known set and says so here instead.
   */
  failed: string[];
  /** False when no provider opts into discovery at all, which makes a refresh a no-op. */
  enabled: boolean;
}

/** One route a model can be pinned to, with what it costs and whether it is healthy. */
export interface MyClawAppModelEndpoint {
  /** The reference to select to pin this route: the model, then `@`, then the endpoint tag. */
  id: string;
  /** The provider behind the route, spelled as its own catalogue spells it. */
  label: string;
  /** USD per million tokens. */
  promptUsd?: number;
  completionUsd?: number;
  context?: number;
  /**
   * The output ceiling of this route. Carried because it is the limit that actually refuses a
   * call: showing the context alone reads as if a 1M-context route accepts a 1M-token answer.
   */
  maxOutput?: number;
  /** Degraded or down on the provider's own health flag: worth showing, not worth hiding. */
  degraded?: boolean;
  uptime30m?: number;
}

/**
 * The routes of one model, ordered by the requested sort (price by default). An empty list means
 * the model has no routing of its own (anything that is not OpenRouter) or the lookup failed:
 * either way, automatic is the answer.
 */
export interface MyClawAppModelEndpointsResult {
  type: "model.endpoints.result";
  model: string;
  /**
   * The ordering this list is in, echoed back. A client caches routes per model and per order, and
   * the answer carries no request id: without this it would have to guess which pending ask it
   * belongs to, and a reorder would read as the order before it.
   */
  sort: "price" | "context" | "output" | "uptime";
  endpoints: MyClawAppModelEndpoint[];
}

/** One skill of the server catalog. `path` is display-only: where the file lives on the server,
 *  so the owner knows where to edit. Reading goes through source+name, never through this path. */
export interface MyClawAppSkillEntry {
  name: string;
  description: string;
  version?: string;
  source: "built-in" | "custom" | "workspace";
  path: string;
  workspace?: string;
  /** Workspaces holding their own skill of that name, so this global entry is masked there. */
  overriddenIn?: string[];
  /** The global tier this workspace skill masks, absent when the name exists nowhere else. */
  overrides?: "custom" | "built-in";
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
  reasoningReplay?: boolean;
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
  /** An aside too long for the bubble (a compaction summary), folded away like reasoning. */
  details?: string;
  /** When set, the app must reset the thread (branch switch or retry). */
  reset?: "branch-switch";
  /** Text to prefill in the composer (for retry: the user message being retried). */
  compose?: string;
  /** The new threadId to navigate to (for fork). */
  newThreadId?: string;
}

/**
 * A command is still running. Sent only once a command has taken longer than a blink (`/compact`
 * on a full session is minutes), so the app can show that something is happening instead of an
 * unexplained silence. The matching `chat.command.result` replaces it.
 */
export interface MyClawAppCommandPending {
  type: "chat.command.pending";
  threadId: string;
  /** The chat.send id that carried the command: what the result is keyed on too. */
  replyToId: string;
  text: string;
}

/**
 * The send is parked: a compaction is rewriting the history its run would resume, so the router
 * holds it until that finishes (a minute or two on a full session); or a run is already active and
 * the message was queued in its mailbox for the next turn boundary. Without this the message sits
 * in the chat with nothing behind it and the app looks frozen. Lifted by `chat.send.acked` (an
 * injection drained) or by the stream that follows (a compaction released).
 */
export interface MyClawAppChatAcked {
  type: "chat.send.acked";
  threadId: string;
  /** The chat.send id that was queued and is now drained into the run. */
  replyToId: string;
}

/**
 * The send is parked: a compaction is rewriting the history its run would resume, so the router
 * holds it until that finishes (a minute or two on a full session); or a run is already active and
 * the message was queued in its mailbox for the next turn boundary. Without this the message sits
 * in the chat with nothing behind it and the app looks frozen. Lifted by `chat.send.acked` (an
 * injection drained) or by the stream that follows (a compaction released).
 */
export interface MyClawAppChatQueued {
  type: "chat.send.queued";
  threadId: string;
  /** The chat.send id being held: the app marks that bubble, not the thread. */
  replyToId: string;
  reason: "compaction" | "injection";
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
    /**
     * Turns in the conversation. Named `messages` because a shipped APK reads it under that name
     * and does not update on the server's cadence; it counts log entries, `session.messages`
     * having been an empty array since the storage switch.
     */
    messages: number;
    subAgent?: {
      displayName: string;
      type: string;
      visibility: string;
      parentSessionId: string;
    };
  } | null;
  model: {
    /** The model the API actually receives: a `tag:` reference is resolved to its leaf. */
    current: string;
    /** Set when the current model is a `tag:` reference, naming the tag. */
    tag?: string;
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
  };
  /** Session-counter figures for this conversation; null when no call has been made. */
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
  };
}

/** The app asks for the fullscreen status report of a conversation. */
export interface MyClawAppStatusGet {
  type: "status.get";
  threadId: string;
}

/**
 * The app asks what one conversation is actually loaded with: every prompt layer as the run
 * composes it, plus the nested AGENTS.md its runs read. See docs/session-instructions.md.
 */
export interface MyClawAppSessionInstructionsGet {
  type: "session.instructions.get";
  threadId: string;
}

/**
 * The app applies one per-session instruction control. The server answers with a fresh report
 * (session.instructions.result), so the page reflects the state it just set.
 */
export interface MyClawAppSessionInstructionsSet {
  type: "session.instructions.set";
  threadId: string;
  patch: MyClawAppSessionInstructionPatch;
}

/**
 * Applies one per-session instruction control: nested AGENTS.md toggle/unload, prompt layer
 * toggle, skill toggle, memory recall toggle.
 */
export interface MyClawAppSessionInstructionPatch {
  kind: "nested.toggle" | "nested.unload" | "layer.toggle" | "skill.toggle" | "memory.toggle";
  /** For nested.*: the absolute resolved path as returned by the report. */
  path?: string;
  /** For layer.toggle: the layer id (agent, skills, tools, platform, runtime, suggested). */
  layer?: string;
  /** For skill.toggle: the skill name. */
  skill?: string;
  /** For toggles that need it: the new state, absent means flip. */
  on?: boolean;
}

export interface MyClawAppSessionInstructionsResult {
  type: "session.instructions.result";
  threadId: string;
  instructions: MyClawAppSessionInstructions;
}

/** One layer of the composed system prompt, in build order. */
export interface MyClawAppInstructionLayer {
  /** Stable id: CORE, SOUL, AGENTS, USER, agent, skills, tools, platform, runtime, suggested. */
  id: string;
  label: string;
  bytes: number;
  text: string;
  /** Resolution step, for the layers read from a prompt file. */
  origin?: "own" | "inherited" | "fallback" | "off";
  /** Workspace key the content comes from, "" for the shipped template. */
  from?: string;
  /** Present when the layer is editable: what to open in the instructions editor. */
  edit?: { workspace: string; file: string };
}

/** A nested AGENTS.md this conversation's runs injected. Editable through instructions.set. */
export interface MyClawAppInstructionNested {
  path: string;
  label: string;
  bytes: number;
  count: number;
  firstAt: string;
  lastAt: string;
  missing: boolean;
  /** True when this session turned the file off: it is never injected, and the page greys it. */
  disabled?: boolean;
}

export interface MyClawAppSessionInstructions {
  agent: string;
  workspace: string;
  workspaceDir: string;
  model: string;
  backend: string;
  platform: string;
  totalBytes: number;
  layers: MyClawAppInstructionLayer[];
  nested: MyClawAppInstructionNested[];
  /** Layer ids the session turned off (agent, skills, tools, platform, runtime, suggested). */
  layersOff: string[];
  /** Skill names the session filtered out of the catalog. */
  skillsOff: string[];
  /** Every skill in scope, with the ones the session turned off flagged. Lets the page toggle more. */
  skills: Array<{ name: string; description: string; off: boolean }>;
  /** Long-term memory recall off for this session. */
  memoryRecallOff: boolean;
  /** What the page cannot show, stated rather than left to be guessed. */
  notes: string[];
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
  /** Display form of the delivery target: "local", "origin", or "my-claw-app:owner". */
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
  visibility: "global" | "workspace" | "private";
  /** Which workspace a `workspace`-visible agent is scoped to; absent means the default one. */
  workspaceKey?: string;
  model?: string;
  createdAt: string;
}

/**
 * Destructive, and not symmetric: `reset` archives the transcript and keeps identity plus
 * workspace, `kill` deletes the session outright. Both carry the conversation they are asked from,
 * which is the caller the visibility rule is applied to, and both answer with the resulting roster
 * -- the device renders what the server actually did rather than what it hoped for.
 */
export interface MyClawAppSubAgentsKill {
  type: "subagents.kill";
  threadId: string;
  parentThreadId: string;
}

export interface MyClawAppSubAgentsReset {
  type: "subagents.reset";
  threadId: string;
  parentThreadId: string;
}

/**
 * Which conversations a sub-agent has worked for. Asked from the sub-agent's own thread, with
 * `parentThreadId` naming the conversation the roster was read from -- the caller the visibility
 * rule is applied to, exactly as for kill and reset.
 */
export interface MyClawAppSubAgentsCallers {
  type: "subagents.callers";
  threadId: string;
  parentThreadId: string;
}

export interface MyClawAppSubAgentsCallersResult {
  type: "subagents.callers.result";
  threadId: string;
  callers: MyClawAppSubAgentCaller[];
}

export interface MyClawAppSubAgentCaller {
  sessionId: string;
  /** The thread id the app addresses that conversation by, absent when it is not an app thread. */
  threadId?: string;
  /** The conversation that created the agent, which the sheet offers first. */
  creator: boolean;
  firstAt: string;
  lastAt: string;
  runs: number;
  title?: string;
  /** Set instead of the entry being dropped, so a caller that is gone reads as unavailable. */
  unreachable?: "gone";
}

export interface MyClawAppSubAgentHandoffOutcome {
  sessionId: string;
  threadId?: string;
  ok: boolean;
  /** Why it did not land, for a target the owner asked for and the server refused. */
  error?: string;
}

/**
 * Hands one message of a sub-agent back to the conversations that called it.
 *
 * A sub-agent's answer reaches its parent only because a `spawn`/`send` tool call is awaiting it.
 * When the owner is the one chatting, nothing is awaiting, so the return has to be asked for --
 * docs/subagent-navigation.md, "Constraint 3". `targets` is a list because one answer can be owed
 * to several conversations; `mode` decides whether each target runs on it or merely files it.
 */
export interface MyClawAppSubAgentsHandoff {
  type: "subagents.handoff";
  threadId: string;
  parentThreadId: string;
  /** Session ids taken from `subagents.callers.result`, never free-form. */
  targets: string[];
  /** Which message to hand back. Absent means the sub-agent's last answer. */
  messageId?: string;
  note?: string;
  mode: "ask" | "note";
}

export interface MyClawAppSubAgentsHandoffResult {
  type: "subagents.handoff.result";
  threadId: string;
  delivered: MyClawAppSubAgentHandoffOutcome[];
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

/** The server's own version, sent once as the socket opens so the app can label its connection. */
export interface MyClawAppHello {
  type: "hello";
  version: string;
}

/** The thread's history is gone; the app drops its copy instead of guessing from an empty list. */
export interface MyClawAppChatCleared {
  type: "chat.cleared";
  threadId: string;
}

/** Pairing socket: the code and the digits the owner compares with the approving device. */
export interface MyClawAppPairChallenge {
  type: "pair.challenge";
  code: string;
  verification: string;
  expiresAt: number;
  /** The claim URL as an SVG QR, drawn server-side so the shell ships no encoder. */
  qrSvg?: string;
  /** Presented in `pair.hello.resume` to pick this challenge back up. Never shown to a human. */
  resumeToken: string;
}

/** Pairing socket: somebody has looked this code up and is deciding. */
export interface MyClawAppPairPending {
  type: "pair.pending";
  approver: string;
}

/** Pairing socket: the credential, delivered once, on the socket that raised the challenge. */
export interface MyClawAppPairGranted {
  type: "pair.granted";
  deviceId: string;
  owner: string;
  name: string;
  /** Browsers: single-use, exchanged for a cookie at POST /my-claw-app/session. */
  grant?: string;
  /** Native clients: the device token itself, since they hold no cookie jar. */
  token?: string;
}

export interface MyClawAppPairDenied {
  type: "pair.denied";
  reason: "denied" | "expired" | "attempts" | "disabled" | "unknown";
}

/** Chat socket: what an approver sees before deciding. Never carries a credential. */
export interface MyClawAppDevicePairInfo {
  type: "device.pair.info";
  code: string;
  verification: string;
  origin?: string;
  ip?: string;
  userAgent?: string;
  expiresAt: number;
}

export interface MyClawAppDevicePairResult {
  type: "device.pair.result";
  ok: boolean;
  deviceId?: string;
  error?: string;
}

export interface MyClawAppDeviceRecordFrame {
  deviceId: string;
  name: string;
  kind: "app" | "web";
  owner: string;
  enabled: boolean;
  createdAt?: string;
  lastSeenAt?: string;
  /** True for the device asking: the UI refuses to let it revoke itself by accident. */
  self?: boolean;
}

export interface MyClawAppDeviceListResult {
  type: "device.list.result";
  devices: MyClawAppDeviceRecordFrame[];
}

export interface MyClawAppDeviceRevokeResult {
  type: "device.revoke.result";
  ok: boolean;
  deviceId: string;
  error?: string;
}

export type MyClawAppServerFrame =
  | MyClawAppChatMessage
  | MyClawAppChatUser
  | MyClawAppLocationCapabilities
  | MyClawAppLocationPreviewResult
  | MyClawAppChatLocation
  | MyClawAppRunStart
  | MyClawAppRunEnd
  | MyClawAppStreamStart
  | MyClawAppStreamDelta
  | MyClawAppReasoningDelta
  | MyClawAppReasoningTokens
  | MyClawAppStreamDone
  | MyClawAppStreamAbort
  | MyClawAppToolCall
  | MyClawAppToolStart
  | MyClawAppToolDelta
  | MyClawAppChatToolFull
  | MyClawAppSpawnStart
  | MyClawAppSpawnEnd
  | MyClawAppApprovalRequest
  | MyClawAppApprovalResolved
  | MyClawAppApprovalHistoryResult
  | MyClawAppSessionListResult
  | MyClawAppSessionWorkspaceSetResult
  | MyClawAppDraftChanged
  | MyClawAppCommandsResult
  | MyClawAppFilesListResult
  | MyClawAppDiagSnapshotResult
  | MyClawAppLogsTailResult
  | MyClawAppChatHistory
  | MyClawAppSessionSyncResult
  | MyClawAppVoiceModeResult
  | MyClawAppUiPrefsResult
  | MyClawAppUpdateResult
  | MyClawAppModelListResult
  | MyClawAppModelRefreshResult
  | MyClawAppModelEndpointsResult
  | MyClawAppSkillsListResult
  | MyClawAppToolsListResult
  | MyClawAppWorkspacesListResult
  | MyClawAppMcpListResult
  | MyClawAppInstructionsListResult
  | MyClawAppInstructionsFile
  | MyClawAppInstructionsSaved
  | MyClawAppModelResult
  | MyClawAppCommandPending
  | MyClawAppCommandResult
  | MyClawAppChatQueued
  | MyClawAppChatAcked
  | MyClawAppStatusResult
  | MyClawAppSessionInstructionsResult
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
  | MyClawAppSubAgentsCallersResult
  | MyClawAppSubAgentsHandoffResult
  | MyClawAppNotificationsInfo
  | MyClawAppHello
  | MyClawAppTagsResult
  | MyClawAppProviderEnvResult
  | MyClawAppPairChallenge
  | MyClawAppPairPending
  | MyClawAppPairGranted
  | MyClawAppPairDenied
  | MyClawAppDevicePairInfo
  | MyClawAppDevicePairResult
  | MyClawAppDeviceListResult
  | MyClawAppDeviceRevokeResult
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

/**
 * The chat card id for a tool call, derived from the id the model gave the call.
 *
 * One helper for both paths on purpose. The live stream and the history builder each used to mint
 * their own -- `<turnId>:tool:<n>` and `h-<ts>-<n>` -- so the two never matched, and a tool that
 * finished after a page reload appended a second card next to the one history had drawn. Returns
 * undefined when the provider supplied no call id, leaving each caller its own fallback.
 */
export function toolCardId(modelCallId: string | undefined): string | undefined {
  return modelCallId ? `t-${modelCallId}` : undefined;
}
