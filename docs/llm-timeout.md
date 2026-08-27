# Request timeout: per model, and what a wall we chose actually means

How long my-claw waits for a model that has not sent a single byte, why that number is now
declarable per model, and why our own timeout stopped being retried.

## Why this exists

The three transports each hardcoded their own wall:

| transport | wall | where it was |
|---|---|---|
| openai (home loop) | 120 000 ms | `provider.ts` |
| codex | 300 000 ms | `codex.ts` |
| anthropic | 600 000 ms | `anthropic.ts` |

120 s is generous for a hosted endpoint and short for a self-hosted one. A local llama.cpp
handed a 300k-token prompt spends minutes in prefill before the first token exists, and there
is no request to see during that time: from the client's side a slow prefill and a dead socket
look identical.

That number is a property of **the machine behind the model**, so it belongs on the model.

### Why not on the provider

A provider entry is not a machine. LiteLLM is a proxy: one `baseUrl` fronting several backends
with wildly different speeds. A ceiling declared there would be honest for one of its models and
a lie for the rest. Rejected for that reason, not for cost of implementation.

### Why not per session

The same argument, the other way round: prefill speed does not depend on which conversation
asked. A thread must not be able to make a model patient. There is no `timeoutOverride` on a
session and none is planned.

## The rule

```
timeoutMs = llm.models[].timeoutMs  ??  llm.timeoutMs  ??  the transport's own default
```

The same precedence as `limit.context` (docs/context-window.md), deliberately: a second shape
for "declared, else global, else default" would be a second thing to remember.

```json
{
  "llm": {
    "timeoutMs": 120000,
    "models": [
      { "id": "litellm/Qwen3.8-27B-Uncensored-YMQ-S", "timeoutMs": 900000 },
      { "id": "litellm/Qwen3.6-35B-A3B-uncensored-MTP-Q5_K_M", "timeoutMs": 0 }
    ]
  }
}
```

- **absent** — the transport default applies, which is what every install did before this existed.
- **a positive number** — that wall, in milliseconds.
- **`0`** — no timer of ours at all. The owner's Stop is then the only wall, and it still works:
  it travels on its own signal (`AbortSignal.any([controller.signal, signal])`) and is checked
  before anything else. On a socket that died without closing, the run waits until Stop is pressed.
  That is the trade, stated plainly, and it is why `0` is spelled "no limit (Stop only)" in the app
  rather than "disabled".

`timeoutFrom` rides on the resolved config next to the number, the same way `contextFrom` does, so
an error message and `/status` can say *why* the wall is what it is instead of only what it is.

## One definition, two behaviours

> The budget is the time allowed with **not one byte received**.

- **Streaming**: the timer is armed before the request leaves and re-armed on every line the stream
  produces, so it covers the connection, the prefill and the time to first token, then measures
  silence. A model still writing at twenty minutes under a two-minute budget is never cut: it has
  not been silent for two minutes.

  Per **line**, not per text token, and on all three transports. The two subscription backends
  spend their long minutes emitting things that are not answer text -- `ping`, `thinking_delta`,
  `reasoning_summary_text.delta` -- and a timer fed from the text alone would cut a model that had
  been talking the whole time. Both stream readers take a `keepAlive` and call it at the top of
  their read loop, which is the closest thing in the code to "a byte arrived".
- **Non-streaming**: nothing arrives before the end, so the whole call is one silence and the
  budget is the total wall. Same definition, no second rule.

This is why one field covers both paths. The alternative, two numbers, would ask the owner to
model the difference between prefill and inter-token silence to set a timeout.

## Our own timeout is not an incident

Three things followed from `AbortError` being indistinguishable from a network fault, and all
three made the new knob actively harmful. They are fixed here, and they are the reason this
document is longer than the feature.

### It was retried, so the budget was multiplied by three

`isTransientError` answered true for `AbortError`, and `LLM_RETRY_ATTEMPTS` is 3. A prefill killed
at 120 s was relaunched from zero, killed again, relaunched, killed: six minutes of compute thrown
away, and three times the load on the box that was already too slow to answer once. Setting
`timeoutMs: 900000` would have turned that into forty-five minutes.

**A timeout is now armed with a flag, and a call that tripped our own timer is not retried.** The
prompt has not changed and neither has the machine, so the second attempt is the first attempt with
a longer bill.

There is no "retry once if the budget was the default" exception. `docs/context-window.md` already
refused that shape for the cap ("one rule, no exceptions ladder") and the reasoning holds here: a
conditional retry is two behaviours to hold in mind for one event. The cost is real and is accepted:
a hosted endpoint that wedges once now fails the run instead of silently recovering on attempt two.
The error names the wall and its provenance so the next move is obvious.

### It opened the circuit breaker for the whole endpoint

`countsTowardBreaker` returns true for anything that is not a 4xx, so a timeout counted. Threshold
5, cooldown 60 s, keyed on `baseUrl`: two slow runs at three attempts each was six failures, and
**every model behind that proxy** was refused for a minute, including the fast ones.

A wall we chose is not evidence that the endpoint is down. Our own timeout no longer records a
circuit failure. A network-level abort still does.

### It reported a number that was not the one applied

`LLM request timed out after ${LLM_TIMEOUT_MS}ms` was written against the constant, so once the
budget became configurable the message would have named the default while another wall did the
cutting. It now carries the effective value and where it came from:

```
LLM request timed out after 900000ms (model)
LLM stream stalled for 120000ms (default)
Anthropic request timed out after 900000ms (global)
```

The Anthropic transport also announces the wall to the API in `x-stainless-timeout`, which the
real CLI sends. That header now carries the effective budget, and is omitted entirely when there
is no timer: announcing a wall we do not apply is worse than announcing none.

## Compaction inherits it, and from the right model

`compactSession` calls the non-streaming path, which is the one where the budget is the total wall,
on a prompt that is by construction the largest the conversation ever built. It is the call most
likely to hit a wall, so it must not be the one that ignores the setting.

It inherits for free: `resolveUtilityLlmConfig` returns a `ResolvedLlmConfig` produced by
`resolveLlmConfig`, and the field is filled there.

One nuance worth stating, because it is a choice and not an accident: **the budget belongs to the
model that receives the call**, not to the model the run started on. When the utility resolution
falls back to a native twin or to the global default, the fallback's own declaration applies. The
alternative, carrying the orchestrator's twenty minutes onto a hosted model that answers in three
seconds, would hide a wedged endpoint behind a wall borrowed from another machine.

## Surfaces

- **`/status`**, in the Model block: `request wall  900s (model)` / `120s (default)` /
  `none (Stop only)`. Knowing which wall is in force is the first question a hung run raises, and it
  should not require opening the settings. The line is resolved through the same chain a run uses,
  because the default depends on the transport the model lands on; a model that no longer resolves
  degrades the line to `unknown (model does not resolve)` rather than taking the report down, since
  `/status` is the screen opened precisely when something is broken.
- **The app**, in the model declaration form, in its own `request wall` block under the window: empty
  inherits, and the note under the field says what the typed value means (`cut after 900s without a
  single byte back`, or `no wall at all: only Stop ends a silent request` for `0`). The field is
  offered rather than hidden in `config.json`: an option implemented and then concealed is its own
  kind of debt, and the owner of this install is the one who runs the slow box.

  The placeholder does **not** show the resolved default. The three transport defaults are server
  constants, and a copy of them in the app is a copy that drifts: the day one moves, every phone
  that has not been updated states a wall that does not exist. `/status` is where the effective
  number is read, spelled by the side that owns it.
- **`models.upsert`** carries `timeoutMs` like it carries `context` and `output`. An older server
  ignores the field, an older app never sends it, and both keep working. The one thing the whole
  path has to protect is `0`: a truthiness check anywhere between the form and the file silently
  restores the default, which is why `config-edit` grew `nonNegativeInt` next to `positiveInt`
  instead of reusing it.

### Where it is not read

A `llm` block with neither `providers` nor `defaultProvider` is the legacy shape, and the resolver's
branch for it reads no model row at all (not `vision`, not `limit`, not this). A per-model timeout
there is ignored; `llm.timeoutMs` still applies. Not worth a special case: a `models` array is a
new-format notion in the first place.

## Refused

- **A retry budget of its own for timeouts.** See above: one rule.
- **A global "patience" mode.** It would be the provider-level knob wearing a hat.
- **Guessing the budget from the prompt size.** Tempting, and unmeasurable: prefill speed depends
  on the box, the quantisation, the KV cache state and what else is running on the GPU. A number the
  operator sets is the only honest source, which is the same conclusion `docs/context-window.md`
  reached for the window of a local model.
