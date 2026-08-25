import { basename } from "node:path";
import { SessionManager } from "../../sessions/manager.ts";
import { recordSessionCommand, recordSessionFailure, FAILURE_TEXT_LIMIT } from "../../sessions/store.ts";
import { summaryBodyOf } from "../../sessions/compaction.ts";
import { readToolOutput } from "../../sessions/tool-output.ts";
import { sessionLogOf } from "../../sessions/log-access.ts";
import { pathOf, type Entry, type UserEntry, type PhaseEntry, type ToolEntry, type CompactionEntry, type CommandEntry, type FailureEntry } from "../../sessions/log.ts";
import { pageOf, displayOf, type DisplayResolvers } from "./display.ts";
import { splitAttachmentBlock, stripLocationBlock } from "../../agent/preprocess.ts";
import { toolDisplayName } from "../../agent/tools/display.ts";
import { extractMediaRefs, stripMediaRefs, mediaTypeForPath } from "../../utils/media.ts";
import { DraftStore, type DraftWrite } from "./drafts.ts";
import { parseStoredName, type SessionFile, type SessionFileStore } from "./files.ts";
import { TOOL_OUTPUT_LIMIT } from "./stream.ts";
import { toolCardId } from "./types.ts";
import type { MyClawAppHistoryAttachment, MyClawAppHistoryEntry, MyClawAppHistoryPage, MyClawAppSessionSummary, MyClawAppSessionInstructionPatch } from "./types.ts";

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface MyClawAppSessionStore {
  resolveSessionId(owner: string, threadId: string): string;
  list(owner: string, limit?: number): Promise<MyClawAppSessionSummary[]>;
  history(owner: string, threadId: string, limit?: number, before?: number): Promise<MyClawAppHistoryPage>;
  /** One tool card's output in full; null when the session no longer holds the call. */
  toolOutput(owner: string, threadId: string, cardId: string): Promise<string | null>;
  /** Files the thread away, reversibly: no message is moved, deleted or snapshotted. */
  /**
   * Journals a slash command and the bubble it produced, so a reopened thread still shows it.
   * No-op on a thread that has no session yet: there is no history to put it in.
   */
  recordCommand(owner: string, threadId: string, input: string, output: string, details?: string, sourceId?: string): Promise<void>;
  /**
   * Journals a run that died and the error the owner was shown, so a reopened thread still says
   * why the question got no answer. No-op on a thread that has no session yet.
   */
  recordFailure(owner: string, threadId: string, error: string): Promise<void>;
  archive(owner: string, threadId: string): Promise<void>;
  unarchive(owner: string, threadId: string): Promise<void>;
  /** Pins the conversation at the end of the pinned list, or unpins it. */
  setPinned(owner: string, threadId: string, pinned: boolean): Promise<void>;
  /** Rewrites the pinned ranks in the given order. Unknown ids are ignored. */
  setPinOrder(owner: string, threadIds: string[]): Promise<void>;
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

/**
 * The transcript is written into the turn as `[Audio]: "..."` so the model reads words rather
 * than a file. Replayed as-is it would print that marker in the bubble, where the live message
 * showed the sentence under its player. Pulled back out here, a reopened thread renders the
 * same thing it did when it was sent.
 */
function splitTranscript(text: string): { text: string; spoken: string[] } {
  const paragraphs = text.split("\n\n");
  const spoken: string[] = [];
  const rest: string[] = [];
  for (const paragraph of paragraphs) {
    // Only the quoted form: a failed take reads `[Audio]: [Transcription failed: ...]`, and that
    // is a fact about the turn the owner needs to keep seeing.
    const match = /^\[Audio(?: \d+)?\]: "([\s\S]*)"$/.exec(paragraph.trim());
    if (match) spoken.push(match[1]!);
    else rest.push(paragraph);
  }
  if (spoken.length === 0) return { text, spoken };
  return { text: rest.join("\n\n").trim(), spoken };
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

  resolveSessionId(owner: string, threadId: string): string {
    return SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, {
      threadId,
      sessionScope: "per-user",
    });
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
      // Get entries from the log
      const log = await sessionLogOf(sessionId);
      const entries = log.entries();
      const firstUser = entries.find((e): e is UserEntry => e.type === "user");
      // Without the block, a "here, look" + photo would be titled by a server path.
      const firstText = firstUser ? stripLocationBlock(splitAttachmentBlock(firstUser.text).text) : "";
      const derived = firstText.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
      const title = session.title?.trim() || derived || (firstUser?.location ? "(location)" : "(new conversation)");
      summaries.push({
        threadId: sessionId.slice(sessionId.lastIndexOf("/") + 1),
        title,
        messageCount: entries.filter(e => e.prompt).length,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        ...(session.archivedAt ? { archived: true } : {}),
        ...(typeof session.pinRank === "number" ? { pinRank: session.pinRank } : {}),
        workspace: session.workspace ?? "default",
        ...(drafted.has(sessionId) ? { hasDraft: true } : {}),
      });
    }
    return summaries;
  }

  async history(owner: string, threadId: string, limit = HISTORY_LIMIT, before = 0): Promise<MyClawAppHistoryPage> {
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

    // Pagination: pageOf aligns on turn boundaries
    const { window, hasMore, nextBefore } = pageOf(path, limit, before);

    // List thread files for attachment resolution
    const needsFiles = window.some((e: Entry) => e.type === "user" || (e.type === "phase" && (e as PhaseEntry).text.includes("MEDIA:")));
    const stored = needsFiles ? await this.files.list(owner, threadId) : [];
    const resolvers = makeResolvers(stored);

    // Convert entries to display format
    const entries = displayOf(window, resolvers, TOOL_OUTPUT_LIMIT);
    return { entries, hasMore, nextBefore, ...(draft ? { draft } : {}) };
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
      // Settled as an error or abort before any output was produced.
      const spawn = entry.spawn;
      return spawn?.status === "error" || spawn?.status === "aborted" ? (spawn.error ?? "") : "";
    }
    return null;
  }

  async recordFailure(owner: string, threadId: string, error: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) return;
    // Empty errors are not journalled (matches recordSessionFailure behavior)
    const text = error.trim();
    if (!text) return;
    const capped = text.slice(0, FAILURE_TEXT_LIMIT);
    // Write to the log (the source of truth) and to session.failures (for legacy compat)
    const log = await sessionLogOf(sessionId);
    log.append<FailureEntry>({
      type: "failure",
      prompt: false,
      error: capped,
    });
    recordSessionFailure(session, error);
    await this.sessionManager.persist(sessionId);
  }

  async recordCommand(owner: string, threadId: string, input: string, output: string, details?: string, sourceId?: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) return;
    // Write to the log (the source of truth) and to session.commands (for legacy compat)
    const log = await sessionLogOf(sessionId);
    log.append<CommandEntry>({
      type: "command",
      prompt: false,
      input,
      output,
      ...(details ? { details } : {}),
    });
    recordSessionCommand(session, {
      input,
      output,
      timestamp: new Date().toISOString(),
      ...(details ? { details } : {}),
      ...(sourceId ? { sourceId } : {}),
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

  /**
   * Pins the conversation at the end of the pinned list, or unpins it. Appending is the only
   * defensible default: a fresh pin dropped at the top would displace the row the owner reaches
   * for without reading it.
   */
  async setPinned(owner: string, threadId: string, pinned: boolean): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    // Pinning a thread that was never opened would create an empty one, the way naming does.
    const session = await this.sessionManager.peek(sessionId);
    if (!session) throw new Error("conversation not found");
    const current = await this.pinnedSessionIds(owner);
    if (pinned) {
      if (current.includes(sessionId)) return;
      await this.writePinOrder([...current, sessionId]);
      return;
    }
    if (!current.includes(sessionId)) return;
    delete session.pinRank;
    await this.sessionManager.persist(sessionId);
    // Renumbered, so the ranks stay dense and the next pin lands at the end rather than on top
    // of the rank the removed one left behind.
    await this.writePinOrder(current.filter((id) => id !== sessionId));
  }

  async setPinOrder(owner: string, threadIds: string[]): Promise<void> {
    const wanted: string[] = [];
    for (const raw of threadIds) {
      const threadId = sanitizeThreadId(raw);
      if (!threadId) continue;
      const sessionId = this.resolveSessionId(owner, threadId);
      if (!wanted.includes(sessionId)) wanted.push(sessionId);
    }
    const current = await this.pinnedSessionIds(owner);
    const head = wanted.filter((sessionId) => current.includes(sessionId));
    // A pin made elsewhere while this list was on screen is not in it; it keeps its pin and
    // follows, because a drop says where the dragged rows go and nothing about the others.
    const tail = current.filter((sessionId) => !head.includes(sessionId));
    await this.writePinOrder([...head, ...tail]);
  }

  /** The owner's pinned conversations, in rank order. */
  private async pinnedSessionIds(owner: string): Promise<string[]> {
    const ids = await this.sessionManager.listSessions(`my-claw-app/thread/${owner}/`, Number.MAX_SAFE_INTEGER);
    const ranked: { sessionId: string; rank: number }[] = [];
    for (const sessionId of ids) {
      const session = await this.sessionManager.peek(sessionId);
      if (session && typeof session.pinRank === "number") ranked.push({ sessionId, rank: session.pinRank });
    }
    ranked.sort((left, right) => left.rank - right.rank);
    return ranked.map((entry) => entry.sessionId);
  }

  /** Writes dense ranks in the given order, skipping the sessions already carrying theirs. */
  private async writePinOrder(ordered: string[]): Promise<void> {
    for (const [rank, sessionId] of ordered.entries()) {
      const session = await this.sessionManager.peek(sessionId);
      if (!session || session.pinRank === rank) continue;
      session.pinRank = rank;
      await this.sessionManager.persist(sessionId);
    }
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
