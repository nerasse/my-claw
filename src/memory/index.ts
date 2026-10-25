import { EMBEDDING_CONSUMERS, embeddingActive, embeddingFor, type EmbeddingConfig, type MemoryConfig } from "../core/config.ts";
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
import { embed, embedMany, embeddingSignature } from "./embedding.ts";
import { classify, hashContent, type DedupDecision } from "./dedup.ts";
import { recall as recallEngine } from "./recall.ts";
import { clearRecallCache } from "./cache.ts";
import { exportToMarkdown } from "./export.ts";
import { consolidate as consolidateEngine, type LlmCaller } from "./consolidate.ts";
import type { MemoryCategory, MemoryEntry, RecallResult } from "./types.ts";

export type { MemoryCategory, MemoryEntry, RecallResult } from "./types.ts";
export { MEMORY_CATEGORIES, isMemoryCategory } from "./types.ts";
export { warmupEmbedding, isEmbeddingReady, setEmbeddingProviders } from "./embedding.ts";
export { importHandEdits, exportToMarkdown, memoryFilePath, migrateLegacyFiles } from "./export.ts";
export { closeMemoryDb } from "./db.ts";
export { clearRecallCache } from "./cache.ts";
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

  // Written as the dedup consumer computes it: the vector a new fact is stored under is the one
  // the duplicate check needs, and a store written by another model is still added without one
  // (recall's own space gets filled by its backfill).
  const dedupCfg = embeddingFor(cfg, "dedup");
  const embedding = await embed(trimmed, dedupCfg);
  const sig = embeddingSignature(dedupCfg);
  const verdict = classify(trimmed, embedding, sig);

  if (verdict.decision === "skip") {
    return { decision: "skip", message: `Already known (${verdict.reason}).` };
  }

  const id = addEntry(trimmed, category, sig && embedding ? { [sig]: embedding } : {}, verdict.hash);
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

  const dedupCfg = embeddingFor(cfg, "dedup");
  const embedding = await embed(trimmed, dedupCfg);
  const sig = embeddingSignature(dedupCfg);
  const id = addEntry(trimmed, target?.category ?? "lesson", sig && embedding ? { [sig]: embedding } : {}, hashContent(trimmed));
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
 * Fill every vector space the configured consumers need, once.
 *
 * One pass per distinct model: two consumers pointed at the same model share a space, and asking
 * for the same text twice to store it once is the one waste worth avoiding here. "Missing" is
 * per space, so enabling a consumer, switching one model, or turning embeddings on for the first
 * time all land in the same query (docs/memory.md).
 *
 * The stored spaces are returned, so a caller can say how many consumers went live.
 */
export async function backfillEmbeddings(cfg?: MemoryConfig): Promise<number> {
  const spaces = new Map<string, EmbeddingConfig>();
  for (const consumer of EMBEDDING_CONSUMERS) {
    if (!embeddingActive(cfg, consumer)) continue;
    const embedCfg = embeddingFor(cfg, consumer)!;
    const sig = embeddingSignature(embedCfg);
    if (sig) spaces.set(sig, embedCfg);
  }
  let done = 0;
  for (const [sig, embedCfg] of spaces) {
    const pending = getActiveNeedingEmbedding(sig);
    if (pending.length === 0) continue;
    // Batched: a switch of model re-embeds the whole active store, and one request per entry turned
    // that into hundreds of round trips (docs/memory.md).
    const vectors = await embedMany(pending.map((entry) => entry.content), embedCfg);
    for (const [index, entry] of pending.entries()) {
      const vec = vectors[index];
      if (!vec) continue;
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
