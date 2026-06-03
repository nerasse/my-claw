import type { MemoryConfig } from "../core/config.ts";
import { hooks } from "../hooks/index.ts";
import {
  addEntry,
  supersedeEntry,
  getAllActive,
  getActiveByCategory,
  getActiveNeedingEmbedding,
  setEmbedding,
  searchFts,
  countActive,
  purgeSuperseded,
} from "./db.ts";
import { embed, isEmbeddingEnabled, embeddingSignature } from "./embedding.ts";
import { classify, hashContent, type DedupDecision } from "./dedup.ts";
import { recall as recallEngine } from "./recall.ts";
import { clearRecallCache } from "./cache.ts";
import { exportToMarkdown } from "./export.ts";
import { consolidate as consolidateEngine, type LlmCaller } from "./consolidate.ts";
import type { MemoryCategory, MemoryEntry, RecallResult } from "./types.ts";

export type { MemoryCategory, MemoryEntry, RecallResult } from "./types.ts";
export { MEMORY_CATEGORIES, isMemoryCategory } from "./types.ts";
export { warmupEmbedding, isEmbeddingReady } from "./embedding.ts";
export { importHandEdits, exportToMarkdown, memoryFilePath, migrateLegacyFiles } from "./export.ts";
export { closeMemoryDb } from "./db.ts";
export type { LlmCaller } from "./consolidate.ts";

export interface RememberResult {
  decision: DedupDecision;
  id?: number;
  message: string;
}

/** After any mutation: refresh the human-readable view and drop stale recalls. */
function afterWrite(): void {
  clearRecallCache();
  void exportToMarkdown();
}

export async function remember(
  content: string,
  category: MemoryCategory,
  cfg?: MemoryConfig,
): Promise<RememberResult> {
  const trimmed = content.trim();
  if (!trimmed) return { decision: "skip", message: "Empty content, nothing stored." };

  const embedding = await embed(trimmed, cfg?.embedding);
  const sig = embeddingSignature(cfg?.embedding);
  const verdict = classify(trimmed, embedding, sig);

  if (verdict.decision === "skip") {
    return { decision: "skip", message: `Already known (${verdict.reason}).` };
  }

  const id = addEntry(trimmed, category, embedding, verdict.hash, sig);
  hooks.emit("memory:store", { id, category, decision: verdict.decision });
  afterWrite();
  const note = verdict.decision === "review" ? " (related entry exists; will merge on consolidation)" : "";
  return { decision: verdict.decision, id, message: `Remembered [${category}]${note}.` };
}

export async function recall(query: string, cfg?: MemoryConfig): Promise<RecallResult> {
  const result = await recallEngine(query, cfg);
  hooks.emit("memory:recall", {
    query,
    hitCount: result.hits.length,
    semantic: result.semantic,
  });
  return result;
}

function findEntry(text: string): MemoryEntry | null {
  const byHash = searchFts(text, 1);
  const hash = hashContent(text);
  const exact = getAllActive().find((e) => e.hash === hash);
  if (exact) return exact;
  return byHash[0]?.entry ?? null;
}

export async function update(
  oldText: string,
  newContent: string,
  cfg?: MemoryConfig,
): Promise<RememberResult> {
  const target = findEntry(oldText);
  const trimmed = newContent.trim();
  if (!trimmed) return { decision: "skip", message: "Empty content, nothing updated." };

  const embedding = await embed(trimmed, cfg?.embedding);
  const sig = embeddingSignature(cfg?.embedding);
  const id = addEntry(trimmed, target?.category ?? "lesson", embedding, hashContent(trimmed), sig);
  if (target) supersedeEntry(target.id, id);
  hooks.emit("memory:store", { id, category: target?.category ?? "lesson", decision: "add" });
  afterWrite();
  return { decision: "add", id, message: target ? "Updated memory." : "Stored as new memory (no match to update)." };
}

export function forget(oldText: string): { forgotten: boolean; message: string } {
  const target = findEntry(oldText);
  if (!target) return { forgotten: false, message: "No matching memory found." };
  supersedeEntry(target.id, null);
  afterWrite();
  return { forgotten: true, message: "Forgotten." };
}

export async function search(query: string, cfg?: MemoryConfig): Promise<RecallResult> {
  return recallEngine(query, { ...cfg, recallMaxEntries: 20, recallMaxChars: 8000 });
}

export function list(category?: MemoryCategory): MemoryEntry[] {
  return category ? getActiveByCategory(category) : getAllActive();
}

export function count(): number {
  return countActive();
}

export async function consolidateMemory(
  caller: LlmCaller,
  cfg?: MemoryConfig,
): Promise<void> {
  const result = await consolidateEngine(caller, cfg);
  if (result.categoriesProcessed > 0) {
    hooks.emit("memory:consolidate", result);
    void exportToMarkdown();
  }
}

/** Hard-purge superseded entries older than the retention window. */
export function purgeOldMemory(cfg?: MemoryConfig): number {
  const days = cfg?.supersededRetentionDays ?? 365;
  return purgeSuperseded(days);
}

/**
 * Embed active entries that have no vector yet (stored while FTS5-only).
 * Run once after the embedding model is ready so enabling embeddings later
 * retroactively indexes the whole store. No-op when embeddings are disabled.
 */
export async function backfillEmbeddings(cfg?: MemoryConfig): Promise<number> {
  if (!isEmbeddingEnabled(cfg?.embedding)) return 0;
  const sig = embeddingSignature(cfg?.embedding)!;
  const pending = getActiveNeedingEmbedding(sig);
  let done = 0;
  for (const entry of pending) {
    const vec = await embed(entry.content, cfg?.embedding);
    if (vec) {
      setEmbedding(entry.id, vec, sig);
      done += 1;
    }
  }
  if (done > 0) {
    clearRecallCache();
    hooks.emit("memory:backfill", { embedded: done });
  }
  return done;
}
