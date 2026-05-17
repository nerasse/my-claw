import { readFile, writeFile, mkdir, unlink, rename as fsRename, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

export type SessionMessage =
  | { role: "user"; content: string; timestamp: string }
  | { role: "assistant"; content: string; timestamp: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; content: string; timestamp: string };

export interface SubAgentMeta {
  displayName: string;
  type: "general" | "research";
  workspaceDir?: string;
  createdBy: string;
  createdAt: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  apiCalls: number;
}

export interface SessionData {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
  messages: SessionMessage[];
  modelOverride?: string;
  roomId?: string;
  threadId?: string;
  verbose?: boolean;
  approvedTools?: string[];
  meta?: SubAgentMeta;
  tokenUsage?: TokenUsage;
}

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const ARCHIVES_DIR = join(MY_CLAW_DIR, "sessions-archive");

function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeSessionId(raw: string): string {
  return raw.replace(/\.\./g, "_").replace(/\0/g, "");
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function saveSession(sessionId: string, data: SessionData): Promise<void> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  const tmp = path + ".tmp";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await fsRename(tmp, path);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  try {
    await unlink(path);
  } catch {
    // file may not exist
  }
}

export async function archiveSession(sessionId: string): Promise<string | null> {
  const safe = sanitizeSessionId(sessionId);
  const source = join(SESSIONS_DIR, `${safe}.json`);
  const target = join(ARCHIVES_DIR, safe, `${archiveTimestamp()}.json`);
  try {
    await mkdir(dirname(target), { recursive: true });
    await fsRename(source, target);
    return target;
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function purgeArchiveDir(dir: string, beforeMs: number | null, all: boolean): Promise<number> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await purgeArchiveDir(path, beforeMs, all);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!all && beforeMs === null) continue;
    const stats = await stat(path).catch(() => null);
    if (!stats) continue;
    if (all || (beforeMs !== null && stats.mtimeMs <= beforeMs)) {
      await rm(path, { force: true });
      removed += 1;
    }
  }

  const remaining = await readdir(dir).catch(() => []);
  if (remaining.length === 0) {
    await rm(dir, { recursive: true, force: true });
  }
  return removed;
}

export async function purgeSessionArchives(options: {
  before?: Date;
  all?: boolean;
}): Promise<number> {
  const all = options.all === true;
  const beforeMs = options.before ? options.before.getTime() : null;
  if (!all && beforeMs === null) return 0;
  return purgeArchiveDir(ARCHIVES_DIR, beforeMs, all);
}
