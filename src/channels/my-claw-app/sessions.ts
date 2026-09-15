import { basename } from "node:path";
import { SessionManager } from "../../sessions/manager.ts";
import { FAILURE_TEXT_LIMIT, attributionParent } from "../../sessions/store.ts";
import { summaryBodyOf } from "../../sessions/compaction.ts";
import { readToolOutput } from "../../sessions/tool-output.ts";
import { sessionLogOf } from "../../sessions/log-access.ts";
import { readMeta } from "../../sessions/meta.ts";
import { pathOf, UnknownCursorError, type Provisioned, type Entry, type UserEntry, type PhaseEntry, type ToolEntry, type CompactionEntry, type CommandEntry, type FailureEntry } from "../../sessions/log.ts";
import { pageOf, pageBefore, displayOf, runFold, runFoldPlan, withSpawnCards, type DisplayResolvers } from "./display.ts";
import { spawnStates } from "../../sessions/spawn-state.ts";
import { splitAttachmentBlock, stripLocationBlock } from "../../agent/preprocess.ts";
import { toolDisplayName } from "../../agent/tools/display.ts";
import { extractMediaRefs, stripMediaRefs, mediaTypeForPath } from "../../utils/media.ts";
import { DraftStore, type DraftWrite } from "./drafts.ts";
import { parseStoredName, type SessionFile, type SessionFileStore } from "./files.ts";
import { TOOL_OUTPUT_LIMIT } from "./stream.ts";
import { toolCardId } from "./types.ts";
import type { MyClawAppHistoryAttachment, MyClawAppHistoryEntry, MyClawAppHistoryPage, MyClawAppSessionSummary, MyClawAppSessionInstructionPatch } from "./types.ts";

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** The return value of `sync`, carrying the delta plus metadata. */
export interface MyClawAppSyncPage {
  entries: MyClawAppHistoryEntry[];
  leaf: string | null;
  head: string | null;
  reset?: "unknown-cursor" | "branch-switch";
  truncated?: boolean;
  /** Whether anything remains before the newest window just served (fresh page only). */
  hasMore?: boolean;
  /** Count of entries before that window; the client's next `history` cursor. */
  nextBefore?: number;
}

/** The return value of `runItems`: the work a folded row stood for -- docs/run-hydration.md. */
export interface MyClawAppRunItemsPage {
  entries: MyClawAppHistoryEntry[];
  /** False when the current branch no longer holds the range, or when it is implausibly wide. */
  found: boolean;
}

export interface MyClawAppSessionStore {
  resolveSessionId(owner: string, threadId: string): string;
  /**
   * The session a sub-agent session bills its runs to: whoever drove the last run, else its
   * creator. Undefined for a conversation of its own, or a session that no longer exists.
   */
  payerOf(sessionId: string): Promise<string | undefined>;
  list(owner: string, limit?: number): Promise<MyClawAppSessionSummary[]>;
  history(owner: string, threadId: string, limit?: number, before?: number, beforeId?: string, fold?: boolean): Promise<MyClawAppHistoryPage>;
  /**
   * Returns entries since the client's cursor, plus the current leaf and head.
   * When the cursor is unknown or the branch diverges, returns a fresh page with `reset` set.
   */
  sync(owner: string, threadId: string, since?: string | null, clientLeaf?: string, limit?: number, fold?: boolean): Promise<MyClawAppSyncPage>;
  /**
   * The items a folded run row stands for -- docs/run-hydration.md. `found` false is a range the
   * current branch no longer holds.
   */
  runItems(owner: string, threadId: string, fromId: string, untilId: string): Promise<MyClawAppRunItemsPage>;
  /** One tool card's output in full; null when the session no longer holds the call. */
  toolOutput(owner: string, threadId: string, cardId: string): Promise<string | null>;
  /** Files the thread away, reversibly: no message is moved, deleted or snapshotted. */
  /**
   * Journals a slash command and the bubble it produced, so a reopened thread still shows it.
   * No-op on a thread that has no session yet: there is no history to put it in.
   */
  recordCommand(owner: string, threadId: string, input: string, output: string, details?: string, sourceId?: string, quiet?: boolean): Promise<void>;
  /**
   * Journals a run that died and the error the owner was shown, so a reopened thread still says
   * why the question got no answer. No-op on a thread that has no session yet.
   */
  recordFailure(owner: string, threadId: string, error: string, bubbleId?: string): Promise<void>;
  archive(owner: string, threadId: string): Promise<void>;
  unarchive(owner: string, threadId: string): Promise<void>;
  remove(owner: string, threadId: string): Promise<void>;
  rename(owner: string, threadId: string, title: string): Promise<void>;
  /**
   * Stores what the owner has typed and not sent, so every device they own sees it. Reports whether
   * anything actually changed: the caller broadcasts only then -- docs/draft-sync.md.
   */
  setDraft(owner: string, threadId: string, text: string): Promise<DraftWrite>;
  clearDraft(owner: string, threadId: string): Promise<boolean>;
  /** Writes the pending drafts. Awaited by the adapter's shutdown, which runs before the exit. */
  flushDrafts(): Promise<void>;
  /**
   * Sets the conversation's workspace ("default" or a config.workspaces key), creating the
   * session if it does not exist yet. Throws on an unknown key.
   */
  setWorkspace(owner: string, threadId: string, workspace: string): Promise<void>;
  /**
   * Applies one per-session instruction control: nested AGENTS.md toggle/unload, prompt layer
   * toggle, skill toggle, memory recall toggle. The session is peeked, mutated, persisted. Throws
   * when the conversation does not exist: the adapter turns that into a refused frame.
   */
  setInstructionPatch(owner: string, threadId: string, patch: MyClawAppSessionInstructionPatch): Promise<void>;
}

/** Long enough for a real name, short enough to stay one line in the drawer. */
export const MAX_TITLE_LENGTH = 60;

/** Thread ids come from the device and later land in file paths; keep them strictly safe. */
export function sanitizeThreadId(raw: string): string | null {
  if (THREAD_ID_PATTERN.test(raw)) return raw;
  return null;
}

const HISTORY_LIMIT = 50;
/** Maximum entries returned by sync, per docs/session-log.md §3.4 and §4.1. */
const SYNC_LIMIT = 500;
/**
 * Widest range hydration will answer. A folded row never spans more than the page it was cut
 * from, and a page is `SYNC_LIMIT` plus the turn-alignment walk, so this is generous for anything
 * this server minted. It exists for the request that was not: two ids far apart would otherwise
 * serve tens of megabytes off a single frame.
 */
const RUN_ITEMS_LIMIT = 1000;

/**
 * The bare entry id behind a row id. `run-<id>` is what the client holds on a folded row, and
 * `toolOutput` already takes `t-<callId>` the same way: the wire accepts what the client has
 * rather than making it strip prefixes it did not invent.
 */
function bareEntryId(raw: string): string {
  return raw.startsWith("run-") ? raw.slice(4) : raw;
}
/**
 * How far back the newest page may reach to start on a question rather than mid-work. One
 * agentic turn is easily two hundred messages, and a page that starts inside one reads as a
 * lost message; the cap only stops a pathological turn from dragging a whole session in.
 */
const MAX_TURN_LOOKBACK = 400;

/**
 * Walks the page's first message back to the user message that opened its turn.
 *
 * A page is a count of messages, but a conversation is read in turns, and one agentic turn is
 * easily fifty tool results: cut at a fixed count, the newest page begins in the middle of the
 * work and leaves the question that caused it on the page above, which reads as a lost message
 * rather than as pagination. The walk is bounded by `lookback`, so a turn longer than that still
 * starts mid-flight instead of dragging the whole session in.
 */
function turnAlignedStart(messages: { role: string }[], rawStart: number, lookback: number): number {
  const floor = Math.max(rawStart - Math.max(lookback, 0), 0);
  let start = rawStart;
  while (start > floor && messages[start]!.role !== "user") start -= 1;
  return start;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return { raw };
  }
}

/**
 * A stored turn names its attachments by server path; the id sits in the file name. Metadata
 * comes from the thread's own listing so a replayed bubble matches what the explorer shows.
 */
/** `1234 ms` in the block details. The recorder measured it; the server never decodes the file. */
function durationFrom(details: string[]): number | undefined {
  for (const detail of details) {
    const match = /^(\d+) ms$/.exec(detail.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}

function historyAttachments(entries: ReturnType<typeof splitAttachmentBlock>["attachments"], files: SessionFile[]): MyClawAppHistoryAttachment[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const out: MyClawAppHistoryAttachment[] = [];
  for (const entry of entries) {
    const parsed = parseStoredName(basename(entry.source));
    if (!parsed) continue;
    const file = byId.get(parsed.id);
    if (file) {
      const durationMs = durationFrom(entry.details);
      out.push({
        id: file.id,
        type: file.type,
        mimeType: file.mimeType,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    } else {
      const type = entry.type === "image" || entry.type === "audio" || entry.type === "video" ? entry.type : "file";
      out.push({ id: parsed.id, type, filename: parsed.filename, deleted: true });
    }
  }
  return out;
}

/**
 * An assistant turn names its media by the path the agent wrote (`MEDIA:/tmp/out.jpg`), but the
 * bytes live in the session store under a fresh id. The store copy keeps the agent's basename, so
 * a ref resolves by filename -- newest copy wins when the agent regenerated the same file. A ref
 * whose copy is gone replays as a deleted attachment rather than dead text.
 */
/**
 * One bubble's worth of a replayed turn: a thinking phase and the text it produced. A turn that
 * thought once is one phase, and the stored `segments` are the cuts of a turn that thought again
 * mid-answer -- docs/reasoning-visibility.md.
 */
interface HistoryPhase {
  reasoning?: string;
  reasoningTokens?: number;
  content: string;
}

function mediaRefAttachments(refs: Array<{ path: string }>, files: SessionFile[]): MyClawAppHistoryAttachment[] {
  const used = new Set<string>();
  const out: MyClawAppHistoryAttachment[] = [];
  for (const ref of refs) {
    const name = basename(ref.path);
    // listInThread sorts newest first: a regenerated file replaces the previous copy.
    const file = files.find((f) => f.filename === name && !used.has(f.id));
    if (file) {
      used.add(file.id);
      out.push({
        id: file.id,
        type: file.type,
        mimeType: file.mimeType,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
      });
    } else {
      out.push({ id: `media-${out.length}`, type: mediaTypeForPath(ref.path), filename: name, deleted: true });
    }
  }
  return out;
}

/** Convert SessionAttachment[] to MyClawAppHistoryAttachment[] using thread files. */
import type { SessionAttachment } from "../../sessions/store.ts";

function sessionAttachmentsToHistory(
  attachments: SessionAttachment[],
  files: SessionFile[],
): MyClawAppHistoryAttachment[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const out: MyClawAppHistoryAttachment[] = [];
  for (const att of attachments) {
    const parsed = parseStoredName(basename(att.path));
    if (!parsed) continue;
    const file = byId.get(parsed.id);
    if (file) {
      out.push({
        id: file.id,
        type: file.type,
        mimeType: file.mimeType,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
      });
    } else {
      out.push({ id: parsed.id, type: att.type, filename: parsed.filename, deleted: true });
    }
  }
  return out;
}

/** Build display resolvers for a thread's files. */
function makeResolvers(files: SessionFile[]): DisplayResolvers {
  return {
    attachmentsOf: (attachments) => sessionAttachmentsToHistory(attachments, files),
    attachmentsOfBlock: (entries) => historyAttachments(entries, files),
    mediaOf: (refs) => mediaRefAttachments(refs, files),
  };
}

export class MyClawAppSessionStoreImpl implements MyClawAppSessionStore {
  constructor(
    private sessionManager: SessionManager,
    private files: SessionFileStore,
    /**
     * Runs after a conversation is removed, with its session id: the hook that lets the private
     * sub-agents it owns die with it (docs/subagent-navigation.md). Injected so the channel does
     * not reach into the sub-agent runner.
     */
    private onRemove?: (sessionId: string) => Promise<void>,
    /** Injected from the entry point: the adapter must not read the global config itself. */
    private isWorkspaceKey: (key: string) => boolean = () => true,
    private drafts: DraftStore = new DraftStore(),
  ) {}

  async setDraft(owner: string, threadId: string, text: string): Promise<DraftWrite> {
    return this.drafts.set(this.resolveSessionId(owner, threadId), text);
  }

  async clearDraft(owner: string, threadId: string): Promise<boolean> {
    return this.drafts.clear(this.resolveSessionId(owner, threadId));
  }

  async flushDrafts(): Promise<void> {
    return this.drafts.flush();
  }

  async payerOf(sessionId: string): Promise<string | undefined> {
    const session = await this.sessionManager.read(sessionId);
    if (!session) return undefined;
    const payer = attributionParent(session);
    return payer === sessionId ? undefined : payer;
  }

  resolveSessionId(owner: string, threadId: string): string {
    return SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, {
      threadId,
      sessionScope: "per-user",
    });
  }

  /**
   * The two numbers a row of the drawer needs, from `meta.json` when it has them.
   *
   * Opening the log instead is what this avoids: the listing walks every conversation the owner
   * ever had, and each open parses a whole JSONL file into objects and keeps it -- 214 MB on disk
   * here, several times that in memory, to draw a sidebar. A session written before the meta
   * carried these is backfilled by opening its log that once; the write that follows means the
   * next listing does not.
   */
  private async listingCounts(sessionId: string): Promise<{ promptCount: number; firstUserText?: string }> {
    // An open log outranks the file: a run in flight has appended entries the meta has not seen.
    const open = this.sessionManager.peekLog(sessionId);
    if (open) {
      const first = open.firstUserText();
      return { promptCount: open.promptCount(), ...(first === null ? {} : { firstUserText: first }) };
    }
    const meta = await readMeta(sessionId).catch(() => null);
    if (meta?.promptCount !== undefined) {
      return {
        promptCount: meta.promptCount,
        ...(meta.firstUserText === undefined ? {} : { firstUserText: meta.firstUserText }),
      };
    }
    const log = await sessionLogOf(sessionId);
    const first = log.firstUserText();
    return { promptCount: log.promptCount(), ...(first === null ? {} : { firstUserText: first }) };
  }

  /** Every conversation of this owner. A cap here made the oldest ones unreachable and unsearchable. */
  async list(owner: string, limit = Number.MAX_SAFE_INTEGER): Promise<MyClawAppSessionSummary[]> {
    const ids = await this.sessionManager.listSessions(`my-claw-app/thread/${owner}/`, limit);
    // Once for the whole listing: the drawer marks every conversation holding unsent text, and a
    // per-thread lookup would await the same loaded map N times.
    const drafted = await this.drafts.drafted();
    const summaries: MyClawAppSessionSummary[] = [];
    for (const sessionId of ids) {
      // The live copy, not the file: a conversation with a run in flight must count the turn it
      // is producing, or the drawer shows a stale message count next to a thread that is moving.
      const session = await this.sessionManager.read(sessionId);
      if (!session) continue;
      const counts = await this.listingCounts(sessionId);
      const raw = counts.firstUserText;
      // Without the block, a "here, look" + photo would be titled by a server path.
      const firstText = raw ? stripLocationBlock(splitAttachmentBlock(raw).text) : "";
      const derived = firstText.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
      // Read off the text rather than carried as a third field: the block is in the message the
      // owner sent, which is exactly what makes it strippable above.
      const hadLocation = raw !== undefined && stripLocationBlock(raw) !== raw;
      const title = session.title?.trim() || derived || (hadLocation ? "(location)" : "(new conversation)");
      summaries.push({
        threadId: sessionId.slice(sessionId.lastIndexOf("/") + 1),
        title,
        messageCount: counts.promptCount,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        ...(session.archivedAt ? { archived: true } : {}),
        workspace: session.workspace ?? "default",
        ...(drafted.has(sessionId) ? { hasDraft: true } : {}),
      });
    }
    return summaries;
  }

  async history(
    owner: string,
    threadId: string,
    limit = HISTORY_LIMIT,
    before = 0,
    beforeId?: string,
    fold = false,
  ): Promise<MyClawAppHistoryPage> {
    // Reading the file here would replay a thread as it stood before the current turn started,
    // and the app replaces what is on screen with what this returns: the question just sent and
    // the cards already streamed would vanish until the run ends.
    const sessionId = this.resolveSessionId(owner, threadId);
    // The newest page only, and even when there is no session yet: a thread whose first message is
    // still being written is exactly where a draft matters most.
    const draft = before ? "" : await this.drafts.textOf(sessionId);
    const session = await this.sessionManager.read(sessionId);
    if (!session) return { entries: [], hasMore: false, nextBefore: before, ...(draft ? { draft } : {}) };

    // Get the log and compute the full path (display shows everything, including pre-compaction entries)
    const log = await sessionLogOf(sessionId);
    const path = pathOf(log.entries(), log.leaf());
    if (path.length === 0) return { entries: [], hasMore: false, nextBefore: before, ...(draft ? { draft } : {}) };

    // Pagination: pageOf aligns on turn boundaries. `beforeId` is the client's oldest held
    // entry (or a tool call id, which the client owns on tool cards): the page ends right before
    // it, so the cursor survives session growth and client-side trimming -- the count-based
    // `before` drifts when new entries land between two requests.
    const { window, hasMore, nextBefore } = beforeId
      ? pageBefore(path, beforeId, limit, before)
      : pageOf(path, limit, before);

    // List thread files for attachment resolution
    const needsFiles = window.some((e: Entry) => e.type === "user" || (e.type === "phase" && (e as PhaseEntry).text.includes("MEDIA:")));
    const stored = needsFiles ? await this.files.list(owner, threadId) : [];
    const resolvers = makeResolvers(stored);

    // Folded over the whole log, not over the page: a child spawned on page 3 settles on page 1,
    // and a card whose state entry fell outside the window would replay as a spinner for good.
    // The run fold comes from the same whole-branch walk, so a page that starts mid-run still
    // tags its entries with the run they belong to (docs/run-grouping.md).
    const runs = runFold(path);
    // A finished run travels as its header when the client asked for that -- docs/run-hydration.md.
    // The plan is computed against the whole branch and not against the window, because the rule
    // is containment: a run the page boundary cut keeps its items.
    const plan = fold ? runFoldPlan(path, window, runs) : undefined;
    const entries = displayOf(window, resolvers, TOOL_OUTPUT_LIMIT, spawnStates(log.entries()), stored, runs, plan);
    return { entries, hasMore, nextBefore, ...(draft ? { draft } : {}) };
  }

  /**
   * Returns entries since the client's cursor, or a fresh page when the cursor is unknown or
   * the branch diverges. This is the delta sync that replaces full history reload on reconnect.
   */
  async sync(
    owner: string,
    threadId: string,
    since?: string | null,
    clientLeaf?: string,
    limit = SYNC_LIMIT,
    fold = false,
  ): Promise<MyClawAppSyncPage> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.read(sessionId);
    if (!session) {
      // No session yet: nothing to sync
      return { entries: [], leaf: null, head: null };
    }

    const log = await sessionLogOf(sessionId);
    const allEntries = log.entries();
    const serverLeaf = log.leaf();
    const head = allEntries.length > 0 ? allEntries[allEntries.length - 1]!.id : null;

    // Effective limit, capped at SYNC_LIMIT
    const effectiveLimit = Math.min(Math.max(limit ?? SYNC_LIMIT, 1), SYNC_LIMIT);

    // Detect branch switch: the client's leaf is not on the path to the server's leaf
    let reset: "unknown-cursor" | "branch-switch" | undefined;
    if (clientLeaf && serverLeaf && clientLeaf !== serverLeaf) {
      const path = pathOf(allEntries, serverLeaf);
      const clientOnPath = path.some((e) => e.id === clientLeaf);
      if (!clientOnPath) reset = "branch-switch";
    }

    let delta: Entry[];
    // True when the answer replaces the client's held thread (fresh open or a reset): this is
    // the newest page, so it also carries the paging cursor the client needs to walk back -
    // the delta path leaves the client's own cursor standing, so only the replaced window gets one.
    let freshWindow = false;
    if (reset === "branch-switch" || since === undefined || since === null) {
      // Fresh page: the newest window of the branch, aligned on a turn like a history page is.
      // A flat slice cuts wherever the count falls, and one agentic turn is easily 300 entries:
      // an opened thread then starts on a tool card whose question sits above the window, which
      // reads as a run that came from nowhere.
      delta = pageOf(pathOf(allEntries, serverLeaf), effectiveLimit, 0).window;
      if (since === undefined || since === null) reset = undefined; // Not a reset, just a fresh open
      freshWindow = true;
    } else {
      // Try to get delta since the cursor
      try {
        delta = log.since(since);
        // If client's leaf is still valid and server moved, no reset needed
      } catch (err) {
        if (err instanceof UnknownCursorError) {
          reset = "unknown-cursor";
          delta = pageOf(pathOf(allEntries, serverLeaf), effectiveLimit, 0).window;
          freshWindow = true;
        } else {
          throw err;
        }
      }
    }

    // Only a delta can be truncated. A fresh window is a whole page by construction, and the
    // turn alignment above can push it past the limit: flagging that as truncated would send the
    // client asking for a forward delta it already holds, instead of paging backwards.
    const truncated = !freshWindow && delta.length > effectiveLimit;
    if (truncated) delta = delta.slice(-effectiveLimit);
    const windowLength = delta.length;

    // A state entry the client cannot draw becomes the card it revised, before anything else looks
    // at the delta -- including the attachment scan, which now sees a tool entry rather than an
    // annotation.
    // The window as it was *before* that substitution is what the fold reasons about: an injected
    // card comes from another position on the branch, and folding it into a group here would put
    // it outside the range the summary claims -- hydration would then never hand it back.
    const foldWindow = delta;
    delta = withSpawnCards(delta, allEntries);

    // Resolve attachments for display
    const needsFiles = delta.some(
      (e) => e.type === "user" || (e.type === "phase" && (e as PhaseEntry).text.includes("MEDIA:")),
    );
    const stored = needsFiles ? await this.files.list(owner, threadId) : [];
    const resolvers = makeResolvers(stored);
    // The run fold covers the whole current branch, so entries of a delta that starts mid-run
    // still carry their run: the client folds them under the right header even when the
    // `run_start` marker itself predates the cursor.
    const path = pathOf(allEntries, serverLeaf);
    const runs = runFold(path);
    // Only the window that replaces the client's thread folds. A delta is work the client is
    // watching arrive, item by item, and its runs are usually the ones still running -- which
    // never fold anyway. Folding a delta would also have to reason about what the client already
    // holds, since the run it continues is half on screen.
    const plan = fold && freshWindow ? runFoldPlan(path, foldWindow, runs) : undefined;
    const entries = displayOf(delta, resolvers, TOOL_OUTPUT_LIMIT, spawnStates(allEntries), stored, runs, plan);

    const branchLength = path.length;
    return {
      entries,
      leaf: serverLeaf,
      head,
      ...(reset ? { reset } : {}),
      ...(truncated ? { truncated } : {}),
      // The window that replaces the client's held thread is the newest page: it carries the
      // paging cursor so the client knows older work exists and where to ask for it --
      // docs/session-log.md. A delta leaves the client's own cursor standing, or it would march
      // ahead of what the client actually holds.
      ...(freshWindow && !truncated
        ? { hasMore: windowLength < branchLength, nextBefore: branchLength - windowLength }
        : {}),
    };
  }

  /**
   * The work a folded row stood for, fetched when the reader opens the group.
   *
   * The other half of the fold, and the same trade `toolOutput` already makes: the page carries a
   * header, whoever opens it pays for the items. Addressed by the range the row itself carries and
   * not by a run id, because a run cut by a page boundary folds into one row per page -- answering
   * with the whole run would hand back items the client already holds and splice them twice.
   *
   * `found` false rather than a partial answer when the range is gone (a compaction dropped the
   * turn, a rewind moved to another branch): the group then says so and stays collapsed, which is
   * recoverable. Silently emptying itself is not.
   */
  async runItems(owner: string, threadId: string, fromId: string, untilId: string): Promise<MyClawAppRunItemsPage> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.read(sessionId);
    if (!session) return { entries: [], found: false };

    const log = await sessionLogOf(sessionId);
    const path = pathOf(log.entries(), log.leaf());
    // The row id or the bare entry id, like `toolOutput` takes `t-<callId>` or the call id: the
    // client holds `run-<id>` on the row and a bare id in `lastId`, and should not have to know
    // which of the two the wire wants.
    const from = bareEntryId(fromId);
    const until = bareEntryId(untilId);
    const start = path.findIndex((entry) => entry.id === from);
    const end = path.findIndex((entry) => entry.id === until);
    if (start < 0 || end < start) return { entries: [], found: false };
    // No row this server minted spans more than a page. A wider range is a client asking for the
    // session in one frame, and answering it would serve tens of megabytes off one request.
    if (end - start + 1 > RUN_ITEMS_LIMIT) return { entries: [], found: false };

    const window = path.slice(start, end + 1);
    const needsFiles = window.some((e: Entry) => e.type === "user" || (e.type === "phase" && (e as PhaseEntry).text.includes("MEDIA:")));
    const stored = needsFiles ? await this.files.list(owner, threadId) : [];
    const resolvers = makeResolvers(stored);
    // Folded over the whole branch for the same reasons a page is: a child spawned inside this run
    // may have settled long after it, and the run meta must be the one the header already shows.
    const runs = runFold(path);
    const entries = displayOf(window, resolvers, TOOL_OUTPUT_LIMIT, spawnStates(log.entries()), stored, runs);
    return { entries, found: true };
  }

  /**
   * One tool card's output, whole, straight out of the session.
   *
   * The cards themselves are pushed clipped: a thread's history would otherwise carry every byte
   * every tool ever printed, on every reconnect, for the sake of the few a reader opens. This is
   * the other half of that trade, and it is a read of what is already on disk -- nothing is kept
   * in memory for it.
   *
   * Null when the session no longer holds the call: a compaction can drop the turn it belonged
   * to, and the card outlives it.
   */
  async toolOutput(owner: string, threadId: string, cardId: string): Promise<string | null> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.read(sessionId);
    if (!session) return null;
    // cardId = "t-" + callId per toolCardId()
    const callId = cardId.startsWith("t-") ? cardId.slice(2) : cardId;
    const log = await sessionLogOf(sessionId);
    for (const entry of log.entries()) {
      if (entry.type !== "tool") continue;
      if (entry.callId !== callId) continue;
      // Spillèd output takes precedence; else the inline extract.
      if (entry.outputPath) {
        const full = await readToolOutput(sessionId, callId);
        if (full !== null) return full;
      }
      // No spill or file missing: return inline output.
      if (entry.output) return entry.output;
      // Settled as an error or abort before any output was produced. For a `spawn` card that is the
      // child's own ending, which lands well after this entry was written.
      const spawn = spawnStates(log.entries()).get(callId) ?? entry.spawn;
      return spawn?.status === "error" || spawn?.status === "aborted" ? (spawn.error ?? "") : "";
    }
    return null;
  }

  /**
   * `bubbleId` is the bubble the error is already on screen in, when a streamer painted one. The
   * entry then carries that id, so a page replaces the bubble instead of adding a second copy of
   * the same error below the thread -- docs/bubble-identity.md. An id the log already holds is
   * refused by `append`, and the entry keeps one of its own: a duplicate error is a nuisance, a
   * lost failure entry is a question with nothing under it.
   */
  async recordFailure(owner: string, threadId: string, error: string, bubbleId?: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) return;
    // An empty error is not journalled: there is nothing to show and nothing to explain.
    const text = error.trim();
    if (!text) return;
    const log = await sessionLogOf(sessionId);
    const entry: Provisioned<FailureEntry> = {
      type: "failure",
      prompt: false,
      error: text.slice(0, FAILURE_TEXT_LIMIT),
    };
    try {
      log.append<FailureEntry>(entry, bubbleId);
    } catch {
      log.append<FailureEntry>(entry);
    }
    await this.sessionManager.persist(sessionId);
  }

  async recordCommand(owner: string, threadId: string, input: string, output: string, details?: string, sourceId?: string, quiet = false): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) return;
    const log = await sessionLogOf(sessionId);
    log.append<CommandEntry>({
      type: "command",
      prompt: false,
      input,
      output,
      ...(details ? { details } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(quiet ? { quiet } : {}),
    });
    await this.sessionManager.persist(sessionId);
  }

  /**
   * Files the conversation away without touching a single message. Nothing is moved and
   * nothing is snapshotted: the thread simply leaves the main list, and `unarchive` puts it
   * back exactly as it was.
   */
  async archive(owner: string, threadId: string): Promise<void> {
    await this.setArchived(owner, threadId, new Date().toISOString());
  }

  async unarchive(owner: string, threadId: string): Promise<void> {
    await this.setArchived(owner, threadId, undefined);
  }

  private async setArchived(owner: string, threadId: string, at: string | undefined): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    // Filing away a thread that was never opened would create an empty one, the way naming does.
    const session = await this.sessionManager.peek(sessionId);
    if (!session) throw new Error("conversation not found");
    if (at) session.archivedAt = at;
    else delete session.archivedAt;
    await this.sessionManager.persist(sessionId);
  }

  async remove(owner: string, threadId: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    await this.sessionManager.deleteSession(sessionId);
    await this.onRemove?.(sessionId);
  }

  /**
   * Names a conversation, or hands it back to the automatic title when given nothing. The
   * session has to exist: naming a thread that was never opened would create an empty one that
   * then shows up in the list.
   */
  async rename(owner: string, threadId: string, title: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) throw new Error("conversation not found");
    const clean = title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
    if (clean) session.title = clean;
    else delete session.title;
    await this.sessionManager.persist(sessionId);
  }

  async setWorkspace(owner: string, threadId: string, workspace: string): Promise<void> {
    if (!this.isWorkspaceKey(workspace)) throw new Error(`unknown workspace: ${workspace}`);
    const sessionId = this.resolveSessionId(owner, threadId);
    const key = workspace === "default" ? undefined : workspace;
    // A new conversation is created here with the chosen workspace: the + button picks a
    // workspace before the first message exists. An existing one is switched on the spot.
    const session = await this.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm", key);
    if (key) session.workspace = key;
    else delete session.workspace;
    await this.sessionManager.persist(sessionId);
  }

  async setInstructionPatch(owner: string, threadId: string, patch: MyClawAppSessionInstructionPatch): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) throw new Error(`no session: ${sessionId}`);
    switch (patch.kind) {
      case "nested.toggle": {
        if (!patch.path) throw new Error("nested.toggle needs a path");
        const disabled = new Set(session.nestedDisabled ?? []);
        if (patch.on === true) disabled.add(patch.path);
        else if (patch.on === false) disabled.delete(patch.path);
        else if (disabled.has(patch.path)) disabled.delete(patch.path);
        else disabled.add(patch.path);
        if (disabled.size > 0) session.nestedDisabled = [...disabled];
        else delete session.nestedDisabled;
        break;
      }
      case "nested.unload": {
        if (!patch.path) throw new Error("nested.unload needs a path");
        session.nestedAgents = (session.nestedAgents ?? []).filter((r) => r.path !== patch.path);
        break;
      }
      case "layer.toggle": {
        if (!patch.layer) throw new Error("layer.toggle needs a layer");
        const off = new Set(session.promptLayersOff ?? []);
        if (patch.on === true) off.add(patch.layer);
        else if (patch.on === false) off.delete(patch.layer);
        else if (off.has(patch.layer)) off.delete(patch.layer);
        else off.add(patch.layer);
        if (off.size > 0) session.promptLayersOff = [...off];
        else delete session.promptLayersOff;
        break;
      }
      case "skill.toggle": {
        if (!patch.skill) throw new Error("skill.toggle needs a skill");
        const off = new Set(session.skillsOff ?? []);
        if (patch.on === true) off.add(patch.skill);
        else if (patch.on === false) off.delete(patch.skill);
        else if (off.has(patch.skill)) off.delete(patch.skill);
        else off.add(patch.skill);
        if (off.size > 0) session.skillsOff = [...off];
        else delete session.skillsOff;
        break;
      }
      case "memory.toggle": {
        if (patch.on === true) session.memoryRecallOff = true;
        else if (patch.on === false) delete session.memoryRecallOff;
        else if (session.memoryRecallOff) delete session.memoryRecallOff;
        else session.memoryRecallOff = true;
        break;
      }
    }
    await this.sessionManager.persist(sessionId);
  }
}
