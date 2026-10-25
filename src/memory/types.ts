/** @file Memory domain types. Config types live in core/config.ts. */

export type MemoryCategory = "user" | "environment" | "convention" | "project" | "lesson";

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "user",
  "environment",
  "convention",
  "project",
  "lesson",
] as const;

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export interface MemoryEntry {
  id: number;
  content: string;
  category: MemoryCategory;
  /**
   * One vector per vector space, keyed by the model signature that produced it (`id@dims`). A
   * model is a space: cosine across two of them is meaningless even at equal dimensions, so every
   * consumer compares against its own key and nothing else. Empty when embeddings are off or when
   * this entry was written before they were on.
   */
  embeddings: Record<string, Float32Array>;
  hash: string;
  createdAt: string;
  updatedAt: string;
  supersededBy: number | null;
  accessCount: number;
  lastAccess: string | null;
}

/** A single entry returned from recall, with its blended relevance score. */
export interface RecallHit {
  entry: MemoryEntry;
  score: number;
  ftsScore: number;
  cosine: number | null;
}

export interface RecallResult {
  hits: RecallHit[];
  /** Formatted block ready to inject into a prompt, capped to recallMaxChars. */
  text: string;
  /** True when embeddings contributed to scoring. */
  semantic: boolean;
}
