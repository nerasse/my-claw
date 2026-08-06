import { basename } from "node:path";
import { SessionManager } from "../../sessions/manager.ts";
import { loadSession } from "../../sessions/store.ts";
import { splitAttachmentBlock } from "../../agent/preprocess.ts";
import { parseStoredName, type SessionFile, type SessionFileStore } from "./files.ts";
import { TOOL_OUTPUT_LIMIT } from "./stream.ts";
import type { MyClawAppHistoryAttachment, MyClawAppHistoryEntry, MyClawAppSessionSummary } from "./types.ts";

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface MyClawAppSessionStore {
  resolveSessionId(owner: string, threadId: string): string;
  list(owner: string, limit?: number): Promise<MyClawAppSessionSummary[]>;
  history(owner: string, threadId: string, limit?: number): Promise<MyClawAppHistoryEntry[]>;
  archive(owner: string, threadId: string): Promise<void>;
  remove(owner: string, threadId: string): Promise<void>;
}

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
function historyAttachments(entries: ReturnType<typeof splitAttachmentBlock>["attachments"], files: SessionFile[]): MyClawAppHistoryAttachment[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const out: MyClawAppHistoryAttachment[] = [];
  for (const entry of entries) {
    const parsed = parseStoredName(basename(entry.source));
    if (!parsed) continue;
    const file = byId.get(parsed.id);
    if (file) {
      out.push({ id: file.id, type: file.type, mimeType: file.mimeType, filename: file.filename, sizeBytes: file.sizeBytes });
    } else {
      const type = entry.type === "image" || entry.type === "audio" || entry.type === "video" ? entry.type : "file";
      out.push({ id: parsed.id, type, filename: parsed.filename, deleted: true });
    }
  }
  return out;
}

export class MyClawAppSessionStoreImpl implements MyClawAppSessionStore {
  constructor(
    private sessionManager: SessionManager,
    private files: SessionFileStore,
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
      const firstText = firstUser ? splitAttachmentBlock(firstUser.content).text : "";
      const title = firstText.trim().replace(/\s+/g, " ").slice(0, 60) || "(new conversation)";
      summaries.push({
        threadId: sessionId.slice(sessionId.lastIndexOf("/") + 1),
        title,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      });
    }
    return summaries;
  }

  async history(owner: string, threadId: string, limit = HISTORY_LIMIT): Promise<MyClawAppHistoryEntry[]> {
    const session = await loadSession(this.resolveSessionId(owner, threadId));
    if (!session) return [];

    const window = session.messages.slice(-limit);
    // Outputs live in the role:"tool" messages that follow the assistant turn, keyed by call id.
    const outputs = new Map<string, string>();
    for (const message of window) {
      if (message.role === "tool") outputs.set(message.toolCallId, message.content);
    }

    const stored = window.some((m) => m.role === "user") ? await this.files.list(owner, threadId) : [];

    const entries: MyClawAppHistoryEntry[] = [];
    for (const message of window) {
      if (message.role === "user") {
        const { text, attachments } = splitAttachmentBlock(message.content);
        const resolved = historyAttachments(attachments, stored);
        entries.push({
          id: `h-${message.timestamp}-${entries.length}`,
          role: "user",
          text,
          ts: message.timestamp,
          ...(resolved.length > 0 ? { attachments: resolved } : {}),
        });
        continue;
      }
      if (message.role !== "assistant") continue;
      const text = message.content.trim();
      if (text) {
        entries.push({ id: `h-${message.timestamp}-${entries.length}`, role: "assistant", text, ts: message.timestamp });
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
    return entries;
  }

  async archive(owner: string, threadId: string): Promise<void> {
    await this.sessionManager.resetSession(this.resolveSessionId(owner, threadId), "my-claw-app", "dm");
  }

  async remove(owner: string, threadId: string): Promise<void> {
    await this.sessionManager.deleteSession(this.resolveSessionId(owner, threadId));
  }
}
