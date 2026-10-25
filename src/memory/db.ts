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

    -- One row per (entry, model). A model is a vector space: two models never compare, even at
    -- equal dimensions, so consumers pointed at different models each keep their own vector here
    -- instead of overwriting a single column. Keyed by the model signature (id plus its dims),
    -- which is what every caller already knows (docs/memory.md).
    CREATE TABLE IF NOT EXISTS entry_vectors (
      entry_id INTEGER NOT NULL,
      model    TEXT    NOT NULL,
      vector   BLOB    NOT NULL,
      PRIMARY KEY (entry_id, model)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_entry_vectors_model ON entry_vectors (model);
  `);

  ensureColumn(db, "entries", "embedding_model", "TEXT");
  migrateLegacyVectors(db);

  return db;
}

/**
 * The single-vector column becomes rows in `entry_vectors`, once. A store written before this
 * table existed carries its vectors in `entries.embedding`; reading those as if they were the new
 * shape is how a recall silently compares against nothing. The old columns are left alone --
 * emptying them is a destructive step with no benefit, and a downgrade would want them.
 */
function migrateLegacyVectors(d: Database): void {
  const done = d.prepare("SELECT 1 FROM entry_vectors LIMIT 1").get();
  const pending = d
    .prepare("SELECT COUNT(*) AS n FROM entries WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL")
    .get() as { n: number };
  if (done || Number(pending.n) === 0) return;
  const rows = d
    .prepare("SELECT id, embedding, embedding_model FROM entries WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL")
    .all() as Array<{ id: number; embedding: Uint8Array; embedding_model: string }>;
  const insert = d.prepare("INSERT OR REPLACE INTO entry_vectors (entry_id, model, vector) VALUES (?, ?, ?)");
  const migrate = d.transaction((): void => {
    for (const row of rows) insert.run(row.id, row.embedding_model, row.embedding);
  });
  migrate();
  void log("info", "memory vectors migrated to per-model rows", { vectors: rows.length });
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
    embeddings: {},
    hash: String(row["hash"] ?? ""),
    createdAt: String(row["created_at"] ?? ""),
    updatedAt: String(row["updated_at"] ?? ""),
    supersededBy: row["superseded_by"] == null ? null : Number(row["superseded_by"]),
    accessCount: Number(row["access_count"] ?? 0),
    lastAccess: row["last_access"] == null ? null : String(row["last_access"]),
  };
}

/**
 * Attaches every vector of these entries, in one query. Per-row lookups would be one query per
 * memory on a store of thousands -- and `getAllActive` is called by the export and the recall path.
 */
function withVectors(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length === 0) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const ids = [...byId.keys()];
  const d = getDb();
  // Chunked so a huge store never builds an IN list beyond SQLite's bound-parameter ceiling.
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const marks = chunk.map(() => "?").join(", ");
    const rows = d
      .prepare(`SELECT entry_id, model, vector FROM entry_vectors WHERE entry_id IN (${marks})`)
      .all(...chunk) as Array<{ entry_id: number; model: string; vector: Uint8Array }>;
    for (const row of rows) {
      const vec = blobToEmbedding(row.vector);
      const entry = byId.get(Number(row.entry_id));
      if (vec && entry) entry.embeddings[row.model] = vec;
    }
  }
  return entries;
}

/** The vectors of one entry, by model signature. */
function vectorsOf(id: number): Record<string, Float32Array> {
  const rows = getDb().prepare("SELECT model, vector FROM entry_vectors WHERE entry_id = ?").all(id) as Array<{
    model: string;
    vector: Uint8Array;
  }>;
  const out: Record<string, Float32Array> = {};
  for (const row of rows) {
    const vec = blobToEmbedding(row.vector);
    if (vec) out[row.model] = vec;
  }
  return out;
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
  embeddings: Record<string, Float32Array>,
  hash: string,
): number {
  const d = getDb();
  // The row, its FTS shadow and its vectors are one write. Split, a failure between them leaves a
  // memory that counts in the exports and can never be recalled again.
  const insert = d.transaction((): number => {
    const row = d
      .prepare(
        `INSERT INTO entries (content, category, hash)
         VALUES ($content, $category, $hash)
         RETURNING id`,
      )
      .get({ $content: content, $category: category, $hash: hash }) as { id: number };
    d.prepare("INSERT INTO entries_fts (rowid, content) VALUES (?, ?)").run(row.id, content);
    writeVectors(row.id, embeddings);
    return row.id;
  });
  return insert();
}

function writeVectors(id: number, embeddings: Record<string, Float32Array>): void {
  const d = getDb();
  const insert = d.prepare("INSERT OR REPLACE INTO entry_vectors (entry_id, model, vector) VALUES (?, ?, ?)");
  for (const [model, vec] of Object.entries(embeddings)) insert.run(id, model, embeddingToBlob(vec));
}

export function updateEntry(
  id: number,
  content: string,
  embeddings: Record<string, Float32Array>,
  hash: string,
): void {
  const d = getDb();
  // Delete then insert: interrupted between the two, an existing memory becomes unrecallable.
  const update = d.transaction((): void => {
    d.prepare(
      `UPDATE entries
       SET content = $content, hash = $hash, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $id`,
    ).run({ $id: id, $content: content, $hash: hash });
    d.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(id);
    d.prepare("INSERT INTO entries_fts (rowid, content) VALUES (?, ?)").run(id, content);
    // A rewritten memory keeps no vector: it describes a text that no longer exists.
    d.prepare("DELETE FROM entry_vectors WHERE entry_id = ?").run(id);
    writeVectors(id, embeddings);
  });
  update();
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
  const supersede = d.transaction((): void => {
    d.prepare(
      `UPDATE entries
       SET superseded_by = $newId, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $oldId`,
    ).run({ $oldId: oldId, $newId: newId ?? SUPERSEDED_DELETED });
    d.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(oldId);
  });
  supersede();
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
  return row ? withVectors([rowToEntry(row)])[0]! : null;
}

export function getByHash(hash: string): MemoryEntry | null {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM entries WHERE hash = ? AND superseded_by IS NULL LIMIT 1")
    .get(hash) as Record<string, unknown> | null;
  return row ? withVectors([rowToEntry(row)])[0]! : null;
}

export function getAllActive(): MemoryEntry[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM entries WHERE superseded_by IS NULL ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;
  return withVectors(rows.map(rowToEntry));
}

/**
 * Active entries with no vector in this vector space. Covers "embeddings just enabled", "a new
 * consumer went live", and "that consumer changed model": all three need the same missing rows,
 * and the per-model table already answers it without a column to rewrite.
 */
export function getActiveNeedingEmbedding(currentModel: string): MemoryEntry[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT * FROM entries e
       WHERE e.superseded_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM entry_vectors v WHERE v.entry_id = e.id AND v.model = $model
         )`,
    )
    .all({ $model: currentModel }) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

/** Store one vector in one space, leaving the entry's other spaces untouched. */
export function setEmbedding(id: number, embedding: Float32Array, embeddingModel: string): void {
  writeVectors(id, { [embeddingModel]: embedding });
}

export function getActiveByCategory(category: MemoryCategory): MemoryEntry[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT * FROM entries WHERE category = ? AND superseded_by IS NULL ORDER BY created_at DESC",
    )
    .all(category) as Array<Record<string, unknown>>;
  return withVectors(rows.map(rowToEntry));
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
    return withVectors(rows.map(rowToEntry)).map((entry, i) => ({ entry, bm25: Number(rows[i]!["bm25"] ?? 0) }));
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
  d.exec("DELETE FROM entries; DELETE FROM entries_fts; DELETE FROM entry_vectors;");
}
