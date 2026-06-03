import { LruMap } from "../utils/lru-map.ts";
import type { RecallResult } from "./types.ts";

const CACHE_SIZE = 100;

const cache = new LruMap<string, RecallResult>(CACHE_SIZE);

function key(query: string): string {
  return query.trim().toLowerCase();
}

export function getCachedRecall(query: string): RecallResult | undefined {
  return cache.get(key(query));
}

export function setCachedRecall(query: string, result: RecallResult): void {
  cache.set(key(query), result);
}

/** Any write to memory must invalidate the cache so recalls stay fresh. */
export function clearRecallCache(): void {
  cache.clear();
}
