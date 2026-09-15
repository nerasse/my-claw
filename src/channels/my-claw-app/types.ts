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
  /**
   * The entry id just before which the older page starts: the client's oldest held item (a tool
   * card may carry its call id instead). Preferred over `before` where supported, because it
   * stays exact when the session grows between loads and when the client trims its oldest items
   * -- docs/session-log.md, and the app's own history paging.
   */
  beforeId?: string;
  /**
   * Whether a finished run may travel as a summary rather than as its items --
   * docs/run-hydration.md. Per request rather than announced once on the connection: the client
   * asks for what it is about to draw, an older client never sets it and gets what it always
   * got, and there is no hello to race with the first page.
   */
  fold?: boolean;
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
  /**
   * Whether a finished run may travel as a summary rather than as its items --
   * docs/run-hydration.md. Only the fresh window folds: a delta is work the client is watching
   * arrive, item by item.
   */
  fold?: boolean;
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

/**
 * Asks for the items a folded run row stands for -- docs/run-hydration.md.
 *
 * The other half of the fold, and the same trade `chat.tool.full` already makes: the page carries
 * a header, the reader who opens the group pays for its work. Bounded by the two ids the row
 * itself carries, not by a run id: a run cut by a page boundary folds into one row per page, and
 * answering with the whole run would splice items the client already holds.
 */
export interface MyClawAppSessionRunItems {
  type: "session.run.items";
  threadId: string;
  /** The row id (`run-<entryId>`) or the bare entry id: the first item the row stands for. */
  fromId: string;
  /** The row's `lastId`: the final item it stands for, included. */
  untilId: string;
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

export interface MyClawAppQuestionOption {
  label: string;
  description?: string;
}

export interface MyClawAppQuestionInfo {
  header: string;
  question: string;
  options: MyClawAppQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** A `question` tool call asking the owner: one sheet, N questions, answered as a batch. */
export interface MyClawAppQuestionAsk {
  type: "question.ask";
  id: string;
  threadId: string;
  questions: MyClawAppQuestionInfo[];
  /** The card the tool call sits on; not every run has one. */
  replyToId?: string;
  ts: string;
}

/** The owner answered: one array of selected labels per question, in order. */
export interface MyClawAppQuestionReply {
  type: "question.reply";
  id: string;
  answers: string[][];
}

/** One pending question, as `question.pending` carries it: an ask without the frame envelope. */
export type MyClawAppQuestionPendingEntry = Omit<MyClawAppQuestionAsk, "type">;

/**
 * Every question of this owner still waiting for an answer, sent at connect.
 *
 * Authoritative and idempotent: the client replaces its whole pending set with `entries`. An ask
 * broadcast while the socket was down is therefore not lost, and a card left behind by a server
 * that died holding a question is cleared by the empty list that follows the restart.
 */
export interface MyClawAppQuestionPending {
  type: "question.pending";
  entries: MyClawAppQuestionPendingEntry[];
}

/** The question is closed without an answer: stopped, or a message typed instead. */
export interface MyClawAppQuestionResolved {
  type: "question.resolved";
  id: string;
  threadId: string;
  reason: "answered" | "canceled";
}

/** A `/undo` without an argument: the server asks which mode instead of guessing. */
export interface MyClawAppUndoPrompt {
  type: "undo.prompt";
  /** Pending undo id; echoed back in `undo.choose`. */
  id: string;
  threadId: string;
  /** The user turn being undone, clipped for the sheet. */
  turnPreview: string;
  /** Precomputed file diff, per depot. Empty = nothing to restore, the sheet says so. */
  diff: Array<{ root: string; additions: number; deletions: number }>;
  ts: string;
}

/** The owner picked a mode in the undo sheet. */
export interface MyClawAppUndoChoose {
  type: "undo.choose";
  id: string;
  mode: "soft" | "hard";
}

/** The owner dismissed the undo sheet: the prompt resolves as canceled, nothing happens. */
export interface MyClawAppUndoCancel {
  type: "undo.cancel";
  id: string;
}

/** The undo sheet was dismissed, or the pending request expired. */
export interface MyClawAppUndoResolved {
  type: "undo.resolved";
  id: string;
  threadId: string;
  reason: "chosen" | "canceled";
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

/**
 * The answer to `ping`, and the only thing that proves the link is still two-way.
 *
 * The browser client has no transport-level ping (the JS API exposes none), so it watched
 * `bufferedAmount` instead. That does not work: fifteen bytes reach the kernel buffer of a socket
 * whose peer is long gone, the count returns to zero, and the page reported `connected` while
 * every frame fell in a hole. Now the ping expects a reply, and two unanswered ones close it.
 */
export interface MyClawAppPong {
  type: "pong";
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
  base?: "general" | "research" | "browser";
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

/**
 * Removes a provider. Refused while anything still references it, unless `withModels` says to drop
 * those references in the same write -- the curated models declared under it, and the
 * default-provider role when it holds it.
 */
export interface MyClawAppProviderRemove {
  type: "providers.remove";
  key: string;
  withModels?: boolean;
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
  /**
   * Milliseconds this model may go without sending a byte. `0` means no timer at all, so the
   * owner's Stop is the only wall: a value, not an absence, and it survives the round trip for
   * that reason. See docs/llm-timeout.md.
   */
  timeoutMs?: number;
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
  | MyClawAppBrowserInfo
  | MyClawAppChatSend
  | MyClawAppLocationPreview
  | MyClawAppSessionList
  | MyClawAppCommandsList
  | MyClawAppFilesList
  | MyClawAppFileDelete
  | MyClawAppFsList
  | MyClawAppFsRead
  | MyClawAppFsWrite
  | MyClawAppFsMkdir
  | MyClawAppFsMove
  | MyClawAppFsRemove
  | MyClawAppFsWatch
  | MyClawAppFsUnwatch
  | MyClawAppFsSessionRoot
  | MyClawAppSessionHistory
  | MyClawAppSessionSync
  | MyClawAppToolFull
  | MyClawAppSessionRunItems
  | MyClawAppSessionArchive
  | MyClawAppSessionUnarchive
  | MyClawAppSessionDelete
  | MyClawAppSessionPin
  | MyClawAppSessionPinOrder
  | MyClawAppDraftSet
  | MyClawAppModelRefresh
  | MyClawAppApprovalResponse
  | MyClawAppApprovalHistory
  | MyClawAppQuestionReply
  | MyClawAppUndoChoose
  | MyClawAppUndoCancel
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
  | MyClawAppStatusWatch
  | MyClawAppStatusUnwatch
  | MyClawAppStatsGet
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
  /** Whole output rather than a chunk, replaced by the client. See MyClawAppStreamDelta.replay. */
  replay?: boolean;
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

/**
 * The run an entry belongs to -- docs/run-grouping.md.
 *
 * Computed server-side by folding the branch between `run_start` and `run_end` markers, so a
 * client groups a finished run's work under one collapsed header without ever seeing the markers.
 * `running` means the run is still in flight (or its end was lost to a crash).
 */
export interface MyClawAppRunMeta {
  /**
   * The run's id, the one `chat.run.start` announced it under (the run context's correlation id).
   * A run recorded before 0.6.3 is named after its `run_start` entry instead.
   */
  id: string;
  status: "running" | "done" | "aborted" | "error";
  startTs: string;
  endTs?: string;
}

/**
 * A finished run's work, standing in for the items it folds -- docs/run-hydration.md.
 *
 * Sent in place of the folded items, at the position the first of them held, and only to a
 * client that asked for it (`fold` on the request). Everything the collapsed header draws is
 * here and nothing else: the items themselves are fetched with `session.run.items` when the
 * reader opens the group. Measured on a 12 034-entry session, this is what turns a 1 068 KB
 * page into a 21 KB one.
 */
export interface MyClawAppRunSummaryEntry {
  /** `run-<runId>`: the row id the client holds, and the paging cursor it sends back. */
  id: string;
  role: "run";
  ts: string;
  run: MyClawAppRunMeta;
  /** Tool calls in the whole run, whatever this page holds of it: the header counts them. */
  toolCount: number;
  /** Display name of the run's first tool, for the header line. */
  firstTool?: string;
  /** Folded rows, so the group can draw a skeleton the size of what is coming. */
  itemCount: number;
  /**
   * The last entry this row stands for. With `id`, it bounds exactly what hydration must return:
   * a run cut by a page boundary folds into one row per page, and without the bound the server
   * would hand back the whole run and the client would splice items it already holds.
   */
  lastId: string;
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
      /** How long that thinking lasted, so a reopened thread shows the span it took. */
      reasoningMs?: number;
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
      /**
       * The rule stands for a compaction that was stopped: nothing was folded, the summary never
       * landed, and `summaryOf` counts the turns the plan was about to cover -- all of them still
       * on the thread, in full. Drawn like the boundary, with "kept" where a summary landed; the
       * `summaryOf` is also what keeps it hoisted out of a run group, so the rule never becomes a
       * bubble.
       */
      compactionStopped?: boolean;
      /**
       * How long the summary took to write, in milliseconds. Carried to the replayed boundary for
       * the same reason the thinking span is: the duration is a fact about the turn, and a thread
       * reopened an hour later cannot re-measure it -- docs/reasoning-visibility.md.
       */
      compactionMs?: number;
      /** The run this entry belongs to, when it sits inside one. */
      run?: MyClawAppRunMeta;
    }
  | ({ role: "tool"; ts: string } & MyClawAppToolCallEntry & { run?: MyClawAppRunMeta })
  | MyClawAppRunSummaryEntry;

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

/**
 * A compaction just cut the prompt, drawn while the owner is looking at it.
 *
 * `/compact` has always answered with a bubble of its own, but an automatic pass had nothing on
 * the wire: the boundary existed on disk and only surfaced at the next history load, so a thread
 * compacted mid-run appeared to have lost its middle for no stated reason.
 *
 * Shaped like the boundary a replayed history builds, and carrying the *entry* id, so the device
 * that drew it live and the same device reloading the thread name one thing and not two.
 *
 * Never accompanied by a notification or a ring, by design: a compaction the owner did not ask
 * for is not an event he has to be told about (docs/notifications.md).
 */
export interface MyClawAppChatCompaction {
  type: "chat.compaction";
  threadId: string;
  /** The `compaction` entry's id, which is what the history replays it under. */
  id: string;
  /** The summary the model was handed, folded under the rule in the app. */
  summary: string;
  /** Turns the summary stands for. They stay on disk and stay on screen, above the rule. */
  count: number;
  ts?: string;
}

/**
 * A compaction is running on this thread, or has just stopped.
 *
 * The operation takes one to two minutes with nothing on the wire, and the only thing that ever
 * showed it was the placeholder bubble `/compact` draws on the device that typed it. Every other
 * window, and that same window after a reload, saw a thread doing nothing -- so the owner typed
 * `/compact` again and was answered "a compaction is already running on this session".
 *
 * A state and not an event: it is broadcast when it flips, and replayed to a window that arrives
 * mid-operation (`live-turn.ts`), which is why it carries the instant it began rather than an
 * elapsed time. The automatic gates raise it too; the speculative pass deliberately does not,
 * because a summary that may never be claimed is not a rewrite in progress (docs/compaction.md).
 */
export interface MyClawAppChatCompacting {
  type: "chat.compacting";
  threadId: string;
  /** ISO instant the operation began. Absent means it is over. */
  since?: string;
  /**
   * The summary written so far, on a replayed frame only.
   *
   * A window that reloads mid-compaction gets one frame with the text accumulated up to that
   * point; the live fragments come as `chat.compacting.delta` and the client appends them.
   */
  text?: string;
  /**
   * What the summarizer has thought so far, on a replayed frame only.
   *
   * Same contract as `text`, for the phase that comes before it: a compaction that inherited the
   * session's effort thinks for a while with nothing to show, and a window opening into that must
   * be told the wait is progress rather than a stall.
   */
  reasoning?: string;
}

/** A fragment of what a compaction is writing or thinking, live. */
export interface MyClawAppChatCompactingDelta {
  type: "chat.compacting.delta";
  threadId: string;
  /** A piece of the summary. */
  text?: string;
  /** A piece of the thinking that precedes it. */
  reasoning?: string;
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

/**
 * A stop was claimed on this thread: the work it aborts has not departed yet.
 *
 * One frame per cycle, and only for the claim that answered "stopped" -- a second stop of the
 * same cycle answers "stopping" and draws nothing. The work departing is what takes it down:
 * the matching `chat.run.end` (a stopped run ends `aborted`) or the end of a compaction hold,
 * and a window that syncs before then is replayed it (docs/live-turn-replay.md). The run id is
 * the one `chat.run.start` announced, absent when the stop hit a cycle with no run of its own
 * (a compaction).
 */
export interface MyClawAppRunStopping {
  type: "chat.run.stopping";
  threadId: string;
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
  /**
   * Set only on a replay, where `text` is the bubble's whole text rather than one more chunk.
   * The client replaces instead of appending: a window that still holds the bubble it was
   * watching would otherwise concatenate the turn onto itself -- docs/live-turn-replay.md.
   */
  replay?: boolean;
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
  /** Whole text rather than a chunk, replaced by the client. See MyClawAppStreamDelta.replay. */
  replay?: boolean;
  /**
   * ISO instant this thinking phase began, on the frame that opens it and on the replay of that
   * frame. An instant and not an elapsed time, for the reason MyClawAppChatCompacting.since carries
   * one: the client dates the span from it, so a window that reloads mid-thought resumes the
   * counter where it stands instead of restarting it at zero.
   *
   * The frames that follow within the phase carry nothing: the client already has the instant, and
   * a second one would move the start of a span that is still running.
   */
  since?: string;
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
  /** ISO instant this thinking phase began. Same rule as MyClawAppReasoningDelta.since: a redacted
   *  engine reports a count and no text, and the span is just as long. */
  since?: string;
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

/** One pending approval, as `approval.pending` carries it: a request without the frame envelope. */
export type MyClawAppApprovalPendingEntry = Omit<MyClawAppApprovalRequest, "type">;

/**
 * Every approval of this owner still waiting for an answer, sent at connect.
 *
 * Authoritative and idempotent, exactly like `question.pending`: the client replaces its whole
 * pending set with `entries`. A sheet is broadcast once, and the live turn journal only replays
 * it to a `session.sync` of the thread it belongs to -- so an approval raised on another thread,
 * or while the device was asleep, was never asked again. The tool then sat out its two minutes
 * and was denied without the owner ever seeing the question. The empty list matters as much: it
 * clears a sheet left behind by a server that restarted while holding one.
 */
export interface MyClawAppApprovalPending {
  type: "approval.pending";
  entries: MyClawAppApprovalPendingEntry[];
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
  /** Echo of the request id cursor; absent means the server did not honour `beforeId`. */
  beforeId?: string;
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
  /**
   * The compaction running on this thread, when one is.
   *
   * Present or absent on every answer, and the absence is what carries the information: the end
   * of a compaction is broadcast once, to the windows connected at that second, so one that was
   * down would otherwise keep drawing the rule -- counter still climbing -- until something
   * unrelated took it down. A client applies this state in both directions.
   */
  compacting?: { since: string; text?: string; reasoning?: string };
  /** Why the delta was replaced by a full page. */
  reset?: "unknown-cursor" | "branch-switch";
  /** Whether entries were truncated by the limit. */
  truncated?: boolean;
  /**
   * Whether anything remains before the window just served. Only on a full page (fresh open or
   * reset, not truncated): that is when the client replaces its held thread and needs a paging
   * cursor -- the delta path leaves the client's own cursor standing.
   */
  hasMore?: boolean;
  /** What the client requests next to get the page just older than the window. */
  nextBefore?: number;
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
 * The answer to `session.run.items`: the work a folded row stood for, in the same shapes a page
 * of history uses, so the client splices them in place of the row and renders nothing new.
 *
 * `found` false is a range the current branch no longer holds: a compaction dropped the turn, or
 * a rewind moved to another branch. The group then says so and stays collapsed rather than
 * emptying itself in silence. It is also the answer to a range wider than any page, which no row
 * this server minted can ask for.
 */
export interface MyClawAppChatRunItems {
  type: "chat.run.items";
  threadId: string;
  /** Echoed exactly as asked, because that is the row the client has to replace. */
  fromId: string;
  messages: MyClawAppHistoryEntry[];
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
  | "fs"
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
  | "stats"
  | "jobs"
  | "subagents"
  | "notifications"
  | "tags"
  | "providers"
  | "browser";

export interface MyClawAppError {
  type: "error";
  message: string;
  scope: MyClawAppErrorScope;
  /**
   * What actually went wrong, when the handler has it. The message is the operation that failed
   * ("providers.remove failed"), which is not an answer a screen can act on: it names nothing and
   * nothing to fix. Screens prefer this when it is present, and it may carry the config-edit
   * refusal verbatim (which models still reference the entry, for instance).
   */
  detail?: string;
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
  /**
   * The request budget this model declares, in milliseconds, absent when it declares none (the
   * transport default then applies). Carried so the declaration form shows what is stored instead
   * of an empty field over a real setting. See docs/llm-timeout.md.
   */
  timeoutMs?: number;
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
 * Where the effort a run sends comes from: session > tag > agent/scope > the global default > what
 * the API or the provider does on its own. `unsupported` means the model takes none at all.
 */
export type MyClawAppEffortSource =
  | "session"
  | "tag"
  | "scope"
  | "config"
  | "api-default"
  | "provider-default"
  | "unsupported";

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
 * Which of the three picks a thread's model: this chat's own, an agent pin (from the config or from
 * an agent file), or the global default.
 */
export type MyClawAppModelSource = "session" | "agent" | "agent-file" | "global";

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
  source?: MyClawAppModelSource;
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
  base?: "general" | "research" | "browser";
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
  /**
   * The command's input bubble is noise (undo, retry, branches): the app must drop the
   * optimistic bubble it drew at send, so only the result remains -- live and on refresh,
   * where the server replays the quiet entry as the result bubble alone.
   */
  dropInput?: boolean;
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
 * The transport receipt of a `chat.send`, to the socket that sent it and to it alone, before
 * anything is done with the message. A socket a NAT timeout or a VPN switch killed stays OPEN for
 * a browser, so a send can leave without arriving and nothing says so; the app waits for this
 * and offers to send again a message it never got one for. Sending again is safe: an id already
 * on the branch or parked in a run's mailbox is receipted and taken no further.
 */
export interface MyClawAppChatSendReceived {
  type: "chat.send.received";
  threadId: string;
  id: string;
}

/** One model as one session used it, priced when a price is on record. */
export interface MyClawAppUsageModelRow {
  model: string;
  /**
   * Where the calls went, as precisely as the record allows: the endpoint pin's provider for a
   * routed OpenRouter call (`streamlake`), otherwise the host of the base that was reached
   * (`api.anthropic.com`, `claude-sdk`). Two rows that share a model id and differ here are two
   * providers billed at two rates (docs/status-command.md).
   */
  provider: string;
  /**
   * The rest of the endpoint pin, when it has one: the quantization or service tier the route was
   * served as (`fp8`, `global/flex`). Never part of the model name, which is what a name taken from
   * the whole reference used to read (`fp8`).
   */
  variant?: string;
  /**
   * How the provider behind `provider` spells its own name (`Z.AI`, `Amazon Bedrock`). Decoration
   * beside the tag, never instead of it: the tag is the key the rows are grouped and merged on, and
   * the name is only known while OpenRouter's catalogue is cached, so the same route reported twice
   * can carry it once. Absent on a cold catalogue, and on anything OpenRouter does not front.
   */
  providerName?: string;
  calls: number;
  errors: number;
  promptTokens: number;
  cacheReadTokens: number;
  completionTokens: number;
  /** Absent when the model has no price on record. */
  costUsd?: number;
  /** A charge (pay-as-you-go endpoint), as opposed to a reference price. */
  costBilled: boolean;
  /** Priced from a neighbouring model id, not this one. */
  costApproximate: boolean;
  /**
   * Which rung of the price ladder answered, so a surprising figure can be explained: the cost
   * frozen on the row when the call was made, a pinned endpoint's own tariff, the OpenRouter
   * catalogue, an engine, the base that was reached, or the cross-market median. Absent on a row
   * nothing could price.
   */
  costSource?: string;
}

/** Calls, tokens and money over one set of rows. */
export interface MyClawAppUsageTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  cacheReadTokens: number;
  completionTokens: number;
  /** What was charged: pay-as-you-go endpoints. */
  billedUsd: number;
  /** What it would have cost at list price: flat plans, subscriptions, self-hosted. Not a charge. */
  referenceUsd: number;
  /** Rows without a price on record: their tokens are counted, their money is not. */
  unpriced: number;
}

/** A sub-agent this conversation drove, with what it spent on this conversation's behalf. */
export interface MyClawAppUsageAgent extends MyClawAppUsageTotals {
  sessionId: string;
  /** The name it was spawned under; the id's tail once the session is gone. */
  displayName: string;
  /** The agent it was spawned as; absent once the session is gone. */
  type?: string;
  /** 1 for a sub-agent of this conversation, 2 for a sub-agent of one of those. */
  depth: number;
  /** The session still exists (not killed), so the conversation can be opened. */
  alive: boolean;
  running: boolean;
  rows: MyClawAppUsageModelRow[];
}

/**
 * Structured `/status` report, the only rendering: the app draws it as a page, pushed to every
 * page open on the conversation each time something in it moves (docs/status-command.md).
 */
export interface MyClawAppStatusPayload {
  /** Null when this thread has no session yet: nothing has ever been asked here. */
  session: {
    id: string;
    createdAt: string;
    lastActiveAt: string;
    /** Entries in the conversation's log. */
    turns: number;
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
    /**
     * Which of the three picked it: this chat's own model, an agent pin, or the default. Absent
     * when nothing resolved -- a stale override or a broken config -- so the page says so rather
     * than naming a pick that never happened.
     */
    source?: MyClawAppModelSource;
    /**
     * What runs here without a chat pin: the agent's configured default, else the global one. Sent
     * every time rather than only when the session overrides it, because a page that shows a
     * pinned model and not what it is pinned away from answers half the question.
     */
    defaultModel: string;
    /** The effort a run on this conversation would send, `""` when the model discards it. */
    effort: string;
    /**
     * The rung `effort` comes from. Sent beside the level rather than implied by it: "high" pinned
     * by this chat and "high" inherited from the global default are the same string and two
     * different states, and a row that shows the level alone cannot say which one is in force.
     */
    effortSource: MyClawAppEffortSource;
    selfHosted: boolean;
    contextLimit: number;
    /** Why the window is what it is ("declared", "capped from …", …). */
    contextNotes: string[];
    /**
     * The wall in force for one request and where it comes from, already spelled: `120s (default)`,
     * `900s (model)`, `none (Stop only)`. Rendered, not computed, because the transport default is
     * a server constant and the app has no business holding a copy -- docs/llm-timeout.md.
     */
    timeout: string;
  };
  context: {
    /** The provider's count on the last call; undefined until a call is recorded. */
    measured?: { tokens: number; pctOfLimit: number };
    /** chars/4 over the prompt as it stands: under-counts, kept because a drift from `measured` is a mis-tuning made visible. */
    estimated: number;
    /** What actually drives auto-compaction. */
    occupied: number;
    autoCompactOn: boolean;
    autoCompactThresholdPct: number;
    autoCompactThresholdTokens: number;
  };
  /**
   * What this conversation has spent, its own calls and every sub-agent it drove, from the
   * analytics of the last 90 days. Null while nothing at all was called.
   */
  usage: {
    /** Own plus every agent below: the one figure the page leads with. */
    total: MyClawAppUsageTotals;
    own: MyClawAppUsageTotals & {
      /** Wall time spent inside the API, own calls. */
      durationMs: number;
      rows: MyClawAppUsageModelRow[];
    };
    /** Depth-first: a sub-agent's own sub-agents follow it. */
    agents: MyClawAppUsageAgent[];
    /** Analytics keep 90 days. Set when the conversation is older: the figures start here, not at its creation. */
    since?: string;
  } | null;
  runtime: {
    /** The live run tree of this conversation: `main` at depth 0, each sub-agent below it. */
    runs: Array<{ label: string; depth: number; startedAt: string }>;
    /** A /compact holds the session: work in progress with no run node of its own. */
    compacting: boolean;
    verbose: boolean;
    approvedTools: string[];
  };
}

/**
 * The app opens the status page of a conversation: the report is sent now, then again every time
 * it moves, until `status.unwatch` or the socket closes. One page per socket: a second watch
 * replaces the first.
 */
export interface MyClawAppStatusWatch {
  type: "status.watch";
  threadId: string;
}

/** The app closed its status page. */
export interface MyClawAppStatusUnwatch {
  type: "status.unwatch";
}

/**
 * The windows the statistics page offers. `all` is the only one that reaches past the 90-day
 * retention wall, through the permanent monthly rollup -- see docs/stats-page.md.
 */
export type MyClawAppStatsPeriod = "7d" | "30d" | "90d" | "all";

/**
 * The app asks for the install-wide statistics over one period. Answered once with `stats.result`
 * and never pushed: this page is about everything, so no session event can say it moved.
 */
export interface MyClawAppStatsGet {
  type: "stats.get";
  period: MyClawAppStatsPeriod;
  /** Absent or empty is the whole window: the page opens unfiltered. */
  filter?: MyClawAppStatsFilter;
}

/**
 * What the report is narrowed to, each field a column of `api_calls`.
 *
 * Applied in SQL before the aggregation, so every figure on the page describes the same smaller
 * population: the totals are recomputed, never scaled down from pre-folded groups. `errorsOnly`
 * and `unpricedOnly` are row predicates too -- only the calls that failed, not the routes that
 * failed once.
 *
 * `provider` is a `base_url`. The page draws an endpoint pin where the model carries one
 * (`streamlake/fp8`), and that pin is part of the model id, so the `model` field narrows to it.
 */
export interface MyClawAppStatsFilter {
  model?: string;
  provider?: string;
  caller?: string;
  sessionId?: string;
  errorsOnly?: boolean;
  unpricedOnly?: boolean;
}

/**
 * The values a filter may be set to, over the window, ignoring the filter already on screen.
 *
 * Sent because the rows narrow when the report does: an option list built from the current answer
 * would shrink to the choice already made, and leave no way back to the others.
 */
export interface MyClawAppStatsFacets {
  models: string[];
  /** The hosts, as `base_url`: what the filter matches, not the pin the page draws. */
  providers: string[];
  callers: string[];
  sessions: MyClawAppStatsFacetSession[];
}

/** A conversation as the filter sheet offers it: the same label the ranking uses. */
export interface MyClawAppStatsFacetSession {
  sessionId: string;
  label: string;
  labelSource: MyClawAppStatsLabelSource;
  deleted: boolean;
}

/** Calls, tokens, money and API time over one set of rows. */
export interface MyClawAppStatsTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  /** Subsets of `promptTokens`, billed at their own rate. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What was charged: pay-as-you-go endpoints. */
  billedUsd: number;
  /** What it would have cost at list price: flat plans, subscriptions, self-hosted. Not a charge. */
  referenceUsd: number;
  /** Calls no rung of the pricing ladder could price: counted here, absent from the money. */
  unpriced: number;
  /** Wall time spent inside the API. */
  durationMs: number;
}

/** One model on one route. `provider` is the endpoint pin when there is one, else the host. */
export interface MyClawAppStatsModelRow extends MyClawAppStatsTotals {
  model: string;
  provider: string;
  /** How OpenRouter spells the provider tag. Decoration: `provider` is the key. */
  providerName?: string;
  /** The rest of the endpoint pin: a quantization or a service tier, never part of the model. */
  variant?: string;
}

/** One endpoint, every model it served folded together. */
export interface MyClawAppStatsProviderRow extends MyClawAppStatsTotals {
  provider: string;
  providerName?: string;
}

/** Where a session's label came from, so the page can render an id as an id. */
export type MyClawAppStatsLabelSource = "title" | "first-message" | "id";

/**
 * One conversation's spend, including the conversations that no longer exist on disk: their calls
 * outlive them, and a ranking that dropped them would not add up to the total above it.
 */
export interface MyClawAppStatsSessionRow extends MyClawAppStatsTotals {
  sessionId: string;
  /** The title if the session is alive, its opening message if the archive still has it, else the id. */
  label: string;
  labelSource: MyClawAppStatsLabelSource;
  /** The session is gone from disk. Its rows are not, and this is what says so. */
  deleted: boolean;
  firstAt: string;
  lastAt: string;
}

/** One day of the window. Bounded by `detailSince`: the rollup is monthly and cannot fill a day. */
export interface MyClawAppStatsDayRow extends MyClawAppStatsTotals {
  /** `YYYY-MM-DD`. */
  date: string;
}

/**
 * How often one model, or one host, failed and how long it took.
 *
 * `avgDurationMs` and nothing finer: the rollup keeps sums, not distributions, so a percentile
 * would be available for the live window and silently missing for everything older.
 */
export interface MyClawAppStatsReliabilityRow {
  /** A model id when `kind` is `model`, a host when it is `provider`. */
  key: string;
  kind: "model" | "provider";
  calls: number;
  errors: number;
  errorRatePct: number;
  avgDurationMs: number;
}

/** How much of the input was served from cache, and how much was written into it. */
export interface MyClawAppStatsCache {
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `cacheReadTokens / promptTokens`, already a percentage. 0 when nothing was read. */
  readSharePct: number;
  /** `cacheWriteTokens / promptTokens`, already a percentage. */
  writeSharePct: number;
}

/** One caller: the orchestrator, the sub-agents it spawned, the browser, the compactions. */
export interface MyClawAppStatsCallerRow extends MyClawAppStatsTotals {
  caller: string;
}

/**
 * What a provider's own ledger says the key spent, beside what we recorded for it.
 *
 * One entry per provider that publishes a ledger, and only those: a host we can only compare with
 * itself is a row of the provider ranking, not a reconciliation. The gap is not an error to fix --
 * a key's counter runs from the day it was made, and a BYOK route is charged by the upstream
 * provider that the aggregator never billed for.
 *
 * Never a key, a key label, or anything else that identifies the credential: only the host and the
 * amounts are read from the provider's answer.
 */
export interface MyClawAppStatsReconciliation {
  /** The host the figures are about, as the page should name it (`openrouter.ai`). */
  provider: string;
  /** Our own rows for that host over the period, priced like every other figure on the page. */
  recordedUsd: number;
  /** How many recorded calls that sum covers. Zero is a reading: nothing went there. */
  calls: number;
  /** What the provider says the key spent since it was created. Absent when it was not read. */
  providerUsd?: number;
  /** `providerUsd - recordedUsd`, sent rather than subtracted on the page. Absent with it. */
  deltaUsd?: number;
  /** Credits bought minus credits spent. Absent when the provider publishes no balance. */
  balanceUsd?: number;
  /**
   * The ledger was not read, so the entry carries our sum alone. True for an API that is down and
   * for a cache nothing has warmed yet alike: the page never waits on a third party, so both are
   * the same statement -- we do not have their number right now.
   */
  providerUnread: boolean;
}

/**
 * Everything this install has spent, over one period.
 *
 * Two horizons, and the page must show both or it lies about one of them. `totals`, `models`,
 * `providers`, `reliability`, `cache` and `callers` reach back to `totalsSince` when the period is
 * `all`, because the purge folds every row it deletes into a permanent monthly rollup before
 * deleting it. `sessions` and `daily` stop at `detailSince`: the rollup has no session on its key
 * and no day in it, so nothing older can be broken down that way.
 */
export interface MyClawAppStatsPayload {
  period: MyClawAppStatsPeriod;
  /** Oldest per-call row still on disk. Everything below `sessions` and `daily` starts here. */
  detailSince?: string;
  /** First month (`YYYY-MM`) the rollup holds. Absent until a purge has run. */
  totalsSince?: string;
  /** The totals on this payload include rolled-up months. Only ever true for `all`. */
  rollupIncluded: boolean;
  totals: MyClawAppStatsTotals;
  /** Ranked by spend, billed first then reference. */
  models: MyClawAppStatsModelRow[];
  /** Ranked by spend. */
  providers: MyClawAppStatsProviderRow[];
  /** Ranked by spend. Bounded by `detailSince`. */
  sessions: MyClawAppStatsSessionRow[];
  /** Oldest day first. Bounded by `detailSince`. */
  daily: MyClawAppStatsDayRow[];
  /** Models first, then hosts; each half ranked by error rate. */
  reliability: MyClawAppStatsReliabilityRow[];
  cache: MyClawAppStatsCache;
  /** Ranked by calls. */
  callers: MyClawAppStatsCallerRow[];
  /** Empty when no provider with a readable ledger is configured. */
  reconciliation: MyClawAppStatsReconciliation[];
  /** What the report was narrowed to, echoed back so the page cannot claim a filter it did not get. */
  filter: MyClawAppStatsFilter;
  /** The values the filter may be set to, computed without it. */
  facets: MyClawAppStatsFacets;
}

/** The answer to one `stats.get`. */
export interface MyClawAppStatsResult {
  type: "stats.result";
  stats: MyClawAppStatsPayload;
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

/** The report of a watched conversation, on watch and at every change since. */
export interface MyClawAppStatusResult {
  type: "status.result";
  threadId: string;
  status: MyClawAppStatusPayload;
}

/**
 * The files page -- docs/files-page.md. One page over the whole machine: the owner reads and
 * edits any file the service user can reach, from the phone. The etag round trip is the conflict
 * contract of every write; text detection decides the metadata card; the encoding and eol a read
 * reports are what the write re-encodes with, so a latin1 file with accents and a CRLF file both
 * survive a save byte for byte.
 */

/** How the server read one file, and how `fs.write` must put it back. */
export type MyClawAppFsEncoding = "utf8" | "utf8-bom" | "latin1" | "utf16le" | "utf16be";

/** The file's dominant line ending, detected on the returned window. */
export type MyClawAppFsEol = "lf" | "crlf" | "mixed";

/** One row of a directory listing. */
export interface MyClawAppFsEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  /** Resolved kind when `kind` is "symlink" and it resolves; absent otherwise. */
  targetKind?: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
  /** Cheap extension-based guess, for the icon only. The truth comes from fs.read. */
  textHint: boolean;
}

export interface MyClawAppFsList {
  type: "fs.list";
  path: string;
}

/**
 * The listing, echoing the server's normalised path so the app can trust the breadcrumb it builds
 * from it. Entries are in readdir order: the app sorts, and sorting in two places is how a column
 * ends up disagreeing with itself. `truncated` is true past FS_LIST_LIMIT entries.
 */
export interface MyClawAppFsListResult {
  type: "fs.list.result";
  path: string;
  parent: string | null;
  entries: MyClawAppFsEntry[];
  truncated: boolean;
  /** The directory could not be read (gone, not a directory, unreadable): entries is empty. */
  error?: string;
}

export interface MyClawAppFsRead {
  type: "fs.read";
  path: string;
  /** Byte offset to continue a window at, as a previous answer's nextFrom. */
  from?: number;
  /** Window size; defaults to FS_READ_MAX. */
  maxBytes?: number;
}

/**
 * One window of one file.
 *
 * The stat fields (`etag`, `size`, `mtimeMs`) are absent only when the read failed outright;
 * `encoding`, `eol`, `text` and `lines` are absent for a binary file, where `binary` replaces
 * them and no text ever crosses the wire. `etag` is `${mtimeMs}-${size}` -- the conflict contract
 * of every write, deliberately cheap: a hash of a 200 MB log is not worth a save.
 */
export interface MyClawAppFsReadResult {
  type: "fs.read.result";
  path: string;
  etag?: string;
  size?: number;
  mtimeMs?: number;
  encoding?: MyClawAppFsEncoding;
  eol?: MyClawAppFsEol;
  text?: string;
  lines?: number;
  /** The offset this window starts at, and where a continuation starts, aligned to a line. */
  from: number;
  nextFrom: number | null;
  truncated: boolean;
  binary?: { reason: "nul" | "control" };
  error?: string;
}

/**
 * Writes one file back. `etag` must equal the file's current etag, else the write is refused with
 * `conflict` carrying the current state, and the app offers reload or `force: true`. The text is
 * re-encoded with `encoding` and `eol`, both defaulting to what a fresh read of the file reports.
 */
export interface MyClawAppFsWrite {
  type: "fs.write";
  path: string;
  text: string;
  etag: string;
  force?: boolean;
  encoding?: MyClawAppFsEncoding;
  eol?: MyClawAppFsEol;
}

export interface MyClawAppFsWriteResult {
  type: "fs.write.result";
  path: string;
  /** The file's state after the write; on a conflict, the state it has now. Absent on a hard failure. */
  etag?: string;
  size?: number;
  mtimeMs?: number;
  error?: string;
  conflict?: { etag: string; size: number; mtimeMs: number };
}

export interface MyClawAppFsMkdir {
  type: "fs.mkdir";
  path: string;
}

export interface MyClawAppFsMkdirResult {
  type: "fs.mkdir.result";
  path: string;
}

export interface MyClawAppFsMove {
  type: "fs.move";
  from: string;
  to: string;
}

export interface MyClawAppFsMoveResult {
  type: "fs.move.result";
  from: string;
  to: string;
}

export interface MyClawAppFsRemove {
  type: "fs.remove";
  path: string;
  recursive?: boolean;
}

export interface MyClawAppFsRemoveResult {
  type: "fs.remove.result";
  path: string;
}

export interface MyClawAppFsWatch {
  type: "fs.watch";
  path: string;
}

export interface MyClawAppFsUnwatch {
  type: "fs.unwatch";
  path: string;
}

/** Answer to fs.watch and fs.unwatch. `watching: false` also covers a watch that could not attach. */
export interface MyClawAppFsWatchResult {
  type: "fs.watch.result";
  path: string;
  watching: boolean;
}

/**
 * Push: the watched path moved. Coalesced server-side into one event per 250 ms window.
 *
 * `size`/`mtimeMs` are the state the stat found at emit time (0, 0 for a removed path), and they
 * are what lets a page tell its own save apart from a foreign write: the writer knows the state
 * its fs.write.result carried.
 */
export interface MyClawAppFsChanged {
  type: "fs.changed";
  path: string;
  kind: "changed" | "removed";
  size: number;
  mtimeMs: number;
}

/** The page opens from a conversation or a sub-agent: where does that session's tree start? */
export interface MyClawAppFsSessionRoot {
  type: "fs.session.root";
  threadId: string;
}

export interface MyClawAppFsSessionRootResult {
  type: "fs.session.root.result";
  threadId: string;
  path: string;
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
  /** The directory the agent's tools work in, which `workspaceKey` does not name. */
  workspaceDir?: string;
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

/**
 * The server's own version, sent once as the socket opens so the app can label its connection.
 * `receipts` says every `chat.send` is answered with `chat.send.received`: the app only waits for
 * a receipt from a server that gives one.
 */
export interface MyClawAppHello {
  type: "hello";
  version: string;
  receipts: true;
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

/**
 * What a human needs to take the browser over themselves. The VNC password is included: a paired
 * device already runs the agent, and therefore already reads that file through any shell it asks
 * for, so withholding it here would protect nothing and only send the owner to another machine.
 * See docs/browser-page.md.
 */
export interface MyClawAppBrowserInfo {
  type: "browser.info";
}

export interface MyClawAppBrowserService {
  unit: string;
  active: boolean;
}

export interface MyClawAppBrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface MyClawAppBrowserInfoResult {
  type: "browser.info.result";
  enabled: boolean;
  /** noVNC in a browser, and the host a native VNC client dials on port 5900. */
  webUrl?: string;
  vncHost?: string;
  vncPort: number;
  /** Absent when x11vnc runs without one, which the page has to state rather than imply. */
  password?: string;
  services: MyClawAppBrowserService[];
  tabs: MyClawAppBrowserTab[];
  /** The tabs could not be read; the rest of the answer is still valid. */
  tabsError?: string;
}

export type MyClawAppServerFrame =
  | MyClawAppPong
  | MyClawAppBrowserInfoResult
  | MyClawAppChatMessage
  | MyClawAppChatUser
  | MyClawAppChatCompaction
  | MyClawAppChatCompacting
  | MyClawAppChatCompactingDelta
  | MyClawAppLocationCapabilities
  | MyClawAppLocationPreviewResult
  | MyClawAppChatLocation
  | MyClawAppRunStart
  | MyClawAppRunEnd
  | MyClawAppRunStopping
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
  | MyClawAppChatRunItems
  | MyClawAppSpawnStart
  | MyClawAppSpawnEnd
  | MyClawAppApprovalRequest
  | MyClawAppApprovalPending
  | MyClawAppApprovalResolved
  | MyClawAppApprovalHistoryResult
  | MyClawAppQuestionAsk
  | MyClawAppQuestionPending
  | MyClawAppQuestionResolved
  | MyClawAppUndoPrompt
  | MyClawAppUndoResolved
  | MyClawAppSessionListResult
  | MyClawAppSessionWorkspaceSetResult
  | MyClawAppDraftChanged
  | MyClawAppCommandsResult
  | MyClawAppFilesListResult
  | MyClawAppFsListResult
  | MyClawAppFsReadResult
  | MyClawAppFsWriteResult
  | MyClawAppFsMkdirResult
  | MyClawAppFsMoveResult
  | MyClawAppFsRemoveResult
  | MyClawAppFsWatchResult
  | MyClawAppFsChanged
  | MyClawAppFsSessionRootResult
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
  | MyClawAppChatSendReceived
  | MyClawAppChatAcked
  | MyClawAppStatusResult
  | MyClawAppStatsResult
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
