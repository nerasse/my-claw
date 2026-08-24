import { readFile, mkdir, rename as fsRename, unlink, readdir, rm, rmdir, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative, sep } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import type { ChatLocation } from "../channels/types.ts";

/**
 * An image kept on the stored user turn so later turns can rebuild the same content blocks.
 * Only the path is kept, never the bytes: sessions are single JSON files rewritten in full on
 * every turn, and inlining base64 there would rewrite megabytes per message. The file lives in
 * the channel's own store and is re-read while it exists.
 */
export type SessionAttachment = { type: "image"; path: string; mimeType?: string };

export type SessionSubAgentStatus = "running" | "complete" | "error" | "aborted";

/** Display-only state for a sub-agent attached to a parent `spawn` tool call. */
export interface SessionSubAgentState {
  subagentId: string;
  displayName: string;
  agentType: string;
  mode: string;
  /**
   * Which tool opened this card: `spawn` created the sub-agent, `send` drove an existing one.
   * The lifecycle is identical either way -- this only decides the wording, so a `send` card is
   * not read as a second creation.
   */
  action: "spawn" | "send";
  status: SessionSubAgentStatus;
  resultLength?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type SessionSubAgentStateUpdate = Partial<Omit<SessionSubAgentState, "subagentId" | "status" | "startedAt">> & {
  subagentId: string;
  status: SessionSubAgentStatus;
  toolCallId?: string;
};

export type SessionMessage =
  | {
      role: "user";
      content: string;
      timestamp: string;
      attachments?: SessionAttachment[];
      location?: ChatLocation;
      /**
       * The channel's own id for the message that opened this turn, when it has one a client can
       * recognise (the my-claw-app `chat.send` id, which is also the bubble id on the device).
       * Display-only, and the reason a replayed page can be merged with what a device already
       * shows instead of replacing it: without it the same question is either duplicated or
       * dropped -- docs/my-claw-app-channel.md.
       */
      sourceId?: string;
      /**
       * How many turns this one summarises, set only on a compaction summary. The turns themselves
       * are still in `messages` right before it, so a channel can mark the boundary in the replayed
       * history instead of showing the summary as something the owner typed -- which is exactly how
       * it read before, a `[Prior context summarized]` block in the composer's own voice.
       */
      summaryOf?: number;
    }
  | {
      role: "assistant";
      content: string;
      timestamp: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: string;
        durationMs?: number;
        /** Display-only lifecycle state for a `spawn` call. Never sent back to a model. */
        spawn?: SessionSubAgentState;
      }>;
      /**
       * What the model thought before answering, for display only -- docs/reasoning-visibility.md.
       * It must never reach a model: both replay paths (`toChatMessages`,
       * `renderPriorConversation`) build their messages field by field, and a test on each asserts
       * this one is absent from the result.
       */
      reasoning?: string;
      /**
       * How much thinking this turn was estimated to have done, when the engine gives a count
       * instead of the text (the Claude bridge redacts it -- docs/reasoning-visibility.md). One
       * number, so the replayed bubble can still say the turn thought rather than losing it with
       * the live stream.
       */
      reasoningTokens?: number;
      /**
       * The same turn cut where the thinking restarted, set only when a single API call produced
       * more than one phase. The live stream closes its bubble when reasoning follows text, so
       * without these cuts a reopened conversation glues the phases back into one bubble with
       * every thought stacked on top -- docs/reasoning-visibility.md. Display only, like
       * `reasoning`: `content` stays the whole turn and is what any model ever reads.
       */
      segments?: Array<{ reasoning?: string; content: string }>;
    }
  | { role: "tool"; toolCallId: string; content: string; timestamp: string };

/**
 * The turns a model is allowed to see: `messages` from the compaction boundary onward.
 *
 * The one way to read a session for a prompt. `messages` is the whole conversation, boundary
 * included, because the app replays it and the owner's words are not the model's to discard; every
 * caller that builds a prompt goes through here instead, so restoring history can never widen what
 * a model reads. A boundary past the end (a session rewritten under a stale index) reads as no
 * boundary at all rather than an empty prompt. See docs/compaction.md.
 */
export function promptMessages(session: Pick<SessionData, "messages" | "promptBase">): SessionMessage[] {
  const base = session.promptBase ?? 0;
  if (base <= 0 || base >= session.messages.length) return session.messages;
  return session.messages.slice(base);
}

/**
 * Slicing history to a fixed tail (keep the last N) can cut inside a tool block, leaving the
 * kept head starting with orphan `tool` messages whose owning assistant `tool_calls` were
 * dropped. OpenAI-compatible APIs reject that with HTTP 400, wedging the session on every
 * subsequent turn. Dropping the leading orphan tool messages restores a valid boundary.
 */
export function dropLeadingOrphanToolMessages(messages: SessionMessage[]): SessionMessage[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === "tool") start++;
  return start === 0 ? messages : messages.slice(start);
}

/** What a synthetic tool result says when the run that owed the real one never came back. */
export const STOPPED_RESULT = "[Stopped by user]";
export const INTERRUPTED_RESULT = "[Interrupted: the run did not survive a restart]";

/**
 * Guarantee no assistant tool_call is left without a tool response.
 *
 * A run can stop between the tool request and its result -- the owner pressed stop, or the process
 * died. The assistant turn is already persisted at that point (it is written before the tools run,
 * and the autosave ticks every two seconds), so the file keeps a request nothing will ever answer.
 * OpenAI-compatible APIs reject such a prompt outright, which wedges every later turn on that
 * session: the conversation is dead, permanently, and nothing says why.
 *
 * Every assistant turn is scanned, not just the last: an abort settles the turn in flight, but a
 * file repaired at load may carry damage from an older crash, under turns written since.
 */
export function sealDanglingToolCalls(messages: SessionMessage[], reason: string = STOPPED_RESULT): number {
  let sealed = 0;
  // Backwards, so a splice never moves an index still to be visited.
  for (let i = messages.length - 1; i >= 0; i--) {
    const assistant = messages[i]!;
    if (assistant.role !== "assistant" || !assistant.toolCalls?.length) continue;

    // A turn's results are the run of `tool` messages right after it: the loop pushes them
    // together, and stopping at the first non-tool message is what keeps two turns apart.
    const answered = new Set<string>();
    let end = i + 1;
    for (; end < messages.length; end++) {
      const msg = messages[end]!;
      if (msg.role !== "tool") break;
      answered.add(msg.toolCallId);
    }

    const missing = assistant.toolCalls.filter((call) => !answered.has(call.id));
    if (missing.length === 0) continue;
    const timestamp = new Date().toISOString();
    messages.splice(
      end,
      0,
      ...missing.map((call) => ({ role: "tool" as const, toolCallId: call.id, content: reason, timestamp })),
    );
    sealed += missing.length;
  }
  return sealed;
}

/**
 * One slash command and the answer the channel showed for it. Commands never reach the router,
 * so nothing about them lands in `messages`: without this record a `/compact` or a `/stop` is
 * gone from the conversation the moment the app reloads its history from the server.
 *
 * Kept beside the messages rather than inside them on purpose. `messages` is the prompt on the
 * home loop, and a `/status` table replayed into the model is noise it would then summarize.
 */
export interface SessionCommandEntry {
  /** What was typed, arguments included and credentials masked (`redactCommandArgs`). */
  input: string;
  /** What the channel put on screen for it. Errors included: the owner saw those too. */
  output: string;
  timestamp: string;
  /** The aside folded under the bubble, when the answer carried one (a compaction summary). */
  details?: string;
  /**
   * The channel's own id for the send that typed this command, when it has one. Same purpose as
   * `sourceId` on a user turn: the replayed bubbles carry the ids the live ones had, so a page can
   * be merged into a thread already on screen without doubling anything.
   */
  sourceId?: string;
}

/**
 * Sessions changed in place since their last write.
 *
 * The autosave used to tell a dirty session from a clean one by its message count, which is blind
 * to every mutation that does not append: a tool duration written back, a sub-agent state settling,
 * a command journalled, a caller recorded, usage accumulated. Those survived a clean shutdown
 * (`flushAll` ignores the check) and were lost to a kill.
 *
 * A WeakSet rather than a field, so the mark never reaches the file, and set by the mutators
 * themselves rather than by their callers: a flag the caller must remember to raise is the same
 * bug one level up.
 */
const dirtySessions = new WeakSet<SessionData>();

export function markSessionDirty(session: SessionData): void {
  dirtySessions.add(session);
}

/** True when this session has an unwritten in-place change. Cleared by the write itself. */
export function isSessionDirty(session: SessionData): boolean {
  return dirtySessions.has(session);
}

export function clearSessionDirty(session: SessionData): void {
  dirtySessions.delete(session);
}

/**
 * Appends to a conversation's command journal.
 *
 * Nothing is dropped: a conversation keeps everything it was told, and the owner asked for the
 * caps to go. The file is rewritten in full on every turn, so the cost of a long journal is disk
 * and nothing else.
 */
export function recordSessionCommand(session: SessionData, entry: SessionCommandEntry): void {
  markSessionDirty(session);
  const journal = session.commands ?? [];
  journal.push(entry);
  session.commands = journal;
}

/** Long enough to carry an API error with its hint, short enough to stay a bubble. */
export const FAILURE_TEXT_LIMIT = 500;

export interface SessionFailureEntry {
  /** What the owner was shown when the run died, capped at `FAILURE_TEXT_LIMIT`. */
  error: string;
  timestamp: string;
}

/**
 * Appends to a conversation's failure journal.
 *
 * Its own journal rather than an assistant message, because on the home loop `session.messages`
 * *is* the prompt: a stored "run failed: API Error 529" would come back as something the agent
 * itself had said. This side is display-only, so the error survives a reopened thread without ever
 * reaching a model.
 */
export function recordSessionFailure(session: SessionData, error: string): void {
  const text = error.trim();
  if (!text) return;
  markSessionDirty(session);
  const journal = session.failures ?? [];
  journal.push({ error: text.slice(0, FAILURE_TEXT_LIMIT), timestamp: new Date().toISOString() });
  session.failures = journal;
}

export interface SubAgentMeta {
  displayName: string;
  /** The agent name this was spawned as. Open set since agents are file-defined, and the two names
   *  that used to be the whole union stay valid, so no stored session needs migrating. */
  type: string;
  workspaceDir?: string;
  // Session that spawned this agent. Recorded once, at creation, because parentage is a property
  // of the agent rather than of a run -- so it survives restarts and needs no argument threading.
  parentSessionId: string;
  // Sub-agents are addressable from any chat by default, which is the point. A private one is
  // only visible and drivable from parentSessionId, a workspace one from any conversation of
  // `workspaceKey`. One-shot agents are always private: they are unnamed and short-lived, and
  // were invisible before they had metadata at all.
  visibility: "global" | "workspace" | "private";
  /**
   * What the `workspace` visibility is scoped to, and set for that visibility alone: the key of
   * the conversation that spawned the agent, never the one it runs in (`workspaceDir`). The two
   * differ whenever `agents.<name>.workspace` pins the agent elsewhere, and an agent must stay
   * with the orchestrator that created it rather than follow where its filesystem points.
   * Absent means the default workspace, exactly like `SessionData.workspace`.
   */
  workspaceKey?: string;
  createdAt: string;
}

/**
 * A conversation that has driven this sub-agent at least once, newest activity first.
 *
 * `parentSessionId` records who created the agent, `invokedBy` who drove the last run and is
 * overwritten by the next one. Neither answers "which conversations is this agent working for",
 * which is the question the owner asks when handing an answer back: a global agent can serve
 * several, and the creator is not always among the ones still interested.
 */
export interface SubAgentCaller {
  sessionId: string;
  /** True for `meta.parentSessionId`: the conversation that created the agent. */
  creator: boolean;
  firstAt: string;
  lastAt: string;
  runs: number;
}

/**
 * Enough to cover the conversations one agent realistically serves, capped so a long-lived global
 * worker cannot grow its own session file without bound. The oldest activity is dropped first, and
 * the creator is never dropped -- it is the one entry the owner can always expect to see.
 */
const MAX_SUBAGENT_CALLERS = 20;

/** Records a run driven by `sessionId`. Returns true when the list changed. */
export function recordSubAgentCaller(session: SessionData, sessionId: string, now = new Date().toISOString()): boolean {
  if (!sessionId || !session.meta) return false;
  markSessionDirty(session);
  const callers = session.callers ?? [];
  const creator = sessionId === session.meta.parentSessionId;
  const existing = callers.find((c) => c.sessionId === sessionId);
  if (existing) {
    existing.lastAt = now;
    existing.runs += 1;
    existing.creator = existing.creator || creator;
  } else {
    callers.push({ sessionId, creator, firstAt: now, lastAt: now, runs: 1 });
  }
  callers.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  if (callers.length > MAX_SUBAGENT_CALLERS) {
    const kept = callers.filter((c) => c.creator).concat(callers.filter((c) => !c.creator));
    callers.length = 0;
    callers.push(...kept.slice(0, MAX_SUBAGENT_CALLERS));
    callers.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }
  session.callers = callers;
  return true;
}

/**
 * Who a session's API calls should be billed to, strongest evidence first: the session that
 * triggered this run, then the one that created the agent, then itself.
 *
 * Recording self rather than null for a top-level chat keeps `WHERE parent_session_id = ?`
 * rollups complete without a COALESCE, and makes a missing parent show up as an unattributed
 * agent instead of silently misfiling tokens onto the wrong conversation.
 */
/**
 * Which agent's settings apply to a stored session: its model, its context ceiling, its summarizer.
 * A run knows this from the message it is answering; anything working on a session alone (`/status`,
 * the compaction summarizer) has only the session, and reading it as the orchestrator's is how a
 * research sub-agent came to be summarized by the orchestrator's model.
 */
export function agentTypeOf(session: SessionData): string {
  if (session.platform === "cron") return "cron";
  return session.meta?.type ?? "main";
}

export function attributionParent(session: SessionData): string {
  // Truthiness, not nullish coalescing: callers default a missing session id to "", and an empty
  // parent is worse than no parent -- it would group unrelated work under a blank key.
  return session.invokedBy || session.meta?.parentSessionId || session.id;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  apiCalls: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Updates the display-only sub-agent state on the parent assistant tool call. The spawn event has
 * the model's tool call id, while terminal events only have the sub-agent id, so both are accepted.
 * A terminal state is sticky: a late duplicate or a lifecycle event from an already settled child
 * must not re-open the spinner in history.
 */
export function recordSessionSubAgentState(session: SessionData, update: SessionSubAgentStateUpdate): boolean {
  let target: { id: string; name: string; arguments: string; durationMs?: number; spawn?: SessionSubAgentState } | undefined;
  for (let i = session.messages.length - 1; i >= 0 && !target; i--) {
    const message = session.messages[i];
    if (message?.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if ((update.toolCallId && call.id === update.toolCallId) || call.spawn?.subagentId === update.subagentId) {
        target = call;
        break;
      }
    }
  }
  if (!target) return false;
  const current = target.spawn;
  if (current && current.status !== "running") return false;
  markSessionDirty(session);
  const now = new Date().toISOString();
  target.spawn = {
    subagentId: update.subagentId,
    displayName: update.displayName ?? current?.displayName ?? update.subagentId,
    agentType: update.agentType ?? current?.agentType ?? "unknown",
    mode: update.mode ?? current?.mode ?? "run",
    action: update.action ?? current?.action ?? "spawn",
    status: update.status,
    startedAt: current?.startedAt ?? now,
    ...(update.resultLength !== undefined ? { resultLength: update.resultLength } : current?.resultLength !== undefined ? { resultLength: current.resultLength } : {}),
    ...(update.error !== undefined ? { error: update.error } : current?.error !== undefined ? { error: current.error } : {}),
    ...(update.status === "running" ? {} : { finishedAt: current?.finishedAt ?? now }),
  };
  return true;
}

export interface SessionData {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
  messages: SessionMessage[];
  /**
   * Slash commands run on this conversation and their answers, in order. Not part of the
   * prompt and not part of `messages`: this is what the owner saw, kept so a reopened thread
   * shows it again. Dies with the session file, like everything else here.
   */
  commands?: SessionCommandEntry[];
  /**
   * Runs that died on this conversation, in order. Display-only and never part of a prompt: the
   * mirror keeps the question a failed run was given, this keeps why it got no answer, so a
   * reopened thread shows both instead of a message that looks ignored.
   */
  failures?: SessionFailureEntry[];
  /**
   * Name the owner gave this conversation. Absent means the list falls back to the opening
   * words of the first turn, which is a summary of how a thread started rather than of what it
   * became. Only the my-claw-app channel shows a thread list, so only it sets this.
   */
  title?: string;
  /**
   * When the owner filed this conversation away. Archiving is a flag, not a move: the history
   * stays exactly where it was, the thread simply leaves the main list for the archived one,
   * and clearing the flag brings it back untouched. Only the my-claw-app channel sets this.
   */
  archivedAt?: string;
  /**
   * Position of this conversation in the owner's pinned list, absent when it is not pinned.
   * Server-side because a pin is about finding a conversation again, and the owner reaches the
   * same conversations from the phone and from the browser: kept per device, each client had its
   * own private idea of what was pinned and in what order. Dense ranks starting at 0, rewritten
   * as a block on every reorder, so the field alone carries both facts (pinned, and where).
   */
  pinRank?: number;
  modelOverride?: string;
  effortOverride?: import("../core/config.ts").EffortLevel;
  /**
   * Effort of the scope this run belongs to (a cron job's own pin). Sits under the session's
   * `/effort` and under a tag's pin: it is the config of the run, not a per-chat choice. Never
   * persisted: the scheduler sets it from the job before each run, exactly like `scopeOverride`,
   * and a run session outlives its run (the app opens it as a chat), so a persisted copy would
   * outlive the job settings it was taken from.
   */
  scopeEffort?: import("../core/config.ts").EffortLevel;
  /**
   * Per-job scope of a cron run, set by the scheduler from the job's own fields and slotted
   * above `agents.cron` when the agent's scope is resolved. Never persisted: a cron session is
   * set again from the job before each run, so the override lives exactly as long as the run it
   * belongs to. The session file itself stays: `pruneSessions` keeps the last 25 per job.
   */
  scopeOverride?: {
    skills?: string[];
    mcp?: string[];
    tools?: string[];
  };
  /**
   * Key of the workspace this conversation runs in (config.workspaces). Absent = the default
   * workspace. Set at creation and changeable afterwards: a switch applies from the next run
   * onward, while the history keeps whatever workspace produced it. See docs/multi-workspace.md.
   */
  workspace?: string;
  // Context ceiling chosen for this conversation alone: "full" for the model's whole window, or an
  // explicit number that may also sit below the standing cap. Sub-agents are sessions too, so each
  // one carries its own independently of the chat that spawned it. See docs/context-window.md.
  contextOverride?: import("../llm/context-window.ts").ContextOverride;
  // Prompt size the provider actually billed on the last call, with the message count it covered.
  // The compaction gate needs a real number: chars/4 under-counts by ~2.3x on live traffic.
  lastPrompt?: import("../llm/context-window.ts").MeasuredPrompt;
  /**
   * System prompt plus tool schemas of the last prompt built, in tokens.
   *
   * Window a run occupies before a single message of history is counted, and nothing that reads the
   * history can derive it: it measured 33k here. The turn-start gate runs before the prompt for
   * that turn is assembled, so it reads the last one -- stale by a turn, the same compromise
   * `lastPrompt` already makes, and far closer than the zero it assumed before.
   */
  lastFixedTokens?: number;
  /**
   * Where the prompt starts inside `messages`: everything before it is summarised by the turn at
   * this index and is not sent to any model again.
   *
   * Compaction used to answer this by replacing the array outright. But `messages` is read by two
   * things that want opposite answers -- the loop, which wants what the model must see, and the
   * app's history, which wants what the owner wrote. Cutting served the first by destroying the
   * second: one conversation on this install went from ten days of history to nine messages, and
   * the summaries were the only trace left of the turns they replaced. A boundary answers both,
   * so nothing a human said is ever deleted to make room for a model.
   *
   * Absent means the whole array is the prompt. See docs/compaction.md.
   */
  promptBase?: number;
  roomId?: string;
  threadId?: string;
  verbose?: boolean;
  approvedTools?: string[];
  meta?: SubAgentMeta;
  /**
   * Conversations that have driven this sub-agent, for a sub-agent session only. Display-only and
   * never part of a prompt: this is what lets the owner hand an answer back to a caller instead of
   * guessing which conversation was waiting for it -- docs/subagent-navigation.md.
   */
  callers?: SubAgentCaller[];
  // Session that triggered the run currently executing, set by the runner before each run. A
  // global sub-agent can be driven from a chat other than the one that created it, so the creator
  // in `meta` is only a fallback: attribution follows whoever asked for this run.
  invokedBy?: string;
  tokenUsage?: TokenUsage;
  /**
   * Nested AGENTS.md this conversation's runs actually injected, in discovery order. The collector
   * is run-local by design (docs/nested-agents.md), so this is the only lasting trace of the
   * instructions a session picked up along the way, and what the app's instructions page lists.
   */
  nestedAgents?: import("../agent/prompt/nested-agents.ts").NestedAgentsRecord[];
  /**
   * Nested AGENTS.md paths this session turned off, by their absolute resolved identity. A
   * disabled file is never injected by the collector (even if a tool touches its directory) and
   * the item stays greyed out on the app's instructions page. Persisted on the session so the
   * choice survives restarts; the collector is run-local, so this list is the only memory of it.
   */
  nestedDisabled?: string[];
  /**
   * Prompt layers this session turned off, by layer id (`agent` mandate, `skills`, `tools`,
   * `platform`, `runtime`, `suggested`). The four workspace files go through `instructions` with
   * their own `wants` gates. An off layer is simply skipped during composition, and the app page
   * shows it as off. Persisted on the session. See docs/session-instructions.md.
   */
  promptLayersOff?: string[];
  /**
   * Skills this session filtered out, by skill name: they do not appear in the prompt catalog,
   * and list_skills/read_skill with `__agentType` in scope keep responding as if they were not
   * scoped to this session (they stay visible to other sessions and to the global run).
   * Persisted on the session.
   */
  skillsOff?: string[];
  /**
   * Long-term memory recall off for this session: turn-level memory injection is skipped, the
   * model never sees a memory block even if the store has matches. Persisted on the session.
   */
  memoryRecallOff?: boolean;
}

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const ARCHIVES_DIR = join(MY_CLAW_DIR, "sessions-archive");

function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeSessionId(raw: string): string {
  return raw.replace(/\.\./g, "_").replace(/\0/g, "");
}

/**
 * A cron run's session id is `cron/<jobId>/<runTs>`; thread ids come from the device and must
 * match a strict character set (no slash), so the app refers to a run session as
 * `cron-<jobId>-<runTs>`. The job id is 12 hex chars and the run ts digits, so the round-trip
 * is unambiguous. See docs/my-claw-app-channel.md (jobs.runs).
 */
export function cronSessionToThread(sessionId: string): string | null {
  const match = /^cron\/([0-9a-f]{12})\/(\d+)$/.exec(sessionId);
  return match ? `cron-${match[1]}-${match[2]}` : null;
}

export function cronThreadToSession(threadId: string): string | null {
  const match = /^cron-([0-9a-f]{12})-(\d+)$/.exec(threadId);
  return match ? `cron/${match[1]}/${match[2]}` : null;
}

/**
 * A sub-agent's session addressed as an app thread. Unlike cron there is no readable encoding
 * available: a thread id is `[A-Za-z0-9._-]{1,64}` (see the channel's THREAD_ID_PATTERN) while a
 * sub-agent id carries a model-chosen name that may hold any letter, so the handle is a digest of
 * the session id. See docs/subagent-navigation.md.
 */
export function subagentSessionToThread(sessionId: string): string | null {
  if (!sessionId.startsWith("subagent/")) return null;
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `sub-${digest}`;
}

/**
 * Reverse of the digest, by scanning the one directory the answer can be in. Synchronous because
 * both resolveSessionId contracts are, and deliberately uncached: the alternative is a map that
 * has to be invalidated on spawn, kill, reset and prune, and that can therefore disagree with the
 * directory. Only a `sub-` thread pays for the scan, and the caller reads the session file
 * immediately afterwards anyway.
 */
export function subagentThreadToSession(threadId: string): string | null {
  if (!/^sub-[0-9a-f]{16}$/.test(threadId)) return null;
  let names: string[];
  try {
    names = readdirSync(join(SESSIONS_DIR, "subagent"));
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = `subagent/${name.slice(0, -5)}`;
    if (subagentSessionToThread(sessionId) === threadId) return sessionId;
  }
  return null;
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    void log("warn", "corrupt session file, treating as empty", { sessionId, error: String(err) });
    return null;
  }
}

export async function saveSession(sessionId: string, data: SessionData): Promise<void> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  await writeJsonFileAtomically(path, data, true);
}

export async function deleteSessionFile(sessionId: string): Promise<void> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  try {
    await unlink(path);
  } catch {
    // file may not exist
  }
  // Nested session ids (cron/<jobId>/<runId>) leave an empty parent directory behind: rmdir
  // only removes empty dirs, so the call is safe when siblings still exist.
  const parent = dirname(path);
  if (parent !== SESSIONS_DIR) {
    await rmdir(parent).catch(() => {});
  }
}

export async function archiveSession(sessionId: string): Promise<string | null> {
  const safe = sanitizeSessionId(sessionId);
  const source = join(SESSIONS_DIR, `${safe}.json`);
  const target = join(ARCHIVES_DIR, safe, `${archiveTimestamp()}.json`);
  try {
    await mkdir(dirname(target), { recursive: true });
    await fsRename(source, target);
    hooks.emit("session:archived", { sessionId, archivePath: target });
    return target;
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

const SESSION_STALE_DAYS = 30;

/**
 * Channels whose sessions the owner sees listed, names by hand and expects to find again.
 * The app's drawer reads this very directory, so dropping a file after a quiet month made a
 * conversation vanish from a list the owner was still looking at. Chat platforms keep the
 * sweep: their sessions are transient per-chat state nobody browses.
 *
 * Sub-agents joined the list when the app started showing them: a named one is advertised as
 * re-invocable, and deleting it after a quiet month would break that promise silently. Reclaiming
 * the space is `kill_agent`, or the app's own delete. See docs/subagent-navigation.md.
 */
const PRUNE_EXEMPT_PREFIXES = [`my-claw-app${sep}`, `subagent${sep}`];

function isPruneExempt(filePath: string): boolean {
  const rel = relative(SESSIONS_DIR, filePath);
  return PRUNE_EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

export async function pruneOldSessions(): Promise<number> {
  const cutoffMs = Date.now() - SESSION_STALE_DAYS * 86_400_000;
  let removed = 0;
  try {
    const entries = await scanSessionFiles(SESSIONS_DIR);
    for (const { path: filePath, mtimeMs } of entries) {
      if (mtimeMs >= cutoffMs) continue;
      if (isPruneExempt(filePath)) continue;
      await rm(filePath, { force: true }).catch(() => {});
      removed += 1;
    }
  } catch {
    // sessions dir may not exist
  }
  return removed;
}

async function scanSessionFiles(dir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const results: Array<{ path: string; mtimeMs: number }> = [];
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await scanSessionFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const s = await stat(full).catch(() => null);
      if (s) results.push({ path: full, mtimeMs: s.mtimeMs });
    }
  }
  return results;
}

/** All persisted session ids under a prefix, most recently active first. */
export async function listSessionIdsByPrefix(prefix: string, limit = 50): Promise<string[]> {
  const files = await scanSessionFiles(SESSIONS_DIR);
  const ids: Array<{ id: string; mtimeMs: number }> = [];
  for (const { path, mtimeMs } of files) {
    if (!path.endsWith(".json")) continue;
    const rel = path.slice(SESSIONS_DIR.length + 1, -".json".length);
    const id = rel.replace(/\\/g, "/");
    if (id.startsWith(prefix)) ids.push({ id, mtimeMs });
  }
  return ids
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Remove every archive snapshot of a session (used by hard delete). */
export async function deleteSessionArchives(sessionId: string): Promise<void> {
  const safe = sanitizeSessionId(sessionId);
  await rm(join(ARCHIVES_DIR, safe), { recursive: true, force: true }).catch(() => {});
}

/** Raw file-level delete, used by the sub-agent runner. */
export const deleteSession = deleteSessionFile;
