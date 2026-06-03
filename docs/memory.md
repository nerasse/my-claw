# Active Memory

## Why

The agent wakes up fresh each session. Long-term memory gives it continuity: user preferences, environment facts, conventions, and lessons persist across sessions and are recalled automatically when relevant. The pre-V2 system appended freeform text to `MEMORY.md`, injected the whole file into every prompt, had a path bug (writes and reads used different directories), no search, no dedup, and grew unbounded. V2 replaces it with a SQLite store and on-demand hybrid retrieval.

## Decisions

### No size cap

Memory grows indefinitely; cleanliness comes from consolidation, not eviction. A 20KB consolidated store beats a 3KB truncated one. Follows the Hindsight principle: good consolidation makes deletion unnecessary. Hermes' 2200-char cap is too restrictive for a long-running assistant.

### SQLite, not a flat file

`~/.my-claw/memory.db` (WAL, same pattern as `analytics/usage-db.ts`). FTS5 gives keyword search for free; a BLOB column holds optional embeddings. Scales to millions of rows for one user with no external infrastructure.

### Hybrid retrieval (FTS5 + embeddings)

Pure vector search scores ~49% on long-memory benchmarks; hybrid keyword+vector ~92%. FTS5 pre-filters candidates by BM25, then cosine re-ranks in JS over that small set (<1ms). No `sqlite-vec` extension — no Bun precedent, and the JS path is fast enough.

### Embeddings are optional, three modes, one interface

`embed(text)` returns a vector or `null`; `null` degrades that call to FTS5-only.
- **FTS5-only (zero-config default):** no model, key, download, or network.
- **local:** `@huggingface/transformers` runs ONNX in-process — no server.
- **http:** any OpenAI-compatible `/embeddings` endpoint (Ollama, llama.cpp, Gemini, OpenAI). Serving the model is the provider's responsibility, not ours.

Recommended (the user mixes French and English): local `Xenova/multilingual-e5-large`, or hosted `gemini-embedding-001` (free tier).

### Boot warm-up, never blocking

The local backend loads in the background at startup (first run downloads ~1.3GB; later boots take seconds). The agent is usable immediately — early queries use FTS5 until embeddings are ready. http/none have nothing to warm.

### Per-vector model tag + unified backfill

Each vector is stored with the model that produced it (`embedding_model` = the model id, plus `@dims` when a dimension override is set). This is the community-standard guard: cosine across two different models is meaningless even at equal dimensions, so retrieval and dedup only compare vectors carrying the *current* model's tag; others fall back to FTS5.

At boot (after warm-up) a single backfill re-embeds every active entry whose vector is missing **or** was produced by a different model. One mechanism covers both cases:
- **Enabling embeddings** on a zero-config store → all null vectors get embedded.
- **Switching models** → all stale-model vectors get re-embedded.

No manual reindex, no silent corruption. The backfill is idempotent and resumable (re-running only touches entries still needing it). A schema column is added via lightweight `ALTER TABLE` migration for stores created before this change.

### Soft-delete with 1-year retention

Updates and consolidation supersede entries (`superseded_by`) instead of deleting them, preserving history for temporal queries. `forget` sets a non-null sentinel so the row leaves active recall. Superseded rows are hard-purged only after 365 days (on boot and daily). Mirrors Zep's temporal model without a graph DB.

### Recall injected in the user message, not the system prompt

Relevant memory is retrieved per turn and prepended to the current user message as a `<memory-context>` block. It is ephemeral (never stored in session history). Keeping it out of the system prompt leaves the prompt prefix stable — a prerequisite for prompt caching later.

### MEMORY.md is a generated view

The database is the source of truth. `MEMORY.md` is regenerated from it (grouped by category) for human readability. Hand-edited bullets are imported additively on boot (idempotent by content hash); deletions in the file are ignored — use `forget`.

### No sub-agent for recall

Deterministic FTS+cosine retrieval is enough at this scale. A recall sub-agent would add 2-5s latency for marginal precision. Consolidation (the one place quality compounds) does use an LLM.

### Consolidation model is configurable

A background pass every N writes asks an LLM to merge each category into the smallest set of dense declarative facts. Uses `memory.consolidation.model` or falls back to the main agent's LLM. Guards: an empty or non-compacting response never wipes a category.

## Categories

`user`, `environment`, `convention`, `project`, `lesson`. Consolidation runs per category so unrelated facts never merge.

## Config

```jsonc
"memory": {
  "enabled": true,
  "consolidation": { "enabled": true, "every": 20 },
  // Optional. Omit for FTS5-only (zero-config). http: also set baseUrl + apiKeyEnv.
  "embedding": { "backend": "local", "model": "Xenova/multilingual-e5-large" }
}
```

Defaults: `recallMaxEntries` 5, `recallMaxChars` 2000, `ftsCandidates` 20, `supersededRetentionDays` 365.

## Storage

- `~/.my-claw/memory.db` — SQLite, WAL. `entries` (+ `embedding` BLOB, `embedding_model` tag) and `entries_fts` (FTS5).
- `<workspace>/MEMORY.md` — generated human-readable view (atomic writes).

## Migration

On first V2 boot, freeform lines from the pre-V2 `~/.my-claw/prompt/USER.md` and `MEMORY.md` are imported as entries, then the files are renamed `.migrated` (runs once).
