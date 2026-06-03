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
  embedding: Float32Array | null;
  /** Identity of the model that produced `embedding` (e.g. "model@dims"). Null when no vector. */
  embeddingModel: string | null;
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
