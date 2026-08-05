import { SessionManager } from "../../sessions/manager.ts";
import { loadSession } from "../../sessions/store.ts";
import { MOBILE_TOOL_OUTPUT_LIMIT } from "./stream.ts";
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

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return { raw };
  }
}

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
      const title = firstUser?.content.trim().replace(/\s+/g, " ").slice(0, 60) || "(new conversation)";
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

    const window = session.messages.slice(-limit);
    // Outputs live in the role:"tool" messages that follow the assistant turn, keyed by call id.
    const outputs = new Map<string, string>();
    for (const message of window) {
      if (message.role === "tool") outputs.set(message.toolCallId, message.content);
    }

    const entries: MobileHistoryEntry[] = [];
    for (const message of window) {
      if (message.role === "user") {
        entries.push({ id: `h-${message.timestamp}-${entries.length}`, role: "user", text: message.content, ts: message.timestamp });
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
        const truncated = output.length > MOBILE_TOOL_OUTPUT_LIMIT;
        entries.push({
          id: `h-${message.timestamp}-${entries.length}`,
          role: "tool",
          name: call.name,
          args: parseToolArguments(call.arguments),
          durationMs: call.durationMs,
          ok: true,
          output: truncated ? output.slice(0, MOBILE_TOOL_OUTPUT_LIMIT) : output,
          truncated,
          ts: message.timestamp,
        });
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
