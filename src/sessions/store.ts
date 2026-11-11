import { readFile, mkdir, rename as fsRename, unlink, readdir, rm, rmdir, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { MY_CLAW_DIR, resolveWorkspaceKey, workspaceNameForDir, type MyClawConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { ENTRIES_FILE, META_FILE, holdsSession, sessionDir } from "./log.ts";
import { readMeta, sessionFromMeta } from "./meta.ts";
import type { ChatLocation } from "../channels/types.ts";

/**
 * An image kept on the stored user turn so later turns can rebuild the same content blocks.
 * Only the path is kept, never the bytes: sessions are single JSON files rewritten in full on
 * every turn, and inlining base64 there would rewrite megabytes per message. The file lives in
 * the channel's own store and is re-read while it exists.
 */
export type SessionAttachment = { type: "image"; path: string; mimeType?: string };

export type SessionSubAgentStatus = "running" | "complete" | "error" | "aborted";

export interface SessionQuotaRetry {
  enabled?: boolean;
  pending?: {
    /** ISO: when the next attempt fires. */
    at: string;
    attempts: number;
    /** The spent windows that set the wait, as labels. */
    windows: string[];
    /**
     * The account whose bar reopens first, when the run walked more than one -- docs/quota-retry.md.
     * It travels with the wait so the pill names where the quota is coming back instead of the
     * model the run happened to die on.
     */
    provider?: string;
    /** What the run died on, short, so the pill can say it after a reload. */
    error?: string;
    /** `compact` for a `/compact` queued behind the wall instead of a run to resume. */
    task?: "compact";
  };
}

/**
 * Which tool opened this card: `spawn` created the sub-agent, `send` drove an existing one.
 * The lifecycle is identical either way -- this only decides the wording, so a `send` card is
 * not read as a second creation.
 */
export type SessionSubAgentAction = "spawn" | "send";

/** Display-only state for a sub-agent attached to a parent `spawn` tool call. */
export interface SessionSubAgentState {
  subagentId: string;
  displayName: string;
  agentType: string;
  mode: string;
  action: SessionSubAgentAction;
  status: SessionSubAgentStatus;
  /** What the child was asked to do. Opening state only: a terminal event does not know it. */
  task?: string;
  resultLength?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

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
      /**
       * How long the summary took to write, carried to the replayed boundary so the thread shows
       * it without having watched the compaction run. Display-only, like `summaryOf`.
       */
      compactionMs?: number;
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
       * What the turn spent thinking, as the endpoint counted it -- docs/reasoning-visibility.md.
       * One number, so the replayed bubble still says the turn thought when it kept no words.
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

/** Long enough to carry an API error with its hint, short enough to stay a bubble. */
export const FAILURE_TEXT_LIMIT = 500;

export interface SessionFailureEntry {
  /** What the owner was shown when the run died, capped at `FAILURE_TEXT_LIMIT`. */
  error: string;
  timestamp: string;
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
  // What the session is, before where its root came from: a sub-agent inherits its caller's
  // platform, so reading the platform first made every sub-agent of a cron job the cron role --
  // spawn and delegate instead of its own tools, and a browser task that could only delegate
  // another browser task, 325 levels deep (2026-09-28, docs/agent-roles.md).
  if (session.meta?.type) return session.meta.type;
  return session.platform === "cron" ? "cron" : "main";
}

export function attributionParent(session: SessionData): string {
  // Truthiness, not nullish coalescing: callers default a missing session id to "", and an empty
  // parent is worse than no parent -- it would group unrelated work under a blank key.
  return session.invokedBy || session.meta?.parentSessionId || session.id;
}

/**
 * The folder every call of this session is filed as, at call time.
 *
 * A row is filed like the conversation that pays for it: a chat's folder holds its whole spend,
 * delegation included. For the payer itself that is its own live `folderId` -- read at call time,
 * so a filing gesture mid-run applies to the calls that follow it. For a delegated run it is the
 * folder its last drive saw, stamped by the runner beside `invokedBy`.
 */
export function usageFolderOf(session: SessionData): string | undefined {
  return attributionParent(session) === session.id ? session.folderId : session.parentFolderId;
}

/**
 * The workspace every call of this session is counted under: where the run's work happens, named
 * as its config key. A sub-agent carries the directory it was spawned into (`meta.workspaceDir`,
 * the same one its bridge is pinned to); any other session runs in its own workspace key's
 * directory. Read at call time, so a workspace switch is exact from the run it applies to.
 */
export function usageWorkspaceOf(config: MyClawConfig, session: SessionData): string {
  const dir = session.meta?.workspaceDir ?? resolveWorkspaceKey(config, session.workspace);
  return workspaceNameForDir(config, dir);
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
 * A conversation's settings. Not its content: that is the entry log, `<id>/entries.jsonl`.
 *
 * `messages`, `commands` and `failures` used to live here. They survived only through the flat
 * `<id>.json`, and by the time it stopped being read they meant nothing: nothing had appended to
 * `messages` since the storage switch, and the journals were copies of entries the log already
 * held. A field with a live type and no live meaning is a trap -- it made
 * `recordSessionSubAgentState` and five calls to `indexSessionArchive` into silent no-ops -- so it
 * is gone rather than kept empty. `LegacySessionData` carries the old shape, for reading the files
 * the migration still has to convert.
 */
export interface SessionData {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
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
   * The folder this conversation is filed in, absent when it is not filed. A folder is a place and
   * not a property: the conversation carries the id, the folder store holds names and ranks, and
   * deleting a folder clears this field on each of its children rather than losing anything.
   */
  folderId?: string;
  modelOverride?: string;
  /**
   * Siphon: the one model this whole tree runs on -- docs/siphon.md.
   *
   * Unlike `modelOverride`, which a conversation's own pick sets and a sub-agent's spawn may
   * outrank, this is resolved from the **root** session and beats every other step, including an
   * explicit `spawn model:`. Children never carry a copy: they read the root at every run, so a
   * change (or a removal) reaches the next run of every level without a broadcast.
   *
   * Absent means no Siphon, which is every session today.
   */
  pinModel?: string;
  effortOverride?: import("../core/config.ts").EffortLevel;
  /**
   * Whether this session's runs may continue on another model when their provider fails.
   *
   * Absent means the inherited chain, which is what every chat and every sub-agent had before. A
   * session set to `forbid` runs its own model or stops -- the caller named that model on purpose.
   * See docs/provider-failures.md.
   */
  fallbackPolicy?: "forbid";
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
   * The capability switches of a cron run, the sibling of `scopeOverride` and set by the same
   * caller from the same job. Never persisted, for the same reason: a run session outlives its run
   * and the app opens it as a chat, so a copy would outlive the job settings it came from. Absent
   * means granted, except for `conversations`, which is withheld unless true. docs/cron.md.
   */
  scopeCapabilities?: {
    subagents?: boolean;
    browser?: boolean;
    conversations?: boolean;
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
   * Automatic retry when a run dies on a spent quota -- docs/quota-retry.md.
   *
   * `enabled` is the owner's setting and outlives each wait; `pending` is the wait itself, armed
   * with the reset the provider published. A session deleted takes both with it, which is the
   * right lifetime: nothing else has to remember to cancel.
   */
  quotaRetry?: SessionQuotaRetry;
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
  // Folder of the conversation this agent works for, as of the drive that started the work (set
  // beside `invokedBy`, runtime-only like it). The payer's own `folderId` is not readable from
  // here, and a run's calls are filed as the drawer files their payer -- docs/stats-page.md.
  parentFolderId?: string;
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
   * and `skills` refuses to read them in this session (they stay visible to other sessions and to the
   * global run).
   * Persisted on the session.
   */
  skillsOff?: string[];
  /**
   * Long-term memory recall off for this session: turn-level memory injection is skipped, the
   * model never sees a memory block even if the store has matches. Persisted on the session.
   */
  memoryRecallOff?: boolean;
}

/**
 * A session as the flat `<id>.json` held it. Nothing writes this shape any more; the migration
 * reads it, and the search backfill reads the copies already sitting in `sessions-archive/`.
 */
export interface LegacySessionData extends SessionData {
  messages: SessionMessage[];
  commands?: SessionCommandEntry[];
  failures?: SessionFailureEntry[];
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
  for (const id of subagentSessionIdsSync()) {
    if (subagentSessionToThread(id) === threadId) return id;
  }
  return null;
}

/**
 * The sub-agent ids on disk, synchronously. A sub-agent is a directory now, and was a
 * `<id>.json` before the storage switch, so both count -- and a name that is both is one id.
 */
export function subagentSessionIdsSync(): string[] {
  let names: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    names = readdirSync(join(SESSIONS_DIR, "subagent"), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of names) {
    if (entry.isDirectory()) ids.add(`subagent/${entry.name}`);
    else if (entry.isFile() && entry.name.endsWith(".json")) ids.add(`subagent/${entry.name.slice(0, -5)}`);
  }
  return [...ids];
}

/**
 * The legacy flat file, and only it. For the boot migration, whose whole job is to read the file
 * the new format replaces: falling back to the directory would let it read its own output.
 */
export async function loadLegacySession(sessionId: string): Promise<LegacySessionData | null> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as LegacySessionData;
    // The cast was taken on trust, and a `.json` under `sessions/` is not necessarily a session:
    // `<id>/meta.json` is one path away, and parsing it yields settings with no `messages`, which
    // crashed the first caller to touch `.length` -- and with it the process. A file that is not a
    // session reads as no session.
    if (!parsed || !Array.isArray(parsed.messages)) {
      void log("warn", "not a session file, treating as empty", { sessionId, path });
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    void log("warn", "corrupt session file, treating as empty", { sessionId, error: String(err) });
    return null;
  }
}

/**
 * A stored session. The directory is the session; the flat file is what it replaced.
 *
 * The migration archives `<id>.json`, so for a migrated conversation the flat file is gone and only
 * the directory answers. Reading the flat file first was wrong in the case where both exist: it is
 * rewritten in full on every persist while `metaOf` holds the settings, so a conversation that had
 * once been loaded as a fresh session -- what 0.4.53 and 0.4.54 did to every migrated one -- kept
 * handing back those defaults from the flat copy while its real title, model and window sat in the
 * directory. The directory wins, and `persist` writes it unconditionally so it is never the staler
 * of the two.
 *
 * A directory from a newer binary throws rather than reading as absent: a fresh session would then
 * be persisted straight over settings we could not parse.
 */
export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const meta = await readMeta(sessionId);
  if (meta) return sessionFromMeta(meta);
  // A conversation whose migration failed keeps its legacy file for a retry, so it still has to
  // open. Only the settings come across: its content is converted by the migration, not here.
  const legacy = await loadLegacySession(sessionId);
  if (!legacy) return null;
  const { messages: _messages, commands: _commands, failures: _failures, ...settings } = legacy;
  return settings;
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

/** True for the one error that means "there was nothing there", which is never a failure here. */
function isMissing(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

/**
 * Files a conversation away, both halves of it.
 *
 * It used to move `<id>.json` alone. Since the storage switch that file holds the settings and an
 * empty `messages`, while the conversation itself is `<id>/entries.jsonl` -- so a `/reset` archived
 * the wrapper and left the history in place, and the "fresh" sub-agent came back with everything it
 * was supposed to have forgotten. The directory goes to `<archive>/<ts>/`, the legacy file, when one
 * is still there, to `<archive>/<ts>.json` beside it.
 */
export async function archiveSession(sessionId: string): Promise<string | null> {
  const safe = sanitizeSessionId(sessionId);
  const target = join(ARCHIVES_DIR, safe, archiveTimestamp());
  await mkdir(dirname(target), { recursive: true });

  let archived: string | null = null;
  try {
    await fsRename(join(SESSIONS_DIR, safe), target);
    archived = target;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  try {
    await fsRename(join(SESSIONS_DIR, `${safe}.json`), `${target}.json`);
    archived ??= `${target}.json`;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  if (archived) hooks.emit("session:archived", { sessionId, archivePath: archived });
  return archived;
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
 * the space is `agents` (kill), or the app's own delete. See docs/subagent-navigation.md.
 */
const PRUNE_EXEMPT_PREFIXES = ["my-claw-app/", "subagent/"];

function isPruneExempt(sessionId: string): boolean {
  return PRUNE_EXEMPT_PREFIXES.some((prefix) => sessionId.startsWith(prefix));
}

export async function pruneOldSessions(): Promise<number> {
  const cutoffMs = Date.now() - SESSION_STALE_DAYS * 86_400_000;
  let removed = 0;
  try {
    for (const [sessionId, mtimeMs] of await scanSessions(SESSIONS_DIR)) {
      if (mtimeMs >= cutoffMs) continue;
      if (isPruneExempt(sessionId)) continue;
      // Both shapes, because a session can be either. Removing the `*.json` files the walk used
      // to hand back deleted `<id>/meta.json` on its own, leaving a stale conversation as an
      // entry log with no settings -- present enough to list, too broken to open.
      const safe = sanitizeSessionId(sessionId);
      await rm(join(SESSIONS_DIR, `${safe}.json`), { force: true }).catch(() => {});
      await rm(join(SESSIONS_DIR, safe), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  } catch {
    // sessions dir may not exist
  }
  return removed;
}

/**
 * Every stored session under `dir`, as ids rather than paths, keyed to when it last moved.
 *
 * A migrated session is *also* a directory, holding `meta.json`. Walked blindly it yields
 * `<id>/meta`: a conversation that does not exist, and -- since the migration archives the real
 * `<id>.json` -- the only thing left to list, so the drawer showed one ghost per conversation and
 * not a single real one. Every ghost also collapses to the same threadId, `"meta"`, because a
 * threadId is the last segment of the id. `migrate.ts` guards its own walk with this exact test.
 *
 * A session can be both shapes at once while `persist` still writes a flat file beside the
 * directory, so ids are deduplicated on the later of the two mtimes.
 */
async function scanSessions(dir: string, prefix = ""): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  const record = (id: string, mtimeMs: number): void => {
    found.set(id, Math.max(found.get(id) ?? 0, mtimeMs));
  };

  if (await holdsSession(dir, entries.map((entry) => entry.name))) {
    // The log is the session's clock: `meta.json` also moves when only a title changes. An empty
    // conversation has no log yet on a directory written before that was guaranteed, so its
    // settings stand in rather than dropping the conversation from the listing.
    const clock = await stat(join(dir, ENTRIES_FILE)).catch(() => stat(join(dir, META_FILE)).catch(() => null));
    if (clock && prefix) record(prefix, clock.mtimeMs);
    return found;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [nested, mtimeMs] of await scanSessions(full, id)) record(nested, mtimeMs);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const s = await stat(full).catch(() => null);
      if (s) record(id.slice(0, -".json".length), s.mtimeMs);
    }
  }
  return found;
}

/** All persisted session ids under a prefix, most recently active first. */
export async function listSessionIdsByPrefix(prefix: string, limit = 50): Promise<string[]> {
  const found = await scanSessions(SESSIONS_DIR);
  return [...found]
    .filter(([id]) => id.startsWith(prefix))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * Removes everything a conversation owns: the directory, the legacy file, and its archives.
 *
 * `deleteSessionFile` alone stopped being a delete at the storage switch. It removes `<id>.json`,
 * and the conversation is `<id>/entries.jsonl`: a kill reported a deletion and the sub-agent
 * came back on the next read, settings and history intact.
 */
export async function deleteStoredSession(sessionId: string): Promise<void> {
  await deleteSessionFile(sessionId);
  await rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
  await deleteSessionArchives(sessionId);
}

/** Remove every archive snapshot of a session (used by hard delete). */
export async function deleteSessionArchives(sessionId: string): Promise<void> {
  const safe = sanitizeSessionId(sessionId);
  await rm(join(ARCHIVES_DIR, safe), { recursive: true, force: true }).catch(() => {});
}

/** Raw file-level delete, used by the sub-agent runner. */
export const deleteSession = deleteSessionFile;
