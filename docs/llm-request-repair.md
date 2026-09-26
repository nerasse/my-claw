# What a 400 is asking us to change

An endpoint that names the field it will not take is not an endpoint that is down, and it is not
a request we sent wrong either. It is a fact about *that model*, said out loud, in a message we
can read. This is the one place that reads it.

## The two failures that made it

Both on 2026-09-26, both on `opencode_go/deepseek-v4.1-flash`, both ending a run with everything
it had built still on the floor:

```
LLM stream request failed: HTTP 400 — Upstream request failed: The parameter cache_control is
not supported for the requested model.
```

```
LLM stream request failed: HTTP 400 — Upstream request failed: [invalid_request_error]
The `reasoning_content` in the thinking mode must be passed back to the API.
```

The first took a run of **23 tool calls and four minutes**. The second took one of **62 tool calls
and twenty-nine minutes**. Neither was retried, and neither could be: `isRetryableStatus` refuses
every 4xx but 429, on purpose (a 4xx is request-specific, and it must not count toward the circuit
breaker). The same request, sent again, buys the same 400.

What was missing was not a retry. It was a **repair**.

Before this, the only refusal we could act on was one, hard-coded where the call was made: a 400
naming `messages[N].content.str`, which a strict upstream answers to the parts form our cache
hints produce. That single case proved the shape of the answer and was never generalised.

## The table

`src/llm/request-repair.ts` holds every recognised refusal as data. The call site asks it a
question; it holds no knowledge of its own.

| `id` | What it matches | What it changes |
|---|---|---|
| `drop-refused-parameter` | `parameter X is not supported` | Drops `X`, or turns the cache dialect off when `X` is a cache parameter |
| `plain-content` | `content.str`, `should be a valid string`, `messages[N].content` | Turns the cache hints off entirely |
| `replay-reasoning` | `reasoning_content` + `must be passed back` / `required` | Replays reasoning on turns produced by another model |

Three properties keep it from becoming a burden:

- **The discriminant is short and stable.** Never the whole sentence: the parameter name the
  endpoint quoted, or the field it demands. A provider rewording its message does not break a
  repair, it only makes it unrecognised, which is the safe direction.
- **The default is to do nothing.** An unknown 400 is thrown exactly as it was before. Nothing is
  guessed, and no error is ever swallowed.
- **A repair is learned, not repeated.** Once an endpoint has refused a shape, the repaired request
  is what this process sends it from then on, so the 400 is paid once, not once per call.

What a repair may move is one type, `RepairOptions`: whether the request carries cache
breakpoints, whether it carries a `prompt_cache_key`, whether it replays reasoning, and which
top-level fields to drop. A repair that changes none of them returns `false`, and the call is
**not** replayed: a request that failed unchanged would fail unchanged again.

## The other half: the dialect decides the form

`cache_control` is Anthropic's spelling of a cache hint. `prompt_cache_key` is OpenAI's. Neither
means anything to an engine that speaks neither, and one of them is refused outright.

`cache-policy.ts` already derived the dialect from the model id, and its own notes said a
per-provider flag cannot express it. Nothing consulted it when the breakpoints were built: a
provider with `promptCache: true` got `cache_control` on every model it served, DeepSeek and GLM
included. That is the first failure above, waiting to happen.

Now the opt-in is a **right** ("this endpoint tolerates hint fields") and the dialect decides the
**form**. Claude models keep `cache_control`; OpenAI-family models keep `prompt_cache_key`;
everything else is sent neither. The production families that were at 91-97% cache-read are
therefore untouched: their dialect is `anthropic`, so their breakpoints stay.

## Reasoning belongs to the turn, not to the model

`toWireMessage` only replayed a turn's reasoning when the turn came from the very model being
called, on the same transport. That is wrong: the field is state the turn *produced*, and a
thinking endpoint being shown that turn demands it back whoever made it.

So a repair can set `forceReasoning`, and the field is replayed from the log regardless of which
model produced it. The log already carries it (`providerMeta`, `docs/reasoning-replay.md`), so this
is a read, not a new store.

## And the run survives

A repair is attempted once. If it changes nothing, or if the replayed call fails anyway, the
provider marks the error with the capability it refused, and `isCapabilityRefusal` makes it worth
another provider:

- **No wait.** A wait cannot teach a model a capability. The chain goes straight to its next
  target, which is the same schedule that already covers an outage and a policy refusal.
- **A note the reader sees**, naming what the model could not do, instead of the opaque
  "[fallback] ... is unavailable".
- **A named log line** per repair (`LLM request repaired`, with the repair id, the model and the
  first 200 characters of what the endpoint said), so a 400 stops being a mystery in the journal.

What is deliberately *not* reroutable: a malformed request. `outage.ts` says it in as many words,
and a 400 the table does not recognise keeps that path. Hiding our own bug behind a model that
happens to tolerate it is how a bug becomes permanent.

## Testing it

`tests/llm/request-repair.test.ts` holds one test per case, each written to fail without its fix:

- a DeepSeek model is sent no `cache_control`, whatever the provider opted into;
- a Claude model still carries its breakpoints (no cache regression);
- an OpenAI model gets the key and not the other dialect's field;
- a refusal naming a parameter is replayed without it, and the run continues;
- the **next** call to that endpoint does not pay the 400 again;
- a thinking endpoint gets the reasoning of a turn produced by another model on the replay;
- an unknown 400 is thrown as itself, with no replay;
- a refusal whose repair would change nothing does not loop;
- the streaming path repairs the same way.

`tests/llm/prompt-cache.test.ts` and `tests/analytics/e2e-usage.test.ts` were rewritten where they
asserted the old behaviour by name; their intent is unchanged and each now states the rule that
holds.

`resetLearnedRepairs()` is the test seam, wired into `tests/setup-globals.ts` like every other
piece of module-level state. The memo is per process and never persisted: a compatibility fact
about a remote endpoint is not worth keeping across a boot.
