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

### Five consumers, one model each (or one shared)

Embeddings are not one feature with one model. Five places in the engine ask "is this the same
meaning?", and they do not have the same needs: recall runs on every message, the duplicate check
runs on every write, consolidation re-embeds what it merges, the Markdown import runs once at boot,
and skill suggestion ranks the skills a message is about.

`memory.embedding` is the **default**; `memory.embeddings.<consumer>` overrides it for one of them:

| consumer | what it embeds | when |
|---|---|---|
| `recall` | the incoming message, against stored facts | every message |
| `dedup` | a candidate fact, against its category | every write |
| `consolidate` | the facts a merge produces | every consolidation pass |
| `import` | hand-written bullets from `MEMORY.md` | boot, once |
| `skills` | the message, against skill descriptions | when a skill may apply |

An entry under `embeddings.<consumer>` **replaces** the default for that consumer, it does not merge
field by field: half a destination (a model without its provider) is not a smaller choice, it is a
different one. An entry that names no model falls back to the default rather than silencing the
consumer, because embedding nothing is not what "I only set the dimensions" means.

`enabled: false` is the off switch, and it is a state of its own rather than a destination: it pins
nothing, so a consumer can be switched off while following the default and be switched back on
without choosing anything. On a consumer that does name a model, the switch keeps the model, so
coming back needs no reconfiguration either. `own` in the Services frame means "names its own
model", not "has an entry", so the page never offers "follow the default" to a row that already
does. `embeddingFor()` and `embeddingActive()` in `src/core/config.ts` are the only readers, so the
settings page and the callers cannot disagree about what "configured" means.

### A model is a vector space, so a vector names its model

Two models never produce comparable vectors, even at equal dimensions. The store therefore keeps
one vector **per model** rather than one vector per entry: `entry_vectors(entry_id, model, vector)`.
Two consumers on the same model share the row; two consumers on different models each have their
own, and cosine is only ever computed inside one model's space. Switching a consumer's model does
not invalidate the other consumers' vectors, and the backfill only re-embeds the space that changed.

The `skills` consumer is the exception: its vectors live in a process cache and never reach the
database, so changing its model re-embeds nothing.

### Embeddings are optional, four modes, one interface

`embed(text)` returns a vector or `null`; `null` degrades that call to FTS5-only.
- **FTS5-only (zero-config default):** no model, key, download, or network.
- **local:** `@huggingface/transformers` runs ONNX in-process — no server.
- **http, on a provider already configured:** `from: "gemini"` names a key of `llm.providers`, and
  the call uses that provider's `baseUrl` and `apiKeyEnv`. No URL to copy, no second key to paste,
  and renaming or re-keying the provider moves the embedding with it. This is what the Services
  page offers first, because it is the one setup a real install already has. Which models it can
  offer comes from the catalogue's non-chat half (`kind: "embedding"`), never from a hardcoded
  list: Gemini's and OpenRouter's are discovered, Synthetic's single one is declared because its
  `/models` never lists it.
- **http, at the owner's URL:** `baseUrl` (+ optional `apiKeyEnv`) for a server that is not one of
  this install's chat providers — a bare llama.cpp, an Ollama box, a proxy.

`from` and `baseUrl` are alternatives, not a cascade: naming both is a config error, since the two
say different things about where the key lives and a silent winner would be a surprise.

Measured on the live providers (2026-10-25): Gemini serves `gemini-embedding-001` and
`gemini-embedding-2` on its OpenAI-compatible `/embeddings`; OpenRouter serves 35 embedding models
on its own `/embeddings` and lists them apart on `/embeddings/models` (its `/models` carries none);
Synthetic serves `hf:nomic-ai/nomic-embed-text-v1.5` (768 dimensions, free, and explicitly outside
its rate limit) but **lists no embedding at all** in `/models`, so `UNLISTED_EMBEDDINGS` in
`src/llm/catalog.ts` states it; LiteLLM answers 400 on that route, OpenCode Go 404, Groq 404. A
provider with no embeddings therefore simply does not appear in the model list.

Recommended (the user mixes French and English): local `Xenova/multilingual-e5-large`, or hosted
`gemini-embedding-001` (768 dimensions is ample for a store of a few thousand facts).

### One call per batch, not per entry

The backfill is the caller that made this matter: switching model re-embeds the whole active store,
and one request per entry turned that into hundreds of round trips. `embedMany` sends 40 texts per
call and reads each row's own `index` rather than assuming the response is sorted — a misplaced
vector indexes the wrong text for good, and nothing downstream could notice. A batch the endpoint
refuses falls back to one text at a time, so a provider that only accepts a single input still
works, just as slowly as before. Local embeddings stay per-text: no round trip to save.

### Boot warm-up, never blocking

The local backend loads in the background at startup (first run downloads ~1.3GB; later boots take seconds). The agent is usable immediately — early queries use FTS5 until embeddings are ready. http/none have nothing to warm.

### Per-vector model tag + unified backfill

Each vector is stored with the model that produced it (`entry_vectors.model` = the model id, plus
`@dims` when a dimension override is set). This is the community-standard guard: cosine across two
different models is meaningless even at equal dimensions, so retrieval and dedup only compare
vectors in the space they asked for; entries with no vector in that space fall back to FTS5.

At boot (after warm-up) a single backfill re-embeds every active entry whose vector is missing in a
space that is in use **or** was produced by a model no longer used there. One mechanism covers both
cases:
- **Enabling embeddings** on a zero-config store → all null vectors get embedded.
- **Switching models** → the vectors of that space get re-embedded, and only those.

Rows written before the per-model table existed are migrated once (`migrateLegacyVectors()`): the
old `entries.embedding` + `embedding_model` pair becomes one row in `entry_vectors`.

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
  "embedding": { "from": "gemini", "model": "gemini-embedding-001", "dimensions": 768 },
  // Optional. One consumer elsewhere, or one switched off.
  "embeddings": {
    "recall": { "from": "synthetic", "model": "hf:nomic-ai/nomic-embed-text-v1.5" },
    "skills": { "enabled": false }
  }
}
```

Defaults: `recallMaxEntries` 5, `recallMaxChars` 2000, `ftsCandidates` 20, `supersededRetentionDays` 365.

## Storage

- `~/.my-claw/memory.db` — SQLite, WAL. `entries` and `entries_fts` (FTS5), plus
  `entry_vectors(entry_id, model, vector)` — one row per entry per embedding model in use.
- `<workspace>/MEMORY.md` — generated human-readable view (atomic writes).

## Migration

On first V2 boot, freeform lines from the pre-V2 `~/.my-claw/prompt/USER.md` and `MEMORY.md` are imported as entries, then the files are renamed `.migrated` (runs once).
