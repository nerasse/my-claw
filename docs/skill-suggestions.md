# Skill Suggestions (soft relevance reminder)

A mini-RAG over the skill registry. On top of the always-present skill catalog (Layer 5 of the
system prompt, which lists every skill and instructs the model to call `skills` when one fits), a
short **soft reminder** is prepended to the inbound user turn, highlighting the skills that best
match that message.

Goal: cut the skill discovery latency by pointing at the likely-relevant skill(s), without
removing the model's freedom to ignore them. It is a hint, never an order.

## What gets injected

Rendered as a `<context>` block at the top of the inbound user message (the system prompt carries
no per-turn byte, or every turn would be a new cache prefix):

```
<context>
Current time: 2026-10-19T20:18:36.172Z

Skills possibly relevant to this request:
- video: convert and edit video files
- media: process media assets

Treat this as a hint, not an order.
</context>

<the owner's message>
```

Layer 5 (the full catalog + the `MUST call skills` instruction) is unchanged; this only adds a
focused reminder.

## Ranking

`selectRelevantSkills()` (`src/skills/retrieval.ts`) ranks the registry against the message text:

- **Semantic** when a memory embedding model is configured (`memory.embedding`) and warm: embeds
  the query, cosine-compares it against each skill's `name: description`, keeps matches at or above
  `minScore`. Skill vectors are cached (keyed by model signature + skill text) so only the query is
  embedded per turn. On every ranking the cache is pruned to the current registry: an edited or
  renamed description yields a new key (re-embedded on demand), a removed skill or a model swap is
  evicted. Unchanged skills keep their vector, so only the delta is ever re-embedded, and the cache
  never grows past the number of live skills. Embedding is lazy (a skill is embedded the first time
  it is ranked, not at load), and `name: description` only — editing a skill's body never triggers
  a re-embed.
- **Keyword fallback** otherwise (no model, not warmed yet, or an embedding call fails at runtime):
  token overlap between the query and each skill's text. Works with zero setup.
- Degrades to no reminder (empty result) on any failure, empty query, or empty registry — a failure
  never injects noise.

## Dynamic `topK`

When `topK` is not pinned, the cap scales with the registry size so a small catalog stays focused
(never re-listing what Layer 5 already shows) while a large one can surface more, bounded:

```
topK = clamp(round(N * 0.5), 5, 15)   // N = number of skills
```

| N skills | topK |
|----------|------|
| <= 10    | 5    |
| 16       | 8    |
| 20       | 10   |
| 30       | 15   |
| >= 30    | 15   |

`minScore` (semantic mode) still filters on top, so the cap is a ceiling, not a target.

## Config

Hot-reloadable (read live per run; toggle takes effect on the next message, no restart):

```json
"skills": {
  "suggest": {
    "enabled": true,
    "minScore": 0.35,
    "topK": 5
  }
}
```

- `enabled` — default `true`. The keyword fallback needs no embedding setup.
- `minScore` — default `0.35`. Minimum cosine similarity in semantic mode; ignored by the keyword
  fallback.
- `topK` — omit for the dynamic curve above, or pin an explicit ceiling.

## Prompt caching

The reminder sits at the very end of the system prompt, after the runtime timestamp line (which is
already per-run dynamic). It is therefore cache-neutral for the prompt-caching feature: the
byte-stable prefix that gets cached within a run is unaffected, and cross-run reuse was already
precluded by the timestamp. See `docs/prompt-caching.md`.
