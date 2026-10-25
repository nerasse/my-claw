import { createHash } from "node:crypto";
import { getByHash, searchFts } from "./db.ts";
import { cosineSimilarity } from "./embedding.ts";
import type { MemoryEntry } from "./types.ts";

/** Above this cosine, two entries are considered the same fact. */
const DUPLICATE_THRESHOLD = 0.92;
/** Between REVIEW and DUPLICATE, entries are related enough to reconcile. */
const REVIEW_THRESHOLD = 0.8;
const DEDUP_CANDIDATES = 10;

/** Stable hash of normalized content for exact-duplicate detection. */
export function hashContent(content: string): string {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

export type DedupDecision = "add" | "skip" | "review";

export interface DedupResult {
  decision: DedupDecision;
  hash: string;
  similar?: MemoryEntry;
  similarity?: number;
  reason?: string;
}

/**
 * Decide what to do with a new piece of content:
 * - skip: exact or near-duplicate already stored
 * - review: a related entry exists; caller may merge/update instead of adding
 * - add: novel
 * Without an embedding, only exact-hash duplicates are caught.
 */
export function classify(
  content: string,
  embedding: Float32Array | null,
  signature?: string | null,
): DedupResult {
  const hash = hashContent(content);

  const exact = getByHash(hash);
  if (exact) {
    return { decision: "skip", hash, similar: exact, similarity: 1, reason: "exact duplicate" };
  }

  if (!embedding) {
    return { decision: "add", hash };
  }

  const candidates = searchFts(content, DEDUP_CANDIDATES);
  let best: MemoryEntry | null = null;
  let bestSim = 0;
  for (const { entry } of candidates) {
    // Only compare vectors from the same model: cosine across models is meaningless.
    if (!signature) continue;
    const stored = entry.embeddings[signature];
    if (!stored) continue;
    const sim = cosineSimilarity(embedding, stored);
    if (sim > bestSim) {
      bestSim = sim;
      best = entry;
    }
  }

  if (best && bestSim >= DUPLICATE_THRESHOLD) {
    return { decision: "skip", hash, similar: best, similarity: bestSim, reason: "near-duplicate" };
  }
  if (best && bestSim >= REVIEW_THRESHOLD) {
    return { decision: "review", hash, similar: best, similarity: bestSim, reason: "related entry exists" };
  }
  return { decision: "add", hash };
}
