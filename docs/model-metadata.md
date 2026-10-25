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

Two refinements (2026-10-05), for an owner with several providers. The declared and name rungs only
look at the providers on the URL's exact address when there are any, so OpenCode Zen and Go declared
side by side each answer for their own gateway (before, the first provider on the host answered for
both). And between the name and the host comes the models.dev `api` address, path included: a
provider keyed freely ("work") on `opencode.ai/zen/go/v1` is `opencode-go`, source `api opencode-go`.

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

### R9 — The ladder ends at the vendor the model's name belongs to

A gateway announces the ids it serves, and they are not the ones its table publishes. Measured on
2026-09-11: `opencode_go` is configured `pricingProvider: "opencode-go"` and discovery reports
`deepseek-flash`, while the `opencode-go` table carries `deepseek-v4.1-flash`. The provider rung
misses, and so does the escalation that names the provider's own vendor (`vendorOf("opencode-go")`
resolves to `opencode`, which does not carry the id either -- the model belongs to neither).

The model kept its raw id as a label, offered no effort ladder at all and lost its vision flag. On
the owner's thread that is not cosmetic: `tag:Cheap` routes to this model, so the chat's model
picker offered no effort step anywhere, not even for a model publishing six rungs. The price fell
to the cross-market median as well.

The ladder therefore ends at the vendor the *model's name* designates: the longest `-`-separated
prefix of the id (never shorter than three characters) that is a provider in the table, tried only
after the endpoint that served the call has declined the id. `deepseek-flash` reaches `deepseek`,
which publishes the id verbatim, with its name, its ladder `[low, high, max]`, its vision flag and
its price.

Two bounds hold it in place, and both are tested:

- **Below the endpoint, always.** A model the gateway itself carries is described by the gateway:
  the vendor rung must never answer first, or one model would be described by another's entry.
- **Anchored on a resolved endpoint.** An unknown host still resolves nothing rather than borrowing
  a table. Price reads the same rung, and returns a reference tariff (`billed: false`): the gateway
  bills what it bills, and this is not its table.

### R10 — An id a provider publishes is never an alias

`resolveAlias` answers the ids no table carries: `opus`, a short form the vendor resolves
server-side. It recognises kinship by a token the alias shares with a concrete sibling in the same
group, and two holes in that test let an unrelated model answer for one:

- **A digit is not a name.** `anthropic/claude-fable-5.1:batch` shares the token `1` with
  `thedrummer/cydonia-24b-v4.1`, so the batch variant of a Claude model came back labelled
  *Cydonia 24B V4.1*, carrying its 131 072 window and its `vision: false`. Measured 2026-09-11. The
  version key that picks between siblings makes it worse: `[24, 4, 1]` outranks `[5, 1]`.
- **A catalogue variant is an id, not a short form.** `:batch`, `:free` and `:nitro` are rows a
  provider publishes with their own price. Even a genuine name token in common (`claude` with
  `anthropic/claude-sonnet-5`) says nothing: the variant is not a nickname for anything.

Both are refused now, and the guard is load-bearing in the direction that matters: a model with no
metadata of its own stays undescribed rather than borrowing. What still resolves is what the rung
exists for -- a short form the owner declared, filed in the same group as the concrete versions it
stands for, and carrying at least one of their name tokens.

### R11 — An aged cache is not an absent one

The in-memory OpenRouter catalogue answered `undefined` as soon as its 15-minute TTL elapsed. Every
OpenRouter model then lost the table that knows it -- models.dev does not carry the batch variants
at all -- and fell into the state R10 describes: undescribed, and eligible for the alias rung.
The name changed from one projection to the next as the cache aged, which read as a haunted model
rather than a lookup going wrong: `Cydonia 24B V4.1`, then the raw id, then back.

The TTL belongs to `openRouterModels()`, which is what decides to refetch (boot, the six-hour
timer, the manual refresh). The synchronous reader answers with the last catalogue it was given,
which is already how the models.dev table behaves with its 24-hour copy on disk. A fetch that
failed still leaves an empty catalogue, and every caller reads that as "no evidence" exactly as
before.

### R12 — A family's own facts, and only where nobody else spoke

Some facts are the model's, and no endpoint publishes them *for us*. A reseller lists an id and
nothing else; models.dev describes only the providers it knows; and a local gateway like litellm is
in neither. Measured 2026-09-21, `litellm/mimo-v2.6-pro` resolved with **no metadata at all** — the
field its reasoning has to be replayed in, the output budget its thinking eats into, and its
ability to take an image were all left to a hand-written declaration, and the owner had declared
the one field that does nothing on that path (`thinkingTypes`, Anthropic-only).

`src/llm/families.ts` is the last rung: a small ordered table from an id pattern to defaults, read
by `applyModelMetadata` *after* OpenRouter and models.dev. Rules:

- **Fills, never overwrites.** A declaration, an OpenRouter row or a models.dev row wins; the family
  speaks only into an empty field. That is what makes it safe to keep: `opencode_go/mimo-v2.5-pro`
  keeps the table's own `128000` output, and a declared `reasoning_details` stays.
- **Keyed on the model's name, not the reference.** The provider prefix and any marketplace
  namespace are stripped first, so `litellm/mimo-v2.6-pro` and `opencode-go/mimo-v2.6-pro` are the
  same model. Case-insensitive, and the separator is load-bearing: `mimosa-1` is not a MiMo.
- **Only facts that hold for every member.** The pass-back field is `reasoning_content` across
  versions and every published row that names one names it; vision is **not** a family fact
  (`mimo-v2-pro` and `mimo-v2-flash` are text-only) and is scoped to the v2.6 tiers, which are
  multimodal in all three of their published rows.
- **It does not need the table.** The enrichment's bootstrap guard returns early when neither source
  has data; the family is included in that guard, because a boot with nothing downloaded is exactly
  when it is the only thing left.

What it is not: a place to hardcode a price. Prices are the endpoint's and stay where they are.

### R13 — A model that cannot answer a conversation is not offered one

A `/models` listing carries everything the provider serves, and most of it is not a chat model.
Measured live 2026-10-25 on this install's Gemini endpoint: **60 ids, of which 3 are embeddings, 5
are speech, 6 are image and 2 are realtime** — and all of them were "ready" (the key is there), so
all of them were selectable as the model a conversation answers with.

`kind` is the field that separates them, and it is read from the strongest witness available, in
this order:

1. **The listing that says so.** OpenRouter publishes its embeddings apart from its chat models
   (`/embeddings/models`, 35 rows, none of them in `/models`) and discovery reads both.
2. **models.dev's `type`** (`embedding`, `speech`, `transcription`, `image`, `video`, `reranking`,
   `realtime`, `chat`), kept verbatim in the compacted table. 8 476 of its rows declare none, which
   is read as `chat`.
3. **The id's own shape**, for rows no table has ever seen. Narrow on purpose: a path segment
   `embed`/`embedding`/`embeds`, `transcribe`/`transcription`, `tts`, `native-audio`, `live`,
   `lyria`. Measured on the 22 of Gemini's 60 ids that models.dev has no row for, it caught every
   embedding and every speech model and left `-image` alone (a vision *input* model far more often
   than a generator).

Two rules keep it safe:

- **A declared model is never reclassified.** Declaring one in `llm.models` is an act of intent;
  hiding it from the menu it was written for would be the tool overruling its owner.
- **The catalogue keeps it, only the menu drops it.** `runnableModels` is what a picker reads, and
  `kind` keeps a non-chat model out of it. Availability stays what it always was — whether the
  provider can be called — because the embeddings page reads exactly that half.

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
13. An id the configured table does not carry is described and priced by the vendor its name
    designates: `deepseek-flash` on `opencode_go` gets `DeepSeek V4.1 Flash`, `low, high, max`,
    vision, and `0.15/0.60` rather than the cross-market median.
14. That rung never outranks a table that carries the id, and an unknown host still resolves
    nothing.
15. A catalogue variant (`:batch`) inherits nothing from a sibling it happens to share a version
    digit with, and keeps its own catalogue row when one is loaded.
16. A short form the owner declared still resolves to its family, and an aged OpenRouter cache
    still describes its models.
17. A MiMo on a provider no table describes gets `reasoning_content`, `vision` (v2.6 only) and a
    `131072` output budget, with no table downloaded at all; a declaration and a table both
    outrank it, and a model outside the family is left untouched.
18. `gemini-embedding-001`, `gemini-3.8-flash-tts` and `gemini-3.8-live` never appear in a model
    picker, while `gemini-3.8-flash` still does — and a declared id is untouched by any of it.
19. `models.dev`'s `type` survives the compaction (`CACHE_VERSION` 5), and an unknown spelling is
    dropped rather than guessed into a meaning.
