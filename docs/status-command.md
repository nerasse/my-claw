# /status: session diagnostics

`/status` answers one question -- what is this conversation actually doing right now, and what has
it cost. It already reported model, id, message count, timestamps and lifetime tokens. This spec
extends it into the debug view, and adds the capture that was missing: sub-agent attribution, the
cache split, and a price.

No new command. `/session` was considered and rejected: `/status` already carried most of the
fields, and two commands answering the same question would have to be kept in sync forever.

## The two totals problem

A session id is derived from the room or chat, never from the conversation:

```
matrix/room/!6ZM4zLHzS2lLy6NqjT:kssimi.fr
```

It is stable for the lifetime of the room. `/new` archives the transcript and resets
`session.tokenUsage`, but `analytics.db` keeps writing under the same `session_id`. Measured on the
live database for that exact id:

| Source | Calls | Tokens |
| --- | --- | --- |
| `session.tokenUsage` (session JSON) | 6 | 52 242 |
| `api_calls` (analytics, 90 d retention) | 569 | 31 667 674 |

Both are correct. They answer different questions: *this conversation* against *this room, over the
retention window*. Showing one number would be a lie by omission, so `/status` shows both, labelled.

## Real context against estimated context

Two numbers describe context occupancy and they do not agree.

The **measured** one is `prompt_tokens` from the provider on the last call -- exact, and free, it is
already a column in `api_calls`. The **estimated** one is `chars / 4 * 1.15`
(`src/llm/tokens.ts:4-13`).

The estimate is the one that matters operationally: `maybeAutoCompact`
(`src/agent/bridge.ts:881-893`) compares *it*, not the measured value, against
`limit.context * threshold`. Showing both side by side turns a silent mis-tuning into something
visible -- if the estimate drifts far from the measurement, compaction fires at the wrong time.

Context limits are only declared for the 11 Anthropic-discovered models out of 31 in the catalogue
(`src/llm/catalog.ts:233`). Codex and OpenAI-compatible discovery populate no `limit`
(`catalog.ts:270-286`), so those fall back to `DEFAULT_CONTEXT_TOKENS = 128_000`. The output says so
rather than presenting a guess as a measurement.

## Attributing sub-agent and browser usage

Sub-agents and the browser bill to their own session ids, so a parent chat under-reports its true
cost. On the live database that is 1 910 sub-agent calls and 1 505 browser calls, 15.5 M tokens
outside any chat total.

Read-time reconstruction was rejected. `SubAgentMeta.createdBy` holds the parent **chatId**, not a
session id (`src/subagents/runner.ts:68`), which cannot separate a thread session from its room
session; `kill` deletes the session file and orphans the rows; and the browser records a hardcoded
literal `sessionId: "browser-subagent"` (`src/agent/subagents/browser.ts:242,373`) with no parent
reference at all. Best-effort would have been wrong in three distinct ways.

So the link is captured at write time, in a new nullable column.

### Where the id comes from

The obvious implementation -- thread a `parentSessionId` argument from the spawn tool down through
the runner -- costs five signature changes in `runner.ts` alone, plus a new positional parameter on
two backend constructors where `dispatcher.ts` already passes ten.

It is not necessary. `run-registry.ts` already maps `sessionId -> AbortController` in `startRoot`
(`src/core/run-registry.ts:52-56`), and the root `AbortSignal` is *already* shared by every nested
run: the spawn and send tools read it from `args["__signal"]`, and `delegate.ts:38` extracts it for
the browser. The registry header states the reason it exists -- the shared signal is the cross-level
link, and it cannot diverge from the real abort.

Adding the reverse map turns the parent lookup into a function of something every call site already
holds:

```
rootSessions: Map<AbortSignal, string>    set in startRoot, deleted in end
rootSessionFor(signal?): string | undefined
```

That approach was dropped. It yields the *root* session rather than the immediate parent, and the
distinction stops being academic the moment depth is allowed to grow or a sub-agent is added
dynamically -- it would keep answering, silently, with the wrong session.

Parentage is instead a property of the session, written once at creation into the metadata the
runner already builds, and persisted with it:

```
SubAgentMeta.parentSessionId    the session that created this agent
session.invokedBy              the session that triggered the run now executing
api_calls.parent_session_id    the payer at the time of the call, immutable
```

`attributionParent()` reads them strongest first and falls back to the session's own id. This
works at any depth, survives restarts and LRU eviction, and a new spawn path inherits it without
anyone remembering to thread an argument. Its failure mode is visible rather than silent: a missing
parent bills the agent to itself, which shows up as unattributed work instead of misfiling tokens
onto the wrong conversation.

The browser is the exception and gets the caller explicitly, because it has no session of its own
and shares the root abort signal -- deriving it would credit a sub-agent's browsing to the
top-level chat.

Compaction is maintenance on a session rather than delegated work, so it records itself. Recording
self rather than `NULL` keeps `WHERE parent_session_id = ?` complete without a `COALESCE`.

### Movement needs no history table

Sub-agents are global, so a chat other than the creator can drive one, and the bill has to follow.
Neither a migration nor a movement log is needed for that: the unit of attribution is the *call*,
and `api_calls` is already an append-only timestamped fact table. `send()` sets `invokedBy` before
the run, each row records the payer it had at the time, and the history falls out of a group-by:

```sql
SELECT parent_session_id, MIN(timestamp), MAX(timestamp), COUNT(*), SUM(total_tokens)
FROM api_calls WHERE session_id = 'subagent/digger-c3d4' GROUP BY parent_session_id
```

Rewriting the session's parent on each send would have been actively wrong to read back: it holds
only the latest value, while old rows need the one they had at their own date.

## Cost in USD

Prices come from [models.dev](https://models.dev), the community database opencode uses. One
endpoint, `https://models.dev/api.json`, 3.3 MB, shaped `provider -> models -> model`:

```json
"cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
```

USD per million tokens. Coverage measured on the live file: 5 935 models, 5 529 priced, 2 724 with
`cache_read`, 1 011 with `cache_write`.

### The price depends on the provider, not the model

This is the part that makes a naive implementation wrong. The same model id is sold by many
providers at different prices. Measured for the models this instance actually runs:

| Model | Providers | Input, cheapest -> dearest |
| --- | --- | --- |
| `gpt-5.6-luna` | 12 | $0.10/M -> $1.00/M |
| `claude-sonnet-5` | 10 | $0/M -> $3/M |
| `mimo-v2.5-pro` | 7 | $0/M -> $0.435/M |
| `claude-opus-5` | 7 | $5/M -> $6/M |

Indexing by model id and taking the first hit would be off by 10x on the model most recently in
use. The provider has to be resolved, and the only per-call evidence of it is the `base_url` column
already in `api_calls`.

### Resolving the provider

Five rules, tried in order. A proxy is asked before it is guessed at.

**1. The proxy states its own cost.** LiteLLM returns it on the completion route itself -- the one a
restricted virtual key is allowed to call -- as response headers:

```
x-litellm-response-cost-original: 0.0
x-litellm-model-api-base: https://token-plan-ams.xiaomimimo.com/v1
x-litellm-model-group: mimo-v2.5-pro
```

This is ground truth from the owner's own billing, per call. It is currently discarded: the fetch
`Response` is in hand at `provider.ts`, and only the body is read.

`0.0` is ambiguous -- it means both "free" and "no price configured" -- so it is only trusted when
positive, and otherwise falls through to rule 2 for confirmation.

**2. The proxy states its upstream.** `x-litellm-model-api-base` names the real endpoint behind the
proxy, which turns the unknowable case into rule 3. Here it resolves to
`https://token-plan-ams.xiaomimimo.com/v1`, whose host matches the models.dev provider
`xiaomi-token-plan-ams` exactly, priced `input 0, output 0, cache_read 0`.

Two independent sources therefore agree that this traffic is free: the proxy's own cost header and
models.dev's entry for the upstream it names.

**3. The engine names the vendor.** Two backends are not generic HTTP clients, they talk to exactly
one company, so there is nothing to infer:

| `base_url` | Provider | Calls |
| --- | --- | --- |
| `claude-sdk` | `anthropic` | 59 |
| `https://chatgpt.com/backend-api` | `openai` | 9 |

**4. Exact host match against the `api` field**, applied to `base_url` or to the upstream from rule
2. 152 of the 177 providers in models.dev declare their endpoint;
`https://api.fireworks.ai/inference/v1` matches `fireworks-ai` with no ambiguity.

**5. Median of the non-zero prices**, and only then. See below for why this rule is dangerous and
must stay last. An optional `pricingProvider` key on the provider config overrides it for owners who
know their upstream; it is expected to stay unset.

### Never report zero

A resolved price of `0` is not a useful answer. It is what a flat plan, a subscription and a
self-hosted model all look like, and printing `$0.00` throws away the only interesting number --
what the traffic would have cost if rented.

So a zero price is not an answer, it is a signal to climb. Provider ids in models.dev nest by
convention, and truncating on `-` until a provider exists walks from a plan to its vendor:

```
xiaomi-token-plan-ams  ->  xiaomi                    0.435 / 0.87 / cache 0.0036
azure-cognitive-services -> azure
opencode-go            ->  opencode
fireworks-ai           ->  (no parent, it is the vendor)
```

`mimo-v2.5-pro` therefore prices at the xiaomi rate rather than at zero, and lands in the reference
column instead of the billed one. The two columns already existed for subscriptions; flat plans and
self-hosted models simply join them.

### Matching the model id

Provider ids are namespaced inconsistently on both sides -- my-claw records
`accounts/fireworks/routers/kimi-k2p6-turbo`, models.dev carries `TEE/qwen3.6-35b-a3b-uncensored`
and `Qwen/Qwen3.6-35B-A3B` -- and self-hosted builds append quantisation and variant suffixes that
no catalogue will ever list.

The lookup index is therefore built on both the full id and its last path segment, lowercased, and
the query tries progressively looser candidates:

The same version is written many ways, and models.dev contains all of them at once:

```
claude-opus-4-8   claude-opus-4.8   claude-opus4-8
kimi-k2p6-turbo   kimi-k2.6-turbo
glm-5p2           glm-5.2           glm-5-2          glm5.2-fast
minimax-m2p7      minimax-m2.7      minimax-m2-7     minimax-m27
deepseek-v3.2     deepseek.v3.2
```

The `p` stands for the decimal point and is not a local quirk -- `glm-5p2`, `kimi-k2p6`,
`qwen3p7-plus` and `minimax-m2p7` are all real models.dev ids, and this instance already runs
`accounts/fireworks/routers/kimi-k2p6-turbo`.

So the lookup is a ladder of five progressively looser keys. **Each level is tried only when the
previous one found nothing**; an exact match is never overridden by a normalised one.

| Level | Transformation | Keys | Merges |
| --- | --- | --- | --- |
| 1 | the id as recorded | 2 655 | 0 |
| 2 | last path segment, lowercased | 1 922 | 0 |
| 3 | version separators collapsed, `(\d)[-._p](\d) -> $1$2` | 1 805 | 105 |
| 4 | variant and quantisation suffixes stripped | 1 770 | 126 |
| 5 | all remaining separators removed | 1 728 | 149 |

Levels 1 and 2 merge nothing at all, so a hit there is unambiguous. From level 3 the result is
marked `~`: the price belongs to an id that was matched, not recorded.

The normalisation works in both directions, which is the point. `kimi-k2p5` collapses to `kimi-k25`
and finds `kimi-k2.5`; `glm-52` is already collapsed and finds `glm-5.2`, `glm-5p2` and `glm-5-2`
because they all collapse onto it. Level 5 exists for the cases the digit rule cannot reach --
`glm5.2` with no dash, `claude-opus4-8` with the dash misplaced, `deepseek.v3.2` with a dot -- and
adds 42 merges, every one of them a respelling of the same model.

**Measured before adopting.** Across the 2 776 distinct priced ids, no level merges two genuinely
different models. The rule at level 3 stays confined to digit-digit boundaries, so it never touches
`gpt-4o` or `k2-code`, neither of which has a digit on both sides of its separator.

A first pass at this measurement flagged 68 merges as suspect because prices inside them varied by
more than 1.5x. That metric was wrong: the spread comes from different providers reselling the same
model, which is exactly what the provider ladder exists to resolve, not evidence of a bad merge.
Recorded because the number is alarming and someone will re-derive it.

### Aliases resolve through the local catalogue

models.dev has no `opus`, `sonnet` or `haiku` -- they are not models, they are pointers Anthropic
resolves server-side. But the catalogue my-claw already builds does carry them, and it files them
next to the concrete versions:

```json
{"id":"opus",          "label":"Opus (auto)", "group":"Claude (abo)/Opus"}
{"id":"claude-opus-5", "label":"Opus 5",      "group":"Claude (abo)/Opus", "limit":{...}}
{"id":"claude-opus-4-8","label":"Opus 4.8",   "group":"Claude (abo)/Opus", "limit":{...}}
```

The alias is recognisable without a hardcoded list: it shares a `group` with concrete models and
carries no `limit`, because discovery only reports a context window for a real version. So an alias
prices as the newest concrete model in its own group.

**Newest, specifically, not any.** Opus pricing is not flat across versions:

| Versions | Input / Output |
| --- | --- |
| `claude-opus-5`, `4-8`, `4-7`, `4-6`, `4-5` | 5 / 25 |
| `claude-opus-4-1` | 15 / 75 |

Those 24 alias calls are $2.52 at the current rate and $7.56 at the 4-1 rate -- a factor of three
riding on which member of the group is picked. Sonnet has the same shape in reverse
(`claude-sonnet-5` is 2/10 while the 4-x line is 3/15), so the rule is not an Opus quirk.

Picking the newest is right because that is what "auto" means: the alias tracks the current
flagship, and no plausible resolution of it lands on a two-generation-old model. The result is
still marked `~`, because the version is inferred rather than recorded.

The better answer, where it applies, remains rule 1: these calls run on the Claude SDK, whose
`total_cost_usd` is authoritative and needs no version at all -- once that field stops being
discarded at `backend.ts:553`.

### The catalogue also knows the provider

Worth recording because it costs nothing: every catalogue entry carries a `provider` field naming
the configured provider it was discovered from -- `litellm` for 11 models, `anthropic` for 14,
`chatgpt` for 6. It is my-claw's own provider name rather than a models.dev id, so it does not
replace the `base_url` ladder, but it resolves a model that has never been called and therefore has
no row in `api_calls` to read a `base_url` from.

### Why the median is the last rule and not the third

The first draft of this spec ranked the median above proxy interrogation, and justified excluding
zero-priced providers on the grounds that they are subscription plans rather than per-token
tariffs. Measured against reality, that reasoning was backwards.

`mimo-v2.5-pro` carries 1 117 of the calls on this instance. The median of its non-zero offers is
`0.435`, the first-party xiaomi price, which prices the traffic at **$18.44**. The proxy actually
routes to `token-plan-ams`, a flat plan, and the true cost is **$0**. The excluded zeros were not
noise, they were the answer.

The lesson generalises: a median describes what a model costs on the open market, not what this
deployment pays for it. It is a reasonable last resort for an endpoint that reveals nothing, and it
must be labelled an estimate wherever it is used.

### Billed against reference

`docs/prompt-caching.md` already states it for the two subscription backends: *"both `claude-sdk`
and `codex` are subscription auth (not billed per token)"*. Printing a dollar figure against them as
if it were a charge would be false; printing nothing would lose the number that justifies the
subscription. So two figures, never summed:

- **billed** -- per-token endpoints only, real marginal cost.
- **reference** -- what the subscription paths would have cost at list price, marked with `*`.

For `claude-sdk` there is a better source than any price table: the SDK computes `total_cost_usd`
and a per-model `costUSD`, and `backend.ts:553-570` reads only `subtype`, `errors` and `result`,
discarding them. That number already accounts for cache and is used in preference to models.dev.

### Two approaches that do not work

Recorded so they are not attempted again.

**The npm heuristic.** The obvious way to find a first-party provider is to look for a dedicated SDK
package, resellers being expected to share a generic one. Measured: 140 of 177 providers declare
`@ai-sdk/openai-compatible`, and that set includes `xiaomi`, `moonshotai` and `fireworks-ai` -- the
origins themselves. There is no first-party flag in models.dev, and no field substitutes for one.

**The LiteLLM admin API.** `/model/info` and `/model_group/info` expose the proxy's cost map and
both return `403`: *"Virtual key is not allowed to call this route. Only allowed to call routes:
['llm_api_routes']"*. Reaching them would mean provisioning an admin-scoped key, trading a pricing
lookup for a credential that can reconfigure the proxy.

Unnecessary anyway -- the same information rides on the completion response as headers, which the
restricted key already receives. Rule 1 above.

### Measured end to end

The four rules run against the whole live database, 13 062 rows:

| Model | Calls | Rule | Cost |
| --- | --- | --- | --- |
| `mimo-v2.5-pro` | 1 117 | plan `xiaomi-token-plan-ams` -> vendor `xiaomi` | *$18.44 |
| `accounts/fireworks/routers/kimi-k2p6-turbo` | 204 | host -> `fireworks-ai` | $20.26 |
| `claude-opus-5` | 33 | engine -> `anthropic` | *$5.85 |
| `opus` | 24 | alias -> newest in group -> `claude-opus-5` | *~$2.52 |
| `gpt-5.6-luna` | 9 | engine -> `openai` | *$0.02 |
| `mimo-v2.5` | 2 | plan -> vendor `xiaomi` | *$0.01 |
| `claude-sonnet-5` | 2 | engine -> `anthropic` | *$0.05 |
| `Qwen3.6-35B-A3B-uncensored` | 1 | id matched at `nano-gpt` | *~$0.00 |

**Billed $20.26. Reference $26.89.** `*` marks a price that is not a charge, `~` a price borrowed
from a neighbouring or inferred model id.

Every model resolves. The billed figure comes down to a single direct vendor: the proxy serves only
`mimo-*` on a flat plan and self-hosted Qwen builds, and the two subscription backends are not
metered.

The fireworks line remains an upper bound -- it prices every input token as fresh, because the cache
split does not exist in the table yet.

### Cached prices are the whole point

The cache split is not a refinement of this feature, it is a precondition. For `mimo-v2.5-pro`,
which carries 1 117 of the calls on this instance:

```
input      $0.435 / M
cache_read $0.003625 / M      -> 120x cheaper
```

Across the whole database that model carries 41.7 M input tokens, and the cache ratio moves the
bill by an order of magnitude:

```
  0% cached   $18.44
 50% cached    $9.44
 80% cached    $4.05
 95% cached    $1.35
```

Without knowing the split, the number is not approximate, it is meaningless -- and it is the
largest single line in the total.

The data is on the wire and thrown away in two different places:

| Path | What arrives | What happens to it |
| --- | --- | --- |
| OpenAI-compatible | `usage.prompt_tokens_details.cached_tokens` | Not declared in `ChatCompletionResponse.usage` (`provider.ts:125-131`) nor in the stream chunk (`:148-154`); `normalizeUsage` (`:271-278`) cannot see it |
| Claude SDK | `cache_read_input_tokens`, `cache_creation_input_tokens` | Summed into `promptTokens` on the line that reads them (`backend.ts:799`) |

The first row is not a supposition. A two-word probe against the live proxy returned:

```json
"usage": { "prompt_tokens": 252, "completion_tokens": 1,
           "prompt_tokens_details": { "cached_tokens": 192 } }
```

76 % of the prompt served from cache on a trivial request, reported by the provider, parsed by
nobody.

The irony is that `cache_control` is deliberately sent on the home loop (`provider.ts:169-191`) and
gated per provider, so the feature works and has simply never been observable. Fixing the split
gives prompt caching its missing instrumentation, independently of the price.

Required changes: widen `LlmUsage` (`provider.ts:97-101`) with `cacheReadTokens` and
`cacheWriteTokens`, declare and read `prompt_tokens_details` on both response shapes, stop
collapsing the two Anthropic fields at `backend.ts:799`, and add two columns beside the existing
token columns.

### Fetching and caching the table

Same treatment as the model catalogue: fetch on boot, keep a local copy at
`~/.my-claw/model-pricing.json`, refresh on a TTL, tolerate the network being down by using the
stale copy. Only `provider / id / cost` is retained, so the 3.3 MB download becomes a small file.

An absent price is rendered `-`. It is never rendered `0`, because `0` is a real price in this data
set -- several providers genuinely list free models, and the two must stay distinguishable.

### Deliberately ignored

`cost.tiers` and `cost.context_over_200k` encode long-context surcharges (Gemini and Qwen mostly,
where a prompt above 200 k tokens is billed at a higher rate). `cost.reasoning` prices thinking
tokens on some Nebius models. None of the models in use here carry them, and the measured prompt
size on this instance is around 10 k tokens, so the flat rate is used and the tiers are ignored.
Recorded here so the omission is a decision rather than an oversight.

## First schema migration in the repo

`analytics.db` is created with `CREATE TABLE IF NOT EXISTS` (`src/analytics/usage-db.ts:20`), which
is a no-op on an existing file. Adding columns to that block alone would change nothing for the
13 062 rows already on disk, and the prepared INSERT would then fail against a table missing them --
silently, because `recordApiCall` swallows its errors (`usage-db.ts:103`).

The pattern already exists in `src/memory/db.ts:50-56` and is copied verbatim:

```ts
function ensureColumn(d: Database, table: string, column: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
```

Five columns are added: `parent_session_id TEXT`, `cache_read_tokens INTEGER`,
`cache_write_tokens INTEGER`, `upstream_api_base TEXT` and `proxy_cost_usd REAL`. Two constraints
follow from SQLite. `ADD COLUMN` cannot be `NOT NULL` without a constant default, so they are
nullable like `error`. And the index on `parent_session_id` must be issued *after* `ensureColumn`,
not inside the `CREATE TABLE` exec block, or the whole statement throws on an existing database.

Verified against a copy of the live database: 15 columns to 20, 13 062 rows preserved, new rows
complete, historical rows left NULL.

Cost is computed at read time from the token columns rather than stored, so that a price correction
in models.dev applies to history instead of freezing whatever the table said on the day of the call.

The migration is not retroactive. The 15.5 M tokens already recorded stay unattributed and
uncached-split, so rows written before the upgrade price as if nothing was cached. The rollup is
honest about the boundary rather than pretending the history is complete.

## Output

```
Session
  id            matrix/room/!6ZM4zLHzS2lLy6NqjT:kssimi.fr
  platform      matrix - group - scope per-room
  created       2026-07-31 09:12 (3h ago)
  last active   2026-07-31 12:53 (2m ago)
  messages      13

Model
  current       gpt-5.6-luna (session override)
  config default mimo-v2.5-pro
  backend       openai - provider litellm
  context limit 128 000 (default, not declared for this model)

Context
  measured      10 111 tokens on the last call - 7.9% of the limit
  estimated     9 400 tokens (chars/4, this is what drives auto-compaction)
  auto-compact  on, threshold 80% = 102 400

This conversation (since /new)
  6 calls - in 51 000 - out 1 242 - total 52 242

This session, 90 d (analytics)
  569 calls - 0 errors - 1h12 total
  billed        $1.52        cache saved $9.80
  reference    *$2.45        flat plans, subscriptions, self-hosted

  model              calls        in     cached       out      cost
  mimo-v2.5-pro        487     25.3M      24.1M   170 545    *$2.14   xiaomi plan
  kimi-k2p6-turbo       36      4.9M       4.2M    10 936     $1.52   fireworks
  claude-opus-5         33      1.2M          -       311    *$0.31   claude-sdk
  gpt-5.6-luna           8       97k          -     1 898    *$0.02   codex
  opus                   5       67k          -        15         -   alias, unpriced
  * not a charge, reference price   ~ price of a neighbouring model id

Spawned by this session (90 d)
  sub-agents    142 calls - 1.1M tokens - $0.09
  browser        38 calls - 2.4M tokens - $0.21

Runtime
  active run    none
  verbose       on
  approved      write, edit
```

One command, one output, always this long. There is no short form and no `/status full`: the value
of the view is that everything is on screen at once, and a summary that hides the line you needed
is worse than no command.

The per-model breakdown is the debug payload. Distinct rows for `opus` and `claude-opus-5` are an
alias artefact, and `opus` being the single unpriced line is the visible consequence -- exactly the
kind of thing this view exists to expose.

## Shared handler

`/status` is currently duplicated verbatim between
`src/channels/matrix/session-handlers.ts:534-566` and
`src/channels/telegram/session-handlers.ts:298-330` -- a copy-paste pair, byte for byte. Tripling
the body in two places is not an option, so it moves to `src/channels/status-command.ts`, following
`introspect-commands.ts`: channel-agnostic params in, string out, the caller injects the registries.

## Out of scope

**Compaction and trim counters.** Nothing is persisted when either fires; only a hook event is
emitted. Adding counters means new session fields, and no diagnostic here depends on them yet.
