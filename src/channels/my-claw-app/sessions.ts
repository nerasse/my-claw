import { basename } from "node:path";
import { SessionManager } from "../../sessions/manager.ts";
import { recordSessionCommand, recordSessionFailure } from "../../sessions/store.ts";
import { splitAttachmentBlock, stripLocationBlock } from "../../agent/preprocess.ts";
import { toolDisplayName } from "../../agent/tools/display.ts";
import { extractMediaRefs, stripMediaRefs, mediaTypeForPath } from "../../utils/media.ts";
import { DraftStore, type DraftWrite } from "./drafts.ts";
import { parseStoredName, type SessionFile, type SessionFileStore } from "./files.ts";
import { TOOL_OUTPUT_LIMIT } from "./stream.ts";
import type { MyClawAppHistoryAttachment, MyClawAppHistoryEntry, MyClawAppHistoryPage, MyClawAppSessionSummary } from "./types.ts";

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface MyClawAppSessionStore {
  resolveSessionId(owner: string, threadId: string): string;
  list(owner: string, limit?: number): Promise<MyClawAppSessionSummary[]>;
  history(owner: string, threadId: string, limit?: number, before?: number): Promise<MyClawAppHistoryPage>;
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
      const firstUser = session.messages.find((m) => m.role === "user");
      // Without the block, a "here, look" + photo would be titled by a server path.
      const firstText = firstUser ? stripLocationBlock(splitAttachmentBlock(firstUser.content).text) : "";
      const derived = firstText.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
      const title = session.title?.trim() || derived || (firstUser?.location ? "(location)" : "(new conversation)");
      summaries.push({
        threadId: sessionId.slice(sessionId.lastIndexOf("/") + 1),
        title,
        messageCount: session.messages.length,
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

    // `before` counts back from the newest message, so page N is the slice that ends where the
    // previous one began. Clamped rather than validated: a cursor past the start of a session
    // is an app that scrolled further than there is history, which is an empty page, not an error.
    const total = session.messages.length;
    const end = Math.max(total - Math.max(before, 0), 0);
    const rawStart = Math.max(end - Math.max(limit, 0), 0);
    const start = turnAlignedStart(session.messages, rawStart, MAX_TURN_LOOKBACK);
    const window = session.messages.slice(start, end);
    const hasMore = start > 0;
    const nextBefore = total - start;
    // Outputs live in the role:"tool" messages that follow the assistant turn, keyed by call id.
    const outputs = new Map<string, string>();
    for (const message of window) {
      if (message.role === "tool") outputs.set(message.toolCallId, message.content);
    }

    const stored = window.some((m) => m.role === "user" || m.content.includes("MEDIA:")) ? await this.files.list(owner, threadId) : [];

    const entries: MyClawAppHistoryEntry[] = [];
    // A command belongs to the page whose messages surround it in time. The newest page has no
    // upper bound, so a command typed after the last message (the usual case: a `/compact` at the
    // end of a turn) lands there rather than nowhere; an older page stops at the first message of
    // the page after it, so no command is ever replayed twice. The first page has no lower bound
    // either: a compaction drops messages the journal outlived, and a command older than every
    // surviving message must still surface somewhere rather than be silently unreachable.
    const lowerBound = hasMore ? (window[0]?.timestamp ?? "") : "";
    const upperBound = end < total ? session.messages[end]!.timestamp : undefined;
    const inPage = (ts: string): boolean => ts >= lowerBound && (upperBound === undefined || ts < upperBound);
    // Everything of the window, however much: a page that showed only the last twenty hid the rest
    // with no way to reach them, since a journal entry belongs to exactly one page. Commands and
    // failed runs share one timeline so they land in the order they happened.
    const asides: { ts: string; entries: MyClawAppHistoryEntry[] }[] = [];
    (session.commands ?? []).filter((entry) => inPage(entry.timestamp)).forEach((entry, index) => {
      asides.push({
        ts: entry.timestamp,
        entries: [
          // Same ids the live bubbles had, when the send is known: the device typed the command in
          // a bubble of its own and drew the answer in `cmd-<send id>`.
          { id: entry.sourceId ?? `c-${entry.timestamp}-${index}-in`, role: "user", text: entry.input, ts: entry.timestamp },
          {
            id: entry.sourceId ? `cmd-${entry.sourceId}` : `c-${entry.timestamp}-${index}-out`,
            role: "assistant",
            text: entry.output,
            ts: entry.timestamp,
            command: true,
            ...(entry.details ? { details: entry.details } : {}),
          },
        ],
      });
    });
    // A failed run replays as the error bubble the owner saw live, under the question it never
    // answered: the mirror keeps that question now, and a question with nothing under it reads as
    // a message the agent ignored.
    (session.failures ?? []).filter((entry) => inPage(entry.timestamp)).forEach((entry, index) => {
      asides.push({
        ts: entry.timestamp,
        entries: [{ id: `f-${entry.timestamp}-${index}`, role: "assistant", text: "", ts: entry.timestamp, error: entry.error }],
      });
    });
    asides.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let nextAside = 0;
    // Flushed as the messages are walked, so an aside sits where it happened rather than in a
    // block at one end of the page.
    const flushCommandsUpTo = (limit?: string): void => {
      while (nextAside < asides.length) {
        const aside = asides[nextAside]!;
        if (limit !== undefined && aside.ts > limit) return;
        nextAside += 1;
        entries.push(...aside.entries);
      }
    };

    for (const message of window) {
      flushCommandsUpTo(message.timestamp);
      if (message.role === "user") {
        const block = splitAttachmentBlock(message.content);
        const { text, spoken } = splitTranscript(block.text);
        const resolved = historyAttachments(block.attachments, stored);
        // `[Audio 1]`, `[Audio 2]` are written in the order the recordings were attached, and
        // the block lists them in that same order, so position is what pairs them back up.
        const transcripts: Record<string, string> = {};
        const recordings = resolved.filter((entry) => entry.type === "audio");
        for (let i = 0; i < recordings.length && i < spoken.length; i++) {
          transcripts[recordings[i]!.id] = spoken[i]!;
        }
        entries.push({
          // The device's own bubble id when the message came from it, so a page can be merged
          // with a thread already on screen: the question of a run in flight is then recognised
          // rather than duplicated -- docs/my-claw-app-channel.md.
          id: message.sourceId ?? `h-${message.timestamp}-${entries.length}`,
          role: "user",
          text: stripLocationBlock(text),
          ts: message.timestamp,
          ...(Object.keys(transcripts).length > 0 ? { transcripts } : {}),
          ...(resolved.length > 0 ? { attachments: resolved } : {}),
          ...(message.location ? { location: message.location } : {}),
        });
        continue;
      }
      if (message.role !== "assistant") continue;
      // One bubble per thinking phase, exactly where the live stream closed one and opened the
      // next. Without the cuts the turn came back as a single bubble with every thought stacked
      // above text they were not about -- docs/reasoning-visibility.md. A turn with one phase is
      // stored without them, and is its own only phase.
      const phases: HistoryPhase[] = message.segments ?? [
        {
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
          ...(message.reasoningTokens ? { reasoningTokens: message.reasoningTokens } : {}),
          content: message.content,
        },
      ];
      for (const phase of phases) {
        // The agent names its files with MEDIA: refs, but a replayed turn must show real
        // attachments: resolve each ref against the thread's store, like the user side does.
        const refs = extractMediaRefs(phase.content);
        const text = stripMediaRefs(phase.content).trim();
        const media = refs.length > 0 ? mediaRefAttachments(refs, stored) : [];
        const tokens = phase.reasoningTokens;
        // A phase that thought and then called a tool wrote no prose, and the bubble the reader
        // saw was that thought: dropping it here is what made a reopened thread jump from the
        // question to a tool card.
        if (!text && media.length === 0 && !phase.reasoning?.trim() && !tokens) continue;
        entries.push({
          id: `h-${message.timestamp}-${entries.length}`,
          role: "assistant",
          text,
          ts: message.timestamp,
          ...(media.length > 0 ? { attachments: media } : {}),
          ...(phase.reasoning ? { reasoning: phase.reasoning } : {}),
          ...(tokens ? { reasoningTokens: tokens } : {}),
        });
      }
      // Same shape as the live chat.tool frames so a reopened thread renders identical cards.
      for (const call of message.toolCalls ?? []) {
        const output = outputs.get(call.id) ?? "";
        const truncated = output.length > TOOL_OUTPUT_LIMIT;
        entries.push({
          id: `h-${message.timestamp}-${entries.length}`,
          role: "tool",
          // Sessions written before the mirror was cleaned still hold `mcp__myclaw__bash`, the
          // name the SDK gives our own tools; the card must show the tool, not the plumbing.
          name: toolDisplayName(call.name),
          args: parseToolArguments(call.arguments),
          durationMs: call.durationMs,
          ok: true,
          output: truncated ? output.slice(0, TOOL_OUTPUT_LIMIT) : output,
          truncated,
          ts: message.timestamp,
        });
      }
    }
    flushCommandsUpTo();
    return { entries, hasMore, nextBefore, ...(draft ? { draft } : {}) };
  }

  async recordFailure(owner: string, threadId: string, error: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) return;
    recordSessionFailure(session, error);
    await this.sessionManager.persist(sessionId);
  }

  async recordCommand(owner: string, threadId: string, input: string, output: string, details?: string, sourceId?: string): Promise<void> {
    const sessionId = this.resolveSessionId(owner, threadId);
    const session = await this.sessionManager.peek(sessionId);
    if (!session) return;
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
}
