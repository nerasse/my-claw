import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { MY_CLAW_DIR } from "../config.ts";

export type SessionMessage =
  | { role: "user"; content: string; timestamp: string }
  | { role: "assistant"; content: string; timestamp: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; content: string; timestamp: string };

export interface SessionData {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
  messages: SessionMessage[];
  modelOverride?: string;
}

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function saveSession(sessionId: string, data: SessionData): Promise<void> {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

export async function deleteSession(sessionId: string): Promise<void> {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    await unlink(path);
  } catch {
    // file may not exist
  }
}
