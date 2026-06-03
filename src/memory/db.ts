import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { type MemoryCategory, type MemoryEntry, isMemoryCategory } from "./types.ts";

let db: Database | null = null;

function dbPath(): string {
  return process.env["MY_CLAW_MEMORY_DB"] ?? join(MY_CLAW_DIR, "memory.db");
}

function getDb(): Database {
  if (db) return db;

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      content         TEXT    NOT NULL,
      category        TEXT    NOT NULL DEFAULT 'lesson',
      embedding       BLOB,
      embedding_model TEXT,
      hash            TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      superseded_by   INTEGER,
      access_count    INTEGER NOT NULL DEFAULT 0,
      last_access     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_hash       ON entries (hash);
    CREATE INDEX IF NOT EXISTS idx_entries_category   ON entries (category);
    CREATE INDEX IF NOT EXISTS idx_entries_superseded ON entries (superseded_by);

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, tokenize='unicode61');
  `);

  ensureColumn(db, "entries", "embedding_model", "TEXT");

  return db;
}

/** Add a column to an existing table if a prior schema version lacks it. */
function ensureColumn(d: Database, table: string, column: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// --- embedding BLOB <-> Float32Array -----------------------------------------

function embeddingToBlob(embedding: Float32Array | null): Buffer | null {
  if (!embedding) return null;
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function blobToEmbedding(blob: unknown): Float32Array | null {
  if (!blob) return null;
  const u8 = blob instanceof Uint8Array ? blob : null;
  if (!u8 || u8.byteLength < 4) return null;
  // Copy into an aligned buffer so Float32Array construction is safe.
  const copy = u8.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const category = String(row["category"] ?? "lesson");
  return {
    id: Number(row["id"]),
    content: String(row["content"] ?? ""),
    category: isMemoryCategory(category) ? category : "lesson",
    embedding: blobToEmbedding(row["embedding"]),
    embeddingModel: row["embedding_model"] == null ? null : String(row["embedding_model"]),
    hash: String(row["hash"] ?? ""),
    createdAt: String(row["created_at"] ?? ""),
    updatedAt: String(row["updated_at"] ?? ""),
    supersededBy: row["superseded_by"] == null ? null : Number(row["superseded_by"]),
    accessCount: Number(row["access_count"] ?? 0),
    lastAccess: row["last_access"] == null ? null : String(row["last_access"]),
  };
}

// --- FTS query sanitization --------------------------------------------------

/** Turn an arbitrary user query into a safe FTS5 MATCH expression (OR of quoted tokens). */
export function toFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

// --- writes ------------------------------------------------------------------

export function addEntry(
  content: string,
  category: MemoryCategory,
  embedding: Float32Array | null,
  hash: string,
  embeddingModel: string | null = null,
): number {
  const d = getDb();
  const row = d
    .prepare(
      `INSERT INTO entries (content, category, embedding, embedding_model, hash)
       VALUES ($content, $category, $embedding, $model, $hash)
       RETURNING id`,
    )
    .get({
      $content: content,
      $category: category,
      $embedding: embeddingToBlob(embedding),
      $model: embedding ? embeddingModel : null,
      $hash: hash,
    }) as { id: number };
  d.prepare("INSERT INTO entries_fts (rowid, content) VALUES (?, ?)").run(row.id, content);
  return row.id;
}

export function updateEntry(
  id: number,
  content: string,
  embedding: Float32Array | null,
  hash: string,
  embeddingModel: string | null = null,
): void {
  const d = getDb();
  d.prepare(
    `UPDATE entries
     SET content = $content, embedding = $embedding, embedding_model = $model, hash = $hash,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $id`,
  ).run({
    $id: id,
    $content: content,
    $embedding: embeddingToBlob(embedding),
    $model: embedding ? embeddingModel : null,
    $hash: hash,
  });
  d.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(id);
  d.prepare("INSERT INTO entries_fts (rowid, content) VALUES (?, ?)").run(id, content);
}

/** Sentinel for "superseded with no replacement" (forget). Keeps superseded_by non-null. */
export const SUPERSEDED_DELETED = 0;

/**
 * Soft-delete: mark `oldId` as superseded and drop it from FTS.
 * `newId` is the replacement entry, or null for a plain delete (stored as the
 * sentinel so active filters, which test `superseded_by IS NULL`, exclude it).
 */
export function supersedeEntry(oldId: number, newId: number | null): void {
  const d = getDb();
  d.prepare(
    `UPDATE entries
     SET superseded_by = $newId, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $oldId`,
  ).run({ $oldId: oldId, $newId: newId ?? SUPERSEDED_DELETED });
  d.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(oldId);
}

export function incrementAccess(id: number): void {
  const d = getDb();
  d.prepare(
    `UPDATE entries
     SET access_count = access_count + 1,
         last_access = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(id);
}

/** Hard-delete superseded entries older than `days`. Active entries are never touched. */
export function purgeSuperseded(days: number): number {
  const d = getDb();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const result = d
    .prepare("DELETE FROM entries WHERE superseded_by IS NOT NULL AND updated_at < ?")
    .run(cutoff);
  return Number(result.changes ?? 0);
}

// --- reads -------------------------------------------------------------------

export function getEntry(id: number): MemoryEntry | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToEntry(row) : null;
}

export function getByHash(hash: string): MemoryEntry | null {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM entries WHERE hash = ? AND superseded_by IS NULL LIMIT 1")
    .get(hash) as Record<string, unknown> | null;
  return row ? rowToEntry(row) : null;
}

export function getAllActive(): MemoryEntry[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM entries WHERE superseded_by IS NULL ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

/**
 * Active entries whose vector is missing or was produced by a different model.
 * Covers both "embeddings just enabled" and "model changed" in one query.
 */
export function getActiveNeedingEmbedding(currentModel: string): MemoryEntry[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT * FROM entries
       WHERE superseded_by IS NULL
         AND (embedding IS NULL OR embedding_model IS NOT $model)`,
    )
    .all({ $model: currentModel }) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

/** Set an entry's embedding (and its model identity) without touching content/FTS/timestamps. */
export function setEmbedding(id: number, embedding: Float32Array, embeddingModel: string): void {
  const d = getDb();
  d.prepare("UPDATE entries SET embedding = $embedding, embedding_model = $model WHERE id = $id").run({
    $id: id,
    $embedding: embeddingToBlob(embedding),
    $model: embeddingModel,
  });
}

export function getActiveByCategory(category: MemoryCategory): MemoryEntry[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT * FROM entries WHERE category = ? AND superseded_by IS NULL ORDER BY created_at DESC",
    )
    .all(category) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

export function countActive(): number {
  const d = getDb();
  const row = d.prepare("SELECT COUNT(*) AS n FROM entries WHERE superseded_by IS NULL").get() as {
    n: number;
  };
  return Number(row.n ?? 0);
}

export interface FtsHit {
  entry: MemoryEntry;
  /** Raw bm25 score (negative; lower is a better match). */
  bm25: number;
}

/** Keyword search over active entries. Returns up to `limit` rows ordered by relevance. */
export function searchFts(query: string, limit: number): FtsHit[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const d = getDb();
  try {
    const rows = d
      .prepare(
        `SELECT e.*, bm25(entries_fts) AS bm25
         FROM entries_fts
         JOIN entries e ON e.id = entries_fts.rowid
         WHERE entries_fts MATCH $match AND e.superseded_by IS NULL
         ORDER BY bm25 ASC
         LIMIT $limit`,
      )
      .all({ $match: match, $limit: limit }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ entry: rowToEntry(row), bm25: Number(row["bm25"] ?? 0) }));
  } catch (err) {
    void log("warn", "memory searchFts failed", { error: String(err) });
    return [];
  }
}

export function closeMemoryDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Test helper: wipe all rows. */
export function clearAllEntries(): void {
  const d = getDb();
  d.exec("DELETE FROM entries; DELETE FROM entries_fts;");
}
