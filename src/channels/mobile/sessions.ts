import { SessionManager } from "../../sessions/manager.ts";
import { loadSession } from "../../sessions/store.ts";
import type { MobileHistoryEntry, MobileSessionSummary } from "./types.ts";

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface MobileSessionStore {
  resolveSessionId(deviceId: string, threadId: string): string;
  list(deviceId: string, limit?: number): Promise<MobileSessionSummary[]>;
  history(deviceId: string, threadId: string, limit?: number): Promise<MobileHistoryEntry[]>;
  archive(deviceId: string, threadId: string): Promise<void>;
  remove(deviceId: string, threadId: string): Promise<void>;
}

/** Thread ids come from the device and later land in file paths; keep them strictly safe. */
export function sanitizeThreadId(raw: string): string | null {
  if (THREAD_ID_PATTERN.test(raw)) return raw;
  return null;
}

const HISTORY_LIMIT = 50;

export class MobileSessionStoreImpl implements MobileSessionStore {
  constructor(private sessionManager: SessionManager) {}

  resolveSessionId(deviceId: string, threadId: string): string {
    return SessionManager.resolveSessionId("mobile", "dm", deviceId, deviceId, {
      threadId,
      sessionScope: "per-user",
    });
  }

  async list(deviceId: string, limit = 50): Promise<MobileSessionSummary[]> {
    const ids = await this.sessionManager.listSessions(`mobile/thread/${deviceId}/`, limit);
    const summaries: MobileSessionSummary[] = [];
    for (const sessionId of ids) {
      const session = await loadSession(sessionId);
      if (!session) continue;
      const firstUser = session.messages.find((m) => m.role === "user");
      const title = firstUser?.content.trim().replace(/\s+/g, " ").slice(0, 60) || "(nouvelle conversation)";
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

  async history(deviceId: string, threadId: string, limit = HISTORY_LIMIT): Promise<MobileHistoryEntry[]> {
    const session = await loadSession(this.resolveSessionId(deviceId, threadId));
    if (!session) return [];

    const entries: MobileHistoryEntry[] = [];
    for (const message of session.messages.slice(-limit)) {
      if (message.role === "user") {
        entries.push({ id: `h-${message.timestamp}-${entries.length}`, role: "user", text: message.content, ts: message.timestamp });
      } else if (message.role === "assistant") {
        // Reproduce the live tool-use notes so a reopened conversation matches what was streamed.
        const toolNote = message.toolCalls?.length
          ? `\n\n> ${message.toolCalls.map((call) => call.name).join(", ")}`
          : "";
        const text = `${message.content}${toolNote}`.trim();
        if (!text) continue;
        entries.push({ id: `h-${message.timestamp}-${entries.length}`, role: "assistant", text, ts: message.timestamp });
      }
    }
    return entries;
  }

  async archive(deviceId: string, threadId: string): Promise<void> {
    await this.sessionManager.resetSession(this.resolveSessionId(deviceId, threadId), "mobile", "dm");
  }

  async remove(deviceId: string, threadId: string): Promise<void> {
    await this.sessionManager.deleteSession(this.resolveSessionId(deviceId, threadId));
  }
}
