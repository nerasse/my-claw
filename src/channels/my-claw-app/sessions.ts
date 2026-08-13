import { basename } from "node:path";
import { SessionManager } from "../../sessions/manager.ts";
import { loadSession } from "../../sessions/store.ts";
import { splitAttachmentBlock, stripLocationBlock } from "../../agent/preprocess.ts";
import { extractMediaRefs, stripMediaRefs, mediaTypeForPath } from "../../utils/media.ts";
import { parseStoredName, type SessionFile, type SessionFileStore } from "./files.ts";
import { TOOL_OUTPUT_LIMIT } from "./stream.ts";
import type { MyClawAppHistoryAttachment, MyClawAppHistoryEntry, MyClawAppHistoryPage, MyClawAppSessionSummary } from "./types.ts";

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface MyClawAppSessionStore {
  resolveSessionId(owner: string, threadId: string): string;
  list(owner: string, limit?: number): Promise<MyClawAppSessionSummary[]>;
  history(owner: string, threadId: string, limit?: number, before?: number): Promise<MyClawAppHistoryPage>;
  /** Files the thread away, reversibly: no message is moved, deleted or snapshotted. */
  archive(owner: string, threadId: string): Promise<void>;
  unarchive(owner: string, threadId: string): Promise<void>;
  remove(owner: string, threadId: string): Promise<void>;
  rename(owner: string, threadId: string, title: string): Promise<void>;
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
  ) {}

  resolveSessionId(owner: string, threadId: string): string {
    return SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, {
      threadId,
      sessionScope: "per-user",
    });
  }

  async list(owner: string, limit = 200): Promise<MyClawAppSessionSummary[]> {
    const ids = await this.sessionManager.listSessions(`my-claw-app/thread/${owner}/`, limit);
    const summaries: MyClawAppSessionSummary[] = [];
    for (const sessionId of ids) {
      const session = await loadSession(sessionId);
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
        workspace: session.workspace ?? "default",
      });
    }
    return summaries;
  }

  async history(owner: string, threadId: string, limit = HISTORY_LIMIT, before = 0): Promise<MyClawAppHistoryPage> {
    const session = await loadSession(this.resolveSessionId(owner, threadId));
    if (!session) return { entries: [], hasMore: false, nextBefore: before };

    // `before` counts back from the newest message, so page N is the slice that ends where the
    // previous one began. Clamped rather than validated: a cursor past the start of a session
    // is an app that scrolled further than there is history, which is an empty page, not an error.
    const total = session.messages.length;
    const end = Math.max(total - Math.max(before, 0), 0);
    const start = Math.max(end - Math.max(limit, 0), 0);
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
    for (const message of window) {
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
          id: `h-${message.timestamp}-${entries.length}`,
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
      // The agent names its files with MEDIA: refs, but a replayed turn must show real
      // attachments: resolve each ref against the thread's store, like the user side does.
      const refs = extractMediaRefs(message.content);
      const text = stripMediaRefs(message.content).trim();
      const media = refs.length > 0 ? mediaRefAttachments(refs, stored) : [];
      if (text || media.length > 0) {
        entries.push({
          id: `h-${message.timestamp}-${entries.length}`,
          role: "assistant",
          text,
          ts: message.timestamp,
          ...(media.length > 0 ? { attachments: media } : {}),
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        });
      }
      // Same shape as the live chat.tool frames so a reopened thread renders identical cards.
      for (const call of message.toolCalls ?? []) {
        const output = outputs.get(call.id) ?? "";
        const truncated = output.length > TOOL_OUTPUT_LIMIT;
        entries.push({
          id: `h-${message.timestamp}-${entries.length}`,
          role: "tool",
          name: call.name,
          args: parseToolArguments(call.arguments),
          durationMs: call.durationMs,
          ok: true,
          output: truncated ? output.slice(0, TOOL_OUTPUT_LIMIT) : output,
          truncated,
          ts: message.timestamp,
        });
      }
    }
    return { entries, hasMore, nextBefore };
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
}
