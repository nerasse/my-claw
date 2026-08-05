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

/**
 * Slicing history to a fixed tail (keep the last N) can cut inside a tool block, leaving the
 * kept head starting with orphan `tool` messages whose owning assistant `tool_calls` were
 * dropped. OpenAI-compatible APIs reject that with HTTP 400, wedging the session on every
 * subsequent turn. Dropping the leading orphan tool messages restores a valid boundary.
 */
export function dropLeadingOrphanToolMessages(messages: SessionMessage[]): SessionMessage[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === "tool") start++;
  return start === 0 ? messages : messages.slice(start);
}

/** Trim to the last `keep` messages, then repair the boundary (see above). */
export function trimSessionMessages(messages: SessionMessage[], keep: number): SessionMessage[] {
  return dropLeadingOrphanToolMessages(messages.slice(-keep));
}

/**
 * Guarantee no assistant tool_call is left without a tool response. An aborted run can stop
 * between the tool request and its result; OpenAI-compatible APIs reject a request whose
 * assistant tool_calls are unanswered, which wedges every later turn on that session. Appends a
 * synthetic result for any dangling id in the last assistant message.
 */
export function sealDanglingToolCalls(messages: SessionMessage[]): number {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return 0;
  const assistant = messages[lastAssistantIdx]!;
  if (assistant.role !== "assistant" || !assistant.toolCalls?.length) return 0;

  const answered = new Set<string>();
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "tool" && msg.toolCallId) answered.add(msg.toolCallId);
  }

  let sealed = 0;
  for (const call of assistant.toolCalls) {
    if (answered.has(call.id)) continue;
    messages.push({ role: "tool", toolCallId: call.id, content: "[Stopped by user]", timestamp: new Date().toISOString() });
    sealed += 1;
  }
  return sealed;
}

export interface SubAgentMeta {
  displayName: string;
  type: "general" | "research";
  workspaceDir?: string;
  // Session that spawned this agent. Recorded once, at creation, because parentage is a property
  // of the agent rather than of a run -- so it survives restarts and needs no argument threading.
  parentSessionId: string;
  // Sub-agents are addressable from any chat by default, which is the point. A private one is
  // only visible and drivable from parentSessionId. One-shot agents are always private: they are
  // unnamed and short-lived, and were invisible before they had metadata at all.
  visibility: "global" | "private";
  createdAt: string;
}

/**
 * Who a session's API calls should be billed to, strongest evidence first: the session that
 * triggered this run, then the one that created the agent, then itself.
 *
 * Recording self rather than null for a top-level chat keeps `WHERE parent_session_id = ?`
 * rollups complete without a COALESCE, and makes a missing parent show up as an unattributed
 * agent instead of silently misfiling tokens onto the wrong conversation.
 */
export function attributionParent(session: SessionData): string {
  // Truthiness, not nullish coalescing: callers default a missing session id to "", and an empty
  // parent is worse than no parent -- it would group unrelated work under a blank key.
  return session.invokedBy || session.meta?.parentSessionId || session.id;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  apiCalls: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SessionData {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
  messages: SessionMessage[];
  modelOverride?: string;
  effortOverride?: import("../core/config.ts").EffortLevel;
  // Context ceiling chosen for this conversation alone: "full" for the model's whole window, or an
  // explicit number that may also sit below the standing cap. Sub-agents are sessions too, so each
  // one carries its own independently of the chat that spawned it. See docs/context-window.md.
  contextOverride?: import("../llm/context-window.ts").ContextOverride;
  // Prompt size the provider actually billed on the last call, with the message count it covered.
  // The compaction gate needs a real number: chars/4 under-counts by ~2.3x on live traffic.
  lastPrompt?: import("../llm/context-window.ts").MeasuredPrompt;
  roomId?: string;
  threadId?: string;
  verbose?: boolean;
  approvedTools?: string[];
  meta?: SubAgentMeta;
  // Session that triggered the run currently executing, set by the runner before each run. A
  // global sub-agent can be driven from a chat other than the one that created it, so the creator
  // in `meta` is only a fallback: attribution follows whoever asked for this run.
  invokedBy?: string;
  tokenUsage?: TokenUsage;
  // Claude Agent SDK session to resume on the claude-sdk backend. The SDK owns that
  // history; `messages` is only a mirror for UI/commands/archives on that path.
  sdkSessionId?: string;
  // Timestamp of the newest transcript entry the SDK session already knows about, so turns
  // taken on the home backend in between can be replayed instead of silently vanishing.
  sdkSyncedAt?: string;
  // Last time local history was replayed into a fresh SDK session (crossing from the home
  // backend). Kept so /status can report it, since the transfer is otherwise invisible.
  contextTransfer?: {
    at: string;
    model: string;
    messages: number;
    dropped: number;
    tokens: number;
  };
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

/** All persisted session ids under a prefix, most recently active first. */
export async function listSessionIdsByPrefix(prefix: string, limit = 50): Promise<string[]> {
  const files = await scanSessionFiles(SESSIONS_DIR);
  const ids: Array<{ id: string; mtimeMs: number }> = [];
  for (const { path, mtimeMs } of files) {
    if (!path.endsWith(".json")) continue;
    const rel = path.slice(SESSIONS_DIR.length + 1, -".json".length);
    const id = rel.replace(/\\/g, "/");
    if (id.startsWith(prefix)) ids.push({ id, mtimeMs });
  }
  return ids
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Remove every archive snapshot of a session (used by hard delete). */
export async function deleteSessionArchives(sessionId: string): Promise<void> {
  const safe = sanitizeSessionId(sessionId);
  await rm(join(ARCHIVES_DIR, safe), { recursive: true, force: true }).catch(() => {});
}
