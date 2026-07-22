import type { EmbeddingConfig, SkillSuggestConfig } from "../core/config.ts";
import type { SkillInfo } from "./types.ts";
import {
  cosineSimilarity,
  embed,
  embeddingSignature,
  isEmbeddingEnabled,
  isEmbeddingReady,
} from "../memory/embedding.ts";

const DEFAULT_MIN_SCORE = 0.35;

/**
 * Suggestion cap when the owner did not pin `topK`: scales with the registry so a small
 * catalog stays focused (never re-listing everything already shown in the full skill layer)
 * while a large one can surface more, bounded to avoid flooding the prompt.
 */
export function dynamicTopK(total: number): number {
  return Math.min(Math.max(Math.round(total * 0.5), 5), 15);
}

function resolveTopK(cfg: SkillSuggestConfig | undefined, total: number): number {
  if (cfg?.topK !== undefined && cfg.topK > 0) return cfg.topK;
  return dynamicTopK(total);
}

function skillText(s: SkillInfo): string {
  return `${s.name}: ${s.description}`;
}

// Skill vectors are stable across turns (only the query changes), and re-embedding every skill
// on every message would dominate latency. Cache keyed by model signature + skill text: a model
// swap or a description edit yields a new key, so stale vectors are never reused.
const skillVectorCache = new Map<string, Float32Array>();

function cacheKey(signature: string, text: string): string {
  return `${signature}\u0000${text}`;
}

/** Test seam: drop the cached skill vectors. */
export function resetSkillVectorCache(): void {
  skillVectorCache.clear();
}

/** Test seam: number of cached skill vectors (bounded to the current registry after a ranking). */
export function skillVectorCacheSize(): number {
  return skillVectorCache.size;
}

function tokenize(text: string): string[] {
  const matched = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matched ? matched.filter((t) => t.length >= 3) : [];
}

function rankByKeyword(skills: SkillInfo[], query: string): SkillInfo[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];
  const scored: { skill: SkillInfo; score: number }[] = [];
  for (const skill of skills) {
    const skillTokens = new Set(tokenize(skillText(skill)));
    let score = 0;
    for (const token of queryTokens) {
      if (skillTokens.has(token)) score++;
    }
    if (score > 0) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.skill);
}

/**
 * Rank skills by cosine similarity to the query. Returns null (not []) when embeddings are
 * unavailable at runtime so the caller can fall back to keyword matching rather than treating
 * "no vector" as "nothing relevant".
 */
async function rankByEmbedding(
  skills: SkillInfo[],
  query: string,
  cfg: EmbeddingConfig,
  minScore: number,
): Promise<SkillInfo[] | null> {
  const signature = embeddingSignature(cfg) ?? "";
  // Invalidate first: keep only vectors whose key still maps to a current skill under the current
  // model. This evicts edited/renamed/removed skills (and a whole model swap) so a changed skill is
  // re-embedded on demand, while unchanged skills keep their cached vector (no needless re-embed).
  const validKeys = new Set(skills.map((s) => cacheKey(signature, skillText(s))));
  for (const key of [...skillVectorCache.keys()]) {
    if (!validKeys.has(key)) skillVectorCache.delete(key);
  }

  const queryVec = await embed(query, cfg);
  if (!queryVec) return null;
  const scored: { skill: SkillInfo; score: number }[] = [];
  for (const skill of skills) {
    const text = skillText(skill);
    const key = cacheKey(signature, text);
    let vec = skillVectorCache.get(key);
    if (!vec) {
      const embedded = await embed(text, cfg);
      if (!embedded) return null;
      vec = embedded;
      skillVectorCache.set(key, vec);
    }
    const score = cosineSimilarity(queryVec, vec);
    if (score >= minScore) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.skill);
}

/**
 * Pick the skills most relevant to the incoming message for a soft "possibly relevant" reminder.
 * Semantic ranking when an embedding model is configured and warm, keyword matching otherwise
 * (and as a runtime fallback if embedding fails). Degrades to [] so a failure never injects noise.
 */
export async function selectRelevantSkills(
  skills: SkillInfo[],
  queryText: string,
  embeddingCfg: EmbeddingConfig | undefined,
  suggestCfg: SkillSuggestConfig | undefined,
): Promise<SkillInfo[]> {
  if (suggestCfg?.enabled === false) return [];
  const query = queryText.trim();
  if (!query || skills.length === 0) return [];

  const topK = resolveTopK(suggestCfg, skills.length);
  const minScore = suggestCfg?.minScore ?? DEFAULT_MIN_SCORE;

  if (isEmbeddingEnabled(embeddingCfg) && isEmbeddingReady()) {
    const ranked = await rankByEmbedding(skills, query, embeddingCfg as EmbeddingConfig, minScore);
    if (ranked) return ranked.slice(0, topK);
  }
  return rankByKeyword(skills, query).slice(0, topK);
}
