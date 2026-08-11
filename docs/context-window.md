# Context window: resolution, cap, and trigger

How my-claw decides how much context a model may hold, why that number is capped below what
the provider allows, and why the compaction trigger stopped trusting `chars/4`.

Three separate concerns, deliberately kept apart:

1. **Resolution** — what window does this model actually have?
2. **Cap** — how much of it do we agree to use?
3. **Trigger** — how do we know how full it currently is?

Conflating them is what produced the original bug: a single `DEFAULT_CONTEXT_TOKENS = 128_000`
served as all three answers at once.

## Why this exists

`/status` was built first, and it exposed the problem by printing the number instead of only
using it. Measured on the live install:

| model | assumed | real | ratio |
|---|---|---|---|
| `mimo-v2.5-pro` (default, 487 calls) | 128 000 | 1 048 576 | 8.2x |
| `gpt-5.6-luna` | 128 000 | 1 050 000 | 8.2x |
| `claude-opus-5` | 128 000 | 1 000 000 | 7.8x |

The number is not cosmetic. It drives auto-compaction (`bridge.ts`), the `maxTokens` request
(`claude-sdk/backend.ts`), and `trimToContextWindow` (`llm/tokens.ts`).

An honest caveat on severity: **zero compactions had ever fired** across 569 recorded calls.
The two errors partly cancelled — the estimator under-counts, the limit under-counts — so the
trigger landed around 235k real tokens instead of 838k. Premature by ~4x, latent rather than
active. This document fixes a design fault, not an outage.

## 1. Resolution

Three rungs, first hit wins. Each resolved window carries its provenance so `/status` can say
where the number came from.

| # | source | authority |
|---|---|---|
| 1 | `llmConfig.limit.context` | config declaration, else provider discovery |
| 2 | models.dev `limit.context` | community table, 98% coverage |
| 3 | `DEFAULT_CONTEXT_TOKENS` | last resort, marked as such |

### Rung 1 already carried both answers

A per-model window was assumed to be missing and turned out to exist: `LlmModelConfig.limit`
is declarable in config, the catalogue writes the same field on discovery, and `mergeModels`
already resolves the collision in the owner's favour ("Config always wins on id collision").
Declaration and discovery are therefore one rung, not two, and no new config key was needed.

### LiteLLM was considered and dropped

`/model_group/info` would be authoritative for proxied models. It is unreachable: the virtual
key is scoped to `llm_api_routes`. Measured:

```
/v1/models          200   id, object, created, owned_by only. No window.
/model/info         403
/model_group/info   403
```

LiteLLM knows the window internally — it ships `model_prices_and_context_window.json` — but
will not disclose it to this key. Implementing the rung would mean coding against a guessed
response schema, which is the same unverifiable work as the llama.cpp probe below and is held
to the same standard. It adds nothing while models.dev covers 98%. Revisit against a real
observed response if the key is ever widened.

### Rung 2 was already on disk

`llm/pricing.ts` downloads models.dev every 6h for prices. Its `compact()` kept only `cost`
and the canonical `id`, discarding `limit` — present on 5 927 of 6 044 models. The field is
now retained. No new network traffic.

### What still reaches rung 3

After the two upper rungs, 12 of 31 catalogue entries fall through: the 9 local Qwen ggufs and
the 3 bare Claude aliases. This is why `DEFAULT_CONTEXT_TOKENS` is 262 144 — 256Ki, the native
window of the Qwen3.x family that is effectively its only consumer.

It is deliberately **not** rounded up to 264 000. The old 128 000 sat just below the true
131 072; keeping the margin on the low side matters because this value also sizes `maxTokens`,
where overshooting the real window overflows rather than merely wasting it.

### Local models are not resolvable, only declarable

llama.cpp runs on a personal workstation, reachable only from LiteLLM. Measured from the
my-claw host: LiteLLM sits behind a public address, the two LAN neighbours have every
candidate port closed, and no upstream base had ever been recorded. Querying llama.cpp
`/props` for the runtime `n_ctx` was considered and **dropped**: there is no network path to
test it on, and an unverifiable network probe is not worth shipping.

For these models the operator is the only reliable source, because the operator is who passed
`--ctx-size`. Rung 1 exists for exactly this.

## 2. Cap

Very long contexts degrade attention quality and bill linearly. A global ceiling therefore
applies **after** resolution:

```
effective = exempt(model) ? raw : min(raw, cap)
```

- `context.cap` defaults to **512 000** and is active without configuration.
- `context.capExempt` is a list of glob patterns matched against the model id.

The cap never raises a window, only lowers it. A model resolved at 262 144 is untouched.

### One rule, no exceptions ladder

An explicitly declared `contextLimit` (rung 1) **is still capped**. Declaration and cap are
both deliberate, so ranking them against each other would mean two competing rules to hold in
mind. Instead: the cap is unconditionally the last step, and the single way to exceed it is to
name the model in `capExempt`.

### Glob rather than exact ids

Exact matching would require listing all 9 `Qwen3.6-35B-A3B-uncensored-*` variants
individually. Patterns collapse a family to one line:

```json
"context": { "cap": 512000, "capExempt": ["claude-*", "Qwen3.6-*"] }
```

### Assumed behaviour change

Enabling the cap by default moves `mimo-v2.5-pro`, the `gpt-5.6-*` family and `claude-*` from
roughly 1M to 512k on the first start after upgrade. This is intended, not incidental.

## 3. Per-conversation and per-agent overrides

The cap is a standing policy. Two things override it, and both are set independently of each
other and of every other agent.

### The `/model` flow

Context is the **third step of the chain**, after the effort one:

```
model  ->  effort  ->  context
```

```
Full: 1,048,576 | 512,000 (cap) | 256,000 | 128,000 | 64,000 | Keep current
```

Also reachable from the root menu as `Context >`, to change it without re-selecting a model.
The step is skipped entirely when the model has a single possible window: a lone option is not
a choice, and a model below every offered ceiling has nothing to arbitrate.

A **config flow** (agent, global default, job) staging a `tag:` reference skips the step too, for
the same reason it skips the effort one: the tag pins its own ceiling and that pin outranks the
scope's, so anything chosen here would be dead config. A chat keeps both steps, because a
session's own choice still sits above the tag.

### One resolution, every surface

Menus and `/status` must offer exactly the window the run will use, so they all go through
`resolveModelContextWindow` (`src/llm/context-window.ts`) rather than assembling the options
themselves. It resolves two things the callers used to get wrong on their own:

- the **declared window** is read from the model the id *ends on*, so a `tag:` reference reports
  the window of the model behind it. Reading `llm.models` by the literal id is what made every
  tag report `DEFAULT_CONTEXT_TOKENS`: no tag reference is ever a key of that list. The run was
  right all along, only the display lied — a 1M model behind a tag was offered a 262k ceiling;
- a model with no window of its own inherits `llm.limit.context`, the same fallback the resolver
  hands the run.

The id keeps its identity through the call (`model: "tag:Cheap"`, not the expanded id): the
ceiling that applies is the tag's, and `standingContextCap` is the single implementation of that
precedence, used by both the resolution and the menus.

Lower tiers exist because lifting the policy is not the only useful direction. A shorter prompt
is cheaper and faster, and one conversation may be worth spending less on.

### Per conversation

Stored as `contextOverride` on the session: `"full"` or a number. `"full"` is stored as the word
rather than the current number so it survives a model change.

**Sub-agents are sessions**, so each one already carries its own independently of the chat that
spawned it: the runner loads `subagent/...` and the bridge reads that session's field. Nothing
is shared with the parent.

### Per agent

`/model <agent>` offers the same context step, and writes `agents.<name>.context.cap` in the
config. A research agent reading long documents and a cron job posting a one-line summary do
not want the same window.

An agent's key **wins outright** over the global cap rather than being combined with it.
Granting one agent more than the standing policy has to be expressible without editing the
policy, and a `min()` would silently refuse exactly that. `0` lifts the ceiling for that agent
alone.

### Precedence

```
session override  >  agent cap  >  capExempt  >  global cap
```

A numeric session override wins in both directions, including over an exemption: the
conversation has said the most recent and most specific thing.

## 4. Trigger

The cap would have largely missed its purpose without this part.

Compaction fired on `estimateMessagesTokens`, a `chars/4` heuristic. The first measurement
`/status` ever printed showed `10k` billed against `4 281` estimated: **under by 2.3x**. A
512k cap evaluated on that estimate lets roughly 1.2M real tokens through — above the window
it was meant to constrain.

Real usage is now captured per call, so the trigger uses it. The measurement describes the
prompt *as sent*, so it lags by a turn; it is therefore stored together with the message count
it covered, and only the messages appended since are estimated:

```
effective = max(estimate(all), measured + estimate(messages after measured.messageCount))
```

- The historical bulk becomes exact; only the newest turn is guessed.
- `max` keeps the pure estimate as a floor, so the trigger can never read lower than before.
- A shrinking message count means compaction or a history rewrite happened, which invalidates
  the measurement and falls back to the estimate.
- Turn one has no measurement and falls back to the estimate.

`trimToContextWindow` remains the hard fallback at the limit. The trigger is a soft gate and a
compaction failure must never block a run.

## Display

`/status` reports the effective window, its provenance, and both the cap and any override,
because every one of those can be the reason a number looks wrong:

```
context limit 512k (capped from 1,048,576, models.dev)
context limit 262k (default, not declared for this model)
context limit 1,048,576 (session override: full)
```

## Self-hosted models

Unrelated to the window, but resolved by the same pass over the model id.

GGUF K-quant tags in a model name are a reliable marker of a locally served model. Measured
against all 6 044 models in models.dev:

| pattern family | matches | billed |
|---|---|---|
| `Q4_K_M`, `Q3_K_M`, `IQ4_XS`, `GGUF` | 3 | **0** |
| `BF16`, `AWQ`, `GPTQ` | 6 | **6** |

So the narrow K-quant family is a zero-false-positive signal, and the broad precision-format
family is the opposite: nvidia, cloudflare and nano-gpt all resell models with `BF16` or `AWQ`
in the name at 0.05 to 0.50 USD/M. Only the narrow pattern is used.

Detected models render as `self-hosted` in the cost column rather than an amount. Reporting
`$0.00` would be a claim about a price; there is no marginal billing to report at all.

This is a better signal than the proxy header: LiteLLM returns
`x-litellm-response-cost: 0` for these models, but that zero means both "free" and "unknown
price" and cannot be told apart. The regex is positive evidence of self-hosting.

### What the quant tag cannot tell

It cannot give the context window. Quantisation is weight precision; the window is whatever
`--ctx-size` llama.cpp was launched with. `Q3_K_M` and `Q5_K_M` of the same model can carry
any window at all. Inferring 262 144 from the Qwen3.x family would be invention, and a 35B at
Q5_K_M is exactly the case where the full native window is unlikely to have been allocated.
