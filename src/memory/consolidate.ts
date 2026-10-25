import { embeddingFor, type MemoryConfig } from "../core/config.ts";
import {
  getActiveByCategory,
  addEntry,
  supersedeEntry,
} from "./db.ts";
import { embed, embeddingSignature } from "./embedding.ts";
import { hashContent } from "./dedup.ts";
import { clearRecallCache } from "./cache.ts";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./types.ts";
import { log } from "../utils/logger.ts";

/** Provided by the caller so this module stays decoupled from the LLM client. */
export type LlmCaller = (system: string, user: string) => Promise<string>;

/** Minimum active entries in a category before a merge pass is worthwhile. */
const MIN_ENTRIES_TO_MERGE = 4;

export interface ConsolidateResult {
  categoriesProcessed: number;
  before: number;
  after: number;
}

const SYSTEM_PROMPT = [
  "You consolidate an AI assistant's long-term memory.",
  "You receive a list of remembered facts in one category.",
  "Rewrite them into the smallest set of dense, declarative facts that preserves ALL information.",
  "Merge duplicates and near-duplicates. Drop nothing meaningful. Resolve contradictions in favor of the most recent.",
  "Write declarative statements (\"User prefers X\"), never instructions or commentary.",
  "Output ONLY the facts, one per line, no numbering, no bullets, no preamble.",
].join("\n");

function parseFacts(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0);
}

async function consolidateCategory(
  category: MemoryCategory,
  caller: LlmCaller,
  cfg?: MemoryConfig,
): Promise<{ before: number; after: number } | null> {
  const entries = getActiveByCategory(category);
  if (entries.length < MIN_ENTRIES_TO_MERGE) return null;

  const userPrompt = entries.map((e) => `- ${e.content}`).join("\n");

  let response: string;
  try {
    response = await caller(SYSTEM_PROMPT, `Category: ${category}\n\n${userPrompt}`);
  } catch (err) {
    void log("warn", "memory consolidation llm call failed", { category, error: String(err) });
    return null;
  }

  const facts = parseFacts(response);
  // Safety: never wipe a category on an empty or degenerate response.
  if (facts.length === 0) return null;
  if (facts.length >= entries.length) return null; // no compaction achieved

  const embedCfg = embeddingFor(cfg, "consolidate");
  const sig = embeddingSignature(embedCfg);
  const newIds: number[] = [];
  for (const fact of facts) {
    const embedding = await embed(fact, embedCfg);
    newIds.push(addEntry(fact, category, sig && embedding ? { [sig]: embedding } : {}, hashContent(fact)));
  }

  const supersededBy = newIds[0] ?? null;
  for (const old of entries) {
    supersedeEntry(old.id, supersededBy);
  }

  return { before: entries.length, after: facts.length };
}

/**
 * Merge redundant entries per category via the LLM. Old entries are soft-deleted
 * (superseded), never hard-removed here. Safe to run in the background.
 */
export async function consolidate(caller: LlmCaller, cfg?: MemoryConfig): Promise<ConsolidateResult> {
  let categoriesProcessed = 0;
  let before = 0;
  let after = 0;

  for (const category of MEMORY_CATEGORIES) {
    const res = await consolidateCategory(category, caller, cfg);
    if (res) {
      categoriesProcessed += 1;
      before += res.before;
      after += res.after;
    }
  }

  if (categoriesProcessed > 0) {
    clearRecallCache();
    void log("info", "memory consolidated", { categoriesProcessed, before, after });
  }

  return { categoriesProcessed, before, after };
}
