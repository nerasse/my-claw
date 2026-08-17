import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import { log } from "../utils/logger.ts";

export type ConversationRole = "user" | "assistant";
export type ConversationSourceKind = "channel" | "assistant" | "session";

export interface ConversationHit {
  id: string;
  platform: string;
  chatId?: string;
  chatType?: string;
  threadId?: string;
  sessionId?: string;
  agentType?: string;
  role: ConversationRole;
  timestamp: string;
  snippet: string;
  score: number;
}

export interface ConversationMessage {
  id: string;
  platform: string;
  chatId?: string;
  chatType?: string;
  threadId?: string;
  sessionId?: string;
  agentType?: string;
  role: ConversationRole;
  timestamp: string;
  content: string;
}

export interface ConversationSearchOptions {
  query: string;
  platform?: string;
  chatId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ConversationReadResult {
  hit: ConversationMessage;
  context: ConversationMessage[];
}

type ConversationRow = {
  id: number;
};

type MessageRow = {
  id: number;
  platform: string;
  chat_id: string | null;
  chat_type: string | null;
  thread_id: string | null;
  session_id: string | null;
  agent_type: string | null;
  role: ConversationRole;
  occurred_at: string;
  content: string;
  bm25?: number;
};

let db: Database | null = null;

function databasePath(): string {
  return process.env["MY_CLAW_CONVERSATIONS_DB"] ?? join(MY_CLAW_DIR, "conversations.db");
}

function getDb(): Database {
  if (db) return db;

  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL UNIQUE,
      platform        TEXT NOT NULL,
      chat_id         TEXT,
      chat_type       TEXT,
      thread_id       TEXT,
      created_at      TEXT NOT NULL,
      last_message_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      source_id         TEXT NOT NULL UNIQUE,
      source_kind       TEXT NOT NULL CHECK (source_kind IN ('channel', 'assistant', 'session')),
      platform          TEXT NOT NULL,
      chat_id           TEXT,
      chat_type         TEXT,
      thread_id         TEXT,
      session_id        TEXT,
      parent_session_id TEXT,
      agent_type        TEXT,
      sender_id         TEXT,
      role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content           TEXT NOT NULL,
      occurred_at       TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_platform_chat
      ON conversations(platform, chat_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
      ON messages(conversation_id, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_messages_platform_time
      ON messages(platform, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, tokenize='unicode61 remove_diacritics 2');
  `);
  return db;
}

function now(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 20);
}

function sourceIdForSession(sessionId: string, role: ConversationRole, timestamp: string, content: string): string {
  return `session:${hashContent(`${sessionId}\0${role}\0${timestamp}\0${content}`)}`;
}

function conversationKey(parts: Array<string | undefined>): string {
  return JSON.stringify(parts.map((part) => part ?? ""));
}

function getConversationId(input: {
  key: string;
  platform: string;
  chatId?: string;
  chatType?: string;
  threadId?: string;
  timestamp: string;
}): number {
  const d = getDb();
  d.prepare(
    `INSERT OR IGNORE INTO conversations
       (conversation_key, platform, chat_id, chat_type, thread_id, created_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.key,
    input.platform,
    input.chatId ?? null,
    input.chatType ?? null,
    input.threadId ?? null,
    input.timestamp,
    input.timestamp,
  );
  d.prepare(
    `UPDATE conversations
     SET last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END
     WHERE conversation_key = ?`,
  ).run(input.timestamp, input.timestamp, input.key);
  const row = d.prepare("SELECT id FROM conversations WHERE conversation_key = ?").get(input.key) as ConversationRow;
  return Number(row.id);
}

function insertMessage(input: {
  sourceId: string;
  sourceKind: ConversationSourceKind;
  platform: string;
  chatId?: string;
  chatType?: string;
  threadId?: string;
  sessionId?: string;
  parentSessionId?: string;
  agentType?: string;
  senderId?: string;
  role: ConversationRole;
  content: string;
  occurredAt: string;
  conversationKey: string;
}): void {
  const content = input.content.trim();
  if (!content) return;

  const d = getDb();
  const conversationId = getConversationId({
    key: input.conversationKey,
    platform: input.platform,
    chatId: input.chatId,
    chatType: input.chatType,
    threadId: input.threadId,
    timestamp: input.occurredAt,
  });
  // The row and its FTS shadow are one write: a failure in between archives a message that the
  // conversation search can never find again.
  const insert = d.transaction((): void => {
  const result = d.prepare(
    `INSERT OR IGNORE INTO messages (
       conversation_id, source_id, source_kind, platform, chat_id, chat_type, thread_id,
       session_id, parent_session_id, agent_type, sender_id, role, content, occurred_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId,
    input.sourceId,
    input.sourceKind,
    input.platform,
    input.chatId ?? null,
    input.chatType ?? null,
    input.threadId ?? null,
    input.sessionId ?? null,
    input.parentSessionId ?? null,
    input.agentType ?? null,
    input.senderId ?? null,
    input.role,
    content,
    input.occurredAt,
    now(),
  );
  if (Number(result.changes ?? 0) === 0) {
    // Same message, seen twice: a channel archives what it received, the router archives what
    // the run actually read. The second pass carries the voice note's transcript, and dropping
    // it left everything ever said out loud out of the search index.
    const existing = d.prepare("SELECT id, content FROM messages WHERE source_id = ?")
      .get(input.sourceId) as { id: number; content: string } | null;
    if (!existing || existing.content === content) return;
    d.prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, existing.id);
    d.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(existing.id);
    d.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(existing.id, content);
    return;
  }

  const row = d.prepare("SELECT id FROM messages WHERE source_id = ?").get(input.sourceId) as { id: number } | null;
  if (!row) return;
  d.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(row.id, content);
  });
  insert();
}

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return now();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now() : parsed.toISOString();
}

function sessionAddress(session: SessionData): {
  platform: string;
  chatId?: string;
  chatType?: string;
  threadId?: string;
  key: string;
} {
  if (session.meta) {
    return {
      platform: "subagent",
      chatType: session.chatType,
      key: conversationKey(["subagent", session.id]),
    };
  }

  const parts = session.id.split("/");
  const platform = session.platform;
  if (parts.length >= 3 && parts[1] === "thread") {
    return {
      platform,
      chatId: parts[2],
      chatType: session.chatType,
      threadId: parts[3],
      key: conversationKey([platform, parts[2], parts[3]]),
    };
  }
  if (parts.length >= 3) {
    return {
      platform,
      chatId: parts[2],
      chatType: session.chatType,
      key: conversationKey([platform, parts[2], ""]),
    };
  }
  return {
    platform,
    chatType: session.chatType,
    key: conversationKey(["session", session.id]),
  };
}

function messageFromRow(row: MessageRow): ConversationMessage {
  return {
    id: `m_${row.id}`,
    platform: row.platform,
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    ...(row.chat_type ? { chatType: row.chat_type } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.agent_type ? { agentType: row.agent_type } : {}),
    role: row.role,
    timestamp: row.occurred_at,
    content: row.content,
  };
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter(Boolean);
}

function toFtsQuery(query: string): string {
  return queryTokens(query).map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
}

function makeSnippet(content: string, query: string): string {
  const max = 320;
  if (content.length <= max) return content;
  const tokens = queryTokens(query);
  const lower = content.toLocaleLowerCase();
  const hit = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(hit - 100, content.length - max));
  const prefix = start > 0 ? "..." : "";
  const suffix = start + max < content.length ? "..." : "";
  return `${prefix}${content.slice(start, start + max)}${suffix}`;
}

export function archiveChannelMessage(message: UnifiedMessage): void {
  try {
    // Slash commands are control-plane input and may contain credentials (for example /claude set-token).
    if (message.text.trim().startsWith("/")) return;
    const timestamp = normalizeTimestamp(message.timestamp);
    insertMessage({
      sourceId: `channel:${message.platform}:${message.chatId}:${message.id}`,
      sourceKind: "channel",
      platform: message.platform,
      chatId: message.chatId,
      chatType: message.chatType,
      threadId: message.threadId,
      senderId: message.userId,
      role: "user",
      content: message.text,
      occurredAt: timestamp,
      conversationKey: conversationKey([message.platform, message.chatId, message.threadId ?? ""]),
    });
  } catch (error) {
    void log("warn", "conversation archive inbound write failed", { error: String(error) });
  }
}

export function archiveAssistantMessage(message: UnifiedMessage, sessionId: string, content: string): void {
  try {
    const timestamp = now();
    insertMessage({
      sourceId: `assistant:${sessionId}:${message.id}`,
      sourceKind: "assistant",
      platform: message.platform,
      chatId: message.chatId,
      chatType: message.chatType,
      threadId: message.threadId,
      sessionId,
      agentType: sessionId.startsWith("subagent/") ? "subagent" : message.platform === "cron" ? "cron" : "main",
      role: "assistant",
      content,
      occurredAt: timestamp,
      conversationKey: conversationKey([message.platform, message.chatId, message.threadId ?? ""]),
    });
  } catch (error) {
    void log("warn", "conversation archive assistant write failed", { error: String(error) });
  }
}

export function indexSessionArchive(session: SessionData): number {
  try {
    const address = sessionAddress(session);
    let indexed = 0;
    for (const message of session.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const sourceId = sourceIdForSession(session.id, message.role, message.timestamp, message.content);
      const before = countBySourceId(sourceId);
      insertMessage({
        sourceId,
        sourceKind: "session",
        platform: address.platform,
        chatId: address.chatId,
        chatType: address.chatType,
        threadId: address.threadId,
        sessionId: session.id,
        parentSessionId: session.invokedBy ?? session.meta?.parentSessionId,
        agentType: session.meta?.type ?? (session.platform === "cron" ? "cron" : "main"),
        role: message.role,
        content: message.content,
        occurredAt: normalizeTimestamp(message.timestamp),
        conversationKey: address.key,
      });
      indexed += before === 0 ? 1 : 0;
    }
    return indexed;
  } catch (error) {
    void log("warn", "conversation archive session write failed", { sessionId: session.id, error: String(error) });
    return 0;
  }
}

function countBySourceId(sourceId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM messages WHERE source_id = ?").get(sourceId) as { count: number };
  return Number(row.count ?? 0);
}

export function searchConversationArchive(options: ConversationSearchOptions): ConversationHit[] {
  const match = toFtsQuery(options.query);
  if (!match) return [];

  const limit = Math.max(1, Math.min(options.limit ?? 10, 20));
  const where = ["messages_fts MATCH ?"];
  const params: Array<string | number> = [match];
  if (options.platform) {
    where.push("m.platform = ?");
    params.push(options.platform);
  }
  if (options.chatId) {
    where.push("m.chat_id = ?");
    params.push(options.chatId);
  }
  if (options.from) {
    where.push("m.occurred_at >= ?");
    params.push(normalizeTimestamp(options.from));
  }
  if (options.to) {
    where.push("m.occurred_at <= ?");
    params.push(normalizeTimestamp(options.to));
  }

  const rows = getDb()
    .prepare(
      `SELECT m.id, m.platform, m.chat_id, m.chat_type, m.thread_id, m.session_id,
              m.agent_type, m.role, m.occurred_at, m.content, bm25(messages_fts) AS bm25
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY bm25 ASC, m.occurred_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as MessageRow[];

  return rows.map((row) => ({
    ...messageFromRow(row),
    snippet: makeSnippet(row.content, options.query),
    score: Math.max(0, -(row.bm25 ?? 0)),
  }));
}

function readRow(id: number): MessageRow | null {
  return (getDb().prepare(
    `SELECT id, platform, chat_id, chat_type, thread_id, session_id, agent_type,
            role, occurred_at, content
     FROM messages WHERE id = ?`,
  ).get(id) as MessageRow | null) ?? null;
}

export function readConversationHit(hitId: string, before = 2, after = 2): ConversationReadResult | null {
  const match = /^m_(\d+)$/.exec(hitId.trim());
  if (!match) return null;
  const id = Number(match[1]);
  const hit = readRow(id);
  if (!hit) return null;

  const boundedBefore = Math.max(0, Math.min(before, 10));
  const boundedAfter = Math.max(0, Math.min(after, 10));
  const d = getDb();
  const older = d
    .prepare(
      `SELECT id, platform, chat_id, chat_type, thread_id, session_id, agent_type,
              role, occurred_at, content
       FROM messages WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
         AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(id, hit.occurred_at, hit.occurred_at, id, boundedBefore) as MessageRow[];
  const newer = d
    .prepare(
      `SELECT id, platform, chat_id, chat_type, thread_id, session_id, agent_type,
              role, occurred_at, content
       FROM messages WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
         AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
       ORDER BY occurred_at ASC, id ASC LIMIT ?`,
    )
    .all(id, hit.occurred_at, hit.occurred_at, id, boundedAfter) as MessageRow[];
  return {
    hit: messageFromRow(hit),
    context: [...older.reverse(), hit, ...newer].map(messageFromRow),
  };
}

async function listJsonFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listJsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
  }
  return result;
}

export async function backfillConversationArchive(): Promise<number> {
  const marker = getDb()
    .prepare("SELECT value FROM archive_meta WHERE key = ?")
    .get("session-backfill-v1") as { value?: string } | null;
  if (marker?.value === "done") return 0;

  const paths = [
    ...(await listJsonFiles(join(MY_CLAW_DIR, "sessions"))),
    ...(await listJsonFiles(join(MY_CLAW_DIR, "sessions-archive"))),
  ];
  let indexed = 0;
  for (const path of paths) {
    try {
      const session = JSON.parse(await readFile(path, "utf8")) as SessionData;
      if (session?.id && Array.isArray(session.messages)) indexed += indexSessionArchive(session);
    } catch {
      // A corrupt or partially-written historical session must not block startup.
    }
  }
  getDb()
    .prepare("INSERT OR REPLACE INTO archive_meta(key, value) VALUES (?, ?)")
    .run("session-backfill-v1", "done");
  return indexed;
}

export function closeConversationArchive(): void {
  if (!db) return;
  db.close();
  db = null;
}
