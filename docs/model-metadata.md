# Model metadata: where a model's capabilities come from

A model has capabilities the model id does not carry: whether it reasons, at which levels, whether
it reads images, how big its window is. Three of our provider types answer that question
themselves. The fourth, the OpenAI-compatible one, cannot: `/v1/models` is a list of ids.

This document is about that fourth case, and about the vocabulary of reasoning levels it forces us
to widen. See `docs/model-resolution.md` for which model a run uses, and `docs/status-command.md`
for the price table this reuses.

## The measured problem

`GET https://opencode.ai/zen/go/v1/models` answers, per entry:

```json
{ "id": "deepseek-v4-flash", "object": "model", "created": 1786479408, "owned_by": "opencode" }
```

That is the whole OpenAI `/v1/models` contract, and it is what every OpenAI-compatible provider
sends. So discovery records what it was given (`catalog.ts`, the `else` branch): id, label = id,
provider, group. Nothing else exists to record.

Downstream, that emptiness reads as a refusal:

1. `resolver.ts` — `effortApplies()` refuses a model that opted into nothing. Only `claude-sdk` and
   `codex` are effort-native; everything else needs an explicit opt-in, and an explicit
   `supportsEffort: false` refuses even the native ones.
2. `model-picker.ts` — `effortApplies === false` makes `effortLevelsFor()` return `[]`.
3. `index.ts` omits `effortLevels` from the frame, and the app skips the effort step.

The result is correct and useless: 24 models with reasoning, none of it reachable.

## The source of truth we already download

`models.dev/api.json` is fetched every 24 h for prices and context windows (`llm/pricing.ts`). It
also publishes, per model, exactly what is missing. Measured on the live file: 6 279 models, 3 016
carrying `reasoning_options`, in three shapes.

```json
"reasoning": true,
"reasoning_options": [{ "type": "effort", "values": ["low", "high", "max"] }]
```

| shape | models | carries | our reading |
|---|---|---|---|
| `effort` | 2 106 | `values: [...]` | the ladder, verbatim |
| `toggle` | 1 037 | nothing | two rungs: `none` and `high` |
| `budget_tokens` | 527 | `min`, `max` | ignored: a token budget is not a rung |

Combinations are common (`effort+toggle`: 199, `budget_tokens+toggle`: 221). An `effort` entry
always wins: it is the more precise statement.

Effort values published across the file, by frequency: `high` 2 074, `low` 1 743, `medium` 1 703,
`none` 739, `xhigh` 670, `max` 636, `minimal` 305. Plus three junk entries — one `"default"` and
two `null` — which is why the value space is validated rather than trusted.

`ultra` appears **zero** times: it is ours, Codex-only, and stays ours.

## Rules

### R1 — Per-model ladders are read, never invented

A model's levels come from its `reasoning_options`, model by model. The global list
(`EFFORT_LEVELS`) stays what it is today: the fallback for a model nothing describes, and the
vocabulary of the global/tag/agent pin. It does **not** gain `none` or `minimal`, because it is
offered to every model with no metadata, and offering a level on no evidence is how a provider
returns 400.

So: `deepseek-v4-flash` offers `low, high, max` because that is what it publishes — not our six.

### R2 — The vocabulary is the union of what the source can publish

`EffortLevel` gains `none` and `minimal`. It is a validation vocabulary, not a menu: a level is
offered only where R1 puts it. Junk values (`default`, `null`, anything outside the vocabulary) are
dropped at the boundary, as the Codex path already does with `EFFORT_SET`.

The two new rungs go at the **bottom**: `none, minimal, low, medium, high, xhigh, max, ultra`.
Position is load-bearing — `anthropic-models.ts` filters `EFFORT_ORDER` to build a menu, so a level
appended after `ultra` would render after it.

### R3 — `none` is a level, not an absence

Measured, on `opencode-go`, one call each:

| model | `reasoning_effort: none` | `reasoning_effort: max`/`high` |
|---|---|---|
| `deepseek-v4-flash` (declares `effort`) | 0 reasoning tokens | 104 reasoning tokens |
| `qwen3.7-max` (declares `toggle` only) | 0 reasoning tokens | 89 reasoning tokens |

`none` demonstrably turns reasoning off, and `reasoning_effort` is honoured even by a model whose
metadata only declares a toggle. That is what makes R1's toggle rule (`none` + `high`) real rather
than decorative.

This collides with three existing spellings of *absence*, and the collision is verbal, not
technical (`"none"` is truthy, so no guard swallows it):

| representation | where | means |
|---|---|---|
| key absent | `config.json` | nothing pinned at this scope |
| `""` | the wire (`agents.model.set`, `jobs.save`) | remove the pin |
| `""` | the app (`EffortState.level`) | nothing in force, or the model discards effort |

`none` means a fourth thing: *pinned, and the pin says do not reason*. The wire keeps `""` for
"remove the pin". Nothing about the clear path changes.

### R4 — The app must not offer two rows that read the same

The effort screen lists the levels, then a row `default (inherit)`. With R3 it would also list a
row `none`, and `effort: none` vs `effort: default` on the confirm line is not a distinction a user
should have to infer. The level row reads `none (no reasoning)`; the inherit row is untouched.

### R5 — The Claude SDK ladder has no bottom, so it is clamped by name

`SdkOptions["effort"]` is `low | medium | high | xhigh | max`. `toSdkEffort` already clamps the
Codex-only `ultra` to `max` with a warning, on the stated principle that a setting must never be
dropped silently. `none` and `minimal` are the same case at the other end and clamp to `low`.

Clamping `none` to `low` is a compromise with no good alternative: dropping the parameter would
land on the SDK's own default of `high`, which is the opposite of what was asked. It is logged, as
`ultra` is.

### R5b — A published ladder is enforced, at the write and at the run

A ladder is only useful if nothing can pin off it. Two guards, and they answer the same question:

- **at the write**: the tag, agent and job editors accept only a rung the model offers
  (`effortLevelsFor`, which for a tag entry answers with its leaf model's ladder). The vocabulary
  was the only check before, so `max` was accepted on a two-rung model while `none` was refused on
  the models that publish it — the fallback list starts at `low`;
- **at the run**: a pin that is off the ladder anyway — the model under a tag changed, the provider
  republished a narrower ladder — is clamped to the nearest rung and logged once per pair
  (`clampEffortToLadder`). Ties go down: spending less than asked is the smaller surprise. An
  absent ladder clamps nothing, per R1.

`effectiveEffort` resolves through the same clamp, so a menu never names a rung the request did not
carry. That divergence is exactly the class of bug R5 and the `supportsEffort` gate already fixed
twice.

### R6 — A provider is matched by name first, host second

The price ladder maps a provider to a models.dev entry by base-URL host, keeping the first entry
per host. `opencode-go` and `opencode` both live on `opencode.ai` and publish different prices for
the same id (`deepseek-v4-flash`: 0.07/0.14 against 0.14/0.28) and different reasoning shapes. The
first-wins rule makes the answer depend on key order in a 3.3 MB file we do not control.

Resolution order becomes: explicit `pricingProvider` on the provider, then the provider key
compared with separators and case folded away (`opencode_go`, `opencodego`, `OpenCode-Go` all match
`opencode-go`), then the host, then nothing. Metadata and price read the same ladder: they are the
same question about the same provider.

### R7 — Enrichment fills gaps, it never overwrites

A model already carrying a field keeps it: a config entry is a statement by the owner, and
discovery from a provider that answers for itself (`claude-sdk`, `codex`, Anthropic's versioned
endpoint) outranks a community database. Enrichment applies to the OpenAI-compatible branch and
fills only what is absent: `label` (the published name), `supportsEffort` and
`supportedEffortLevels`, `vision` (from `modalities.input`), `limit.output`. Context windows keep
the resolution they already have.

### R8 — The manual refresh refetches both tables past their TTLs

`model.refresh` (the app's button) used to refresh discovery only: the id list from each
`discover` provider, re-merged, nothing else. The metadata that fills a discovered model's fiche
(context window, label, vision, effort ladder) comes from two caches with their own TTLs --
models.dev, 24 h on disk, and OpenRouter, 15 min in memory -- and neither was reachable from the
button. A model published between two table downloads showed its id with no window and no ladder
until the TTL rolled over, and pressing "refresh" said nothing was wrong: the count moved, the
fiche did not.

Measured on `deepseek-flash` (DeepSeek V4.1 Flash, released 2026-09-10 between the last table
download and its publication): listed by discovery immediately, context pinned to the global cap
(430 080) with no effort ladder, and every press of the button reproduced it, for as long as the
24 h TTL held.

The button now refetches both tables past their TTLs (`pricing.refresh()` is already an
unconditional fetch; `openRouterModels(true)` skips the TTL check, keeping in-flight coalescing),
then replays the projection. The automatic paths keep their TTLs: the forced fetch is a manual
action, paid in one 3.3 MB download per press, and a human does not press it in a loop.

## Verification criteria

1. `deepseek-v4-flash` on `opencode_go` offers exactly `low, high, max` — not the global six.
2. `qwen3.7-max` offers exactly `none, high`; no model offers a `budget_tokens` rung.
3. `kimi-k2.5` (reasoning, no options published) offers no effort step at all.
4. A junk value (`"default"`, `null`) in `reasoning_options` never reaches a menu or the wire.
5. `EFFORT_LEVELS` — the no-metadata fallback — still holds exactly six levels, none of them
   `none` or `minimal`.
6. `toSdkEffort` maps `none` and `minimal` to `low` and logs, and no `EffortLevel` reaches the SDK
   that its own typing rejects.
7. A provider keyed `opencode_go`, `opencodego` or `OpenCode-Go` resolves to models.dev
   `opencode-go`, and an explicit `pricingProvider` beats all of it.
8. Prices for `opencode_go` come from `opencode-go` (0.07/0.14), not from `opencode`, whatever the
   key order in `api.json`.
9. A model whose label, vision or output limit is already set keeps it after enrichment.
10. The effort step never shows two rows meaning "inherit".
11. A manual refresh refetches the models.dev and OpenRouter tables inside their TTLs; the plain
    paths still serve from cache until they expire.
12. The vocabulary is checked against the live `models.dev` value space by a gated e2e test, so a
    new level published upstream is a failing test rather than a silently dropped rung.
