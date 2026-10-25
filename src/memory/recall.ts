import { embeddingFor, type MemoryConfig } from "../core/config.ts";
import { searchFts, incrementAccess, type FtsHit } from "./db.ts";
import { embed, cosineSimilarity, isEmbeddingEnabled, embeddingSignature } from "./embedding.ts";
import { getCachedRecall, setCachedRecall } from "./cache.ts";
import type { RecallHit, RecallResult } from "./types.ts";

export const DEFAULT_RECALL_MAX_ENTRIES = 5;
export const DEFAULT_RECALL_MAX_CHARS = 2000;
export const DEFAULT_FTS_CANDIDATES = 20;

const W_FTS = 0.4;
const W_COSINE = 0.6;
const W_ACCESS = 0.05;
const FTS_ONLY_W_ACCESS = 0.1;

const EMPTY: RecallResult = { hits: [], text: "", semantic: false };

/** Skip recall for queries too short or command-like to carry intent. */
function isTrivial(query: string): boolean {
  const q = query.trim();
  if (q.length < 3) return true;
  if (q.startsWith("/")) return true;
  return false;
}

/** Map bm25 (negative, lower=better) onto [0,1] within the candidate set. */
function normalizeFts(candidates: FtsHit[]): number[] {
  if (candidates.length === 0) return [];
  const scores = candidates.map((c) => c.bm25);
  const best = Math.min(...scores);
  const worst = Math.max(...scores);
  if (best === worst) return scores.map(() => 1);
  return scores.map((s) => (worst - s) / (worst - best));
}

function buildText(hits: RecallHit[], maxChars: number): string {
  if (hits.length === 0) return "";
  const lines: string[] = [];
  let total = 0;
  for (const { entry } of hits) {
    const line = `- (${entry.category}) ${entry.content}`;
    if (total + line.length + 1 > maxChars && lines.length > 0) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Retrieve the most relevant memories for a query.
 * Hybrid (FTS5 + cosine) when embeddings are available; FTS5-only otherwise.
 * Always degrades gracefully and never throws on the hot path.
 */
export async function recall(query: string, cfg?: MemoryConfig): Promise<RecallResult> {
  if (isTrivial(query)) return EMPTY;

  const cached = getCachedRecall(query);
  if (cached) return cached;

  const ftsCandidates = cfg?.ftsCandidates ?? DEFAULT_FTS_CANDIDATES;
  const maxEntries = cfg?.recallMaxEntries ?? DEFAULT_RECALL_MAX_ENTRIES;
  const maxChars = cfg?.recallMaxChars ?? DEFAULT_RECALL_MAX_CHARS;

  const candidates = searchFts(query, ftsCandidates);
  if (candidates.length === 0) {
    setCachedRecall(query, EMPTY);
    return EMPTY;
  }

  const ftsNorm = normalizeFts(candidates);

  const embedCfg = embeddingFor(cfg, "recall");
  let queryVec: Float32Array | null = null;
  if (embedCfg?.enabled !== false && isEmbeddingEnabled(embedCfg)) {
    queryVec = await embed(query, embedCfg);
  }
  const sig = embeddingSignature(embedCfg);
  const semantic = queryVec !== null;

  const hits: RecallHit[] = candidates.map((c, i) => {
    const fts = ftsNorm[i] ?? 0;
    // Only compare vectors from the same model: cosine across models is meaningless.
    const stored = sig ? c.entry.embeddings[sig] : undefined;
    const cosine = queryVec && stored ? cosineSimilarity(queryVec, stored) : null;
    const accessBoost = Math.log(1 + c.entry.accessCount);
    const score = semantic
      ? W_FTS * fts + W_COSINE * Math.max(0, cosine ?? 0) + W_ACCESS * accessBoost
      : fts + FTS_ONLY_W_ACCESS * accessBoost;
    return { entry: c.entry, score, ftsScore: fts, cosine };
  });

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, maxEntries);

  for (const hit of top) incrementAccess(hit.entry.id);

  const result: RecallResult = { hits: top, text: buildText(top, maxChars), semantic };
  setCachedRecall(query, result);
  return result;
}
