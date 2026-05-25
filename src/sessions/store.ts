import { readFile, mkdir, rename as fsRename, unlink, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";

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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    void log("warn", "corrupt session file, treating as empty", { sessionId, error: String(err) });
    return null;
  }
}

export async function saveSession(sessionId: string, data: SessionData): Promise<void> {
  const path = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  await writeJsonFileAtomically(path, data, true);
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
    hooks.emit("session:archived", { sessionId, archivePath: target });
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

const SESSION_STALE_DAYS = 30;

export async function pruneOldSessions(): Promise<number> {
  const cutoffMs = Date.now() - SESSION_STALE_DAYS * 86_400_000;
  let removed = 0;
  try {
    const entries = await scanSessionFiles(SESSIONS_DIR);
    for (const { path: filePath, mtimeMs } of entries) {
      if (mtimeMs < cutoffMs) {
        await rm(filePath, { force: true }).catch(() => {});
        removed += 1;
      }
    }
  } catch {
    // sessions dir may not exist
  }
  return removed;
}

async function scanSessionFiles(dir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const results: Array<{ path: string; mtimeMs: number }> = [];
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await scanSessionFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const s = await stat(full).catch(() => null);
      if (s) results.push({ path: full, mtimeMs: s.mtimeMs });
    }
  }
  return results;
}
