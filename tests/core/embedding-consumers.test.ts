/**
 * One embedding model per consumer: the default every consumer inherits, the consumer that names
 * its own, and the one switched off while keeping its model -- docs/memory.md.
 *
 * The two predicates under test are the only readers of that shape, so this is where "configured"
 * and "switched on" are pinned: a caller and the settings page disagreeing about that is a page
 * that says a row is on while recall runs on keywords.
 */

import { describe, expect, test } from "bun:test";
import { EMBEDDING_CONSUMERS, embeddingActive, embeddingFor, type MemoryConfig } from "../../src/core/config.ts";

const GEMINI = { from: "gemini", model: "gemini-embedding-001", backend: "http" as const };
const NOMIC = { from: "synthetic", model: "hf:nomic-ai/nomic-embed-text-v1.5", backend: "http" as const };

describe("embeddingFor", () => {
  test("no default, no override: nothing embeds", () => {
    expect(embeddingFor({}, "recall")).toBeUndefined();
    expect(embeddingFor(undefined, "recall")).toBeUndefined();
  });

  test("every consumer inherits the default when it names nothing", () => {
    const memory: MemoryConfig = { embedding: GEMINI };
    for (const consumer of EMBEDDING_CONSUMERS) {
      expect(embeddingFor(memory, consumer)).toEqual(GEMINI);
    }
  });

  test("one consumer on its own model, the rest on the default", () => {
    const memory: MemoryConfig = { embedding: GEMINI, embeddings: { recall: NOMIC } };
    expect(embeddingFor(memory, "recall")).toEqual(NOMIC);
    expect(embeddingFor(memory, "dedup")).toEqual(GEMINI);
  });

  test("an override replaces the default, it does not merge field by field", () => {
    // Half a destination (a provider without a model) falling back field by field would silently
    // pair Gemini's model with Synthetic's key.
    const memory: MemoryConfig = { embedding: GEMINI, embeddings: { recall: NOMIC } };
    expect(embeddingFor(memory, "recall")).not.toMatchObject({ model: GEMINI.model });
  });

  test("an override that names no model falls back to the default, rather than silencing it", () => {
    const memory: MemoryConfig = { embedding: GEMINI, embeddings: { recall: { dimensions: 768 } } };
    expect(embeddingFor(memory, "recall")).toEqual(GEMINI);
  });

  test("a consumer switched off keeps its own entry, which is what makes the switch reversible", () => {
    const memory: MemoryConfig = { embedding: GEMINI, embeddings: { skills: { ...NOMIC, enabled: false } } };
    expect(embeddingFor(memory, "skills")).toEqual({ ...NOMIC, enabled: false });
  });
});

describe("embeddingActive", () => {
  test("on when a model is configured and nothing switches it off", () => {
    expect(embeddingActive({ embedding: GEMINI }, "recall")).toBe(true);
  });

  test("off with no model, and off when the consumer says so", () => {
    expect(embeddingActive({}, "recall")).toBe(false);
    expect(embeddingActive({ embedding: { ...GEMINI, enabled: false } }, "recall")).toBe(false);
    expect(embeddingActive({ embedding: GEMINI, embeddings: { dedup: { enabled: false } } }, "dedup")).toBe(false);
  });

  test("switching one consumer off leaves its neighbours on", () => {
    const memory: MemoryConfig = { embedding: GEMINI, embeddings: { import: { enabled: false } } };
    expect(embeddingActive(memory, "import")).toBe(false);
    expect(embeddingActive(memory, "recall")).toBe(true);
  });

  test("a stale entry with no model and no off switch is not active, even though a default exists", () => {
    // `{ dimensions: 768 }` alone falls back to the default, so this one *is* active -- the guard
    // is against reading a half-written entry as a choice of its own.
    const memory: MemoryConfig = { embedding: GEMINI, embeddings: { recall: { dimensions: 768 } } };
    expect(embeddingActive(memory, "recall")).toBe(true);
    expect(embeddingActive({ embeddings: { recall: { dimensions: 768 } } }, "recall")).toBe(false);
  });
});
