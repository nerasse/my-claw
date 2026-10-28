# A provider failure does not end the run

What happens when a model call dies for a reason that is not the request's fault: the run waits,
then finishes on another provider -- and it does so **where the call is made**, so a sub-agent gets
the same treatment as the conversation, and a run that has already worked does not start over.

## The failure this was written for

Measured 2026-09-20, thread `bc80046f-ce0c-45fa-af81-fe52ea7dffd1`:

```
LLM stream request failed: HTTP 403 — Error from provider (Console Go):
Upstream request failed: [server_error] Upstream response was not valid JSON
```

The endpoint is the OpenCode Go lane (`https://opencode.ai/zen/go/v1`). The 403 came from the
gateway, and the body says, in its own words, that **its** upstream answered with something it
could not parse. Nothing about the request is the subject of that sentence. `anomalyco/opencode#40194`
carries the same string, so it is an upstream incident rather than anything we send.

It killed a ten-minute run that had made twenty-six tool calls, while a healthy second route
candidate (`anthropic/claude-opus-5`) sat unused. Both failures in that thread — 19:02 and 19:12 UTC
— died the same way.

## The second failure this was written for

Measured 2026-09-21, thread `3fad6e60-53a3-4fd7-90de-07df412ce32d`, pass 14 of a job search. One
sub-agent of three died on its ninth call:

```
LLM stream request failed: HTTP 400 — Error from provider (Console Go):
Upstream request failed: [invalid_request_error] Content Exists Risk
```

Its eight tool calls had succeeded (two reads, six fetches of aggregator sites). The parent retried
the pass three times, on three other models, and hit three other walls: `402` from OpenRouter
("you requested up to 131072 tokens, but can only afford 54608"), a `400` naming a shape we sent
wrong (`messages[0].content.str` wants a string, we sent a parts array), and the same moderation
refusal again. It then gave up on the volet and did the work itself, which is what a pass costs when
the fallback does not exist: 48 calls, 9.0M tokens, ~$0.21, after a "stop" nobody asked for.

Two things were missing, and both are about *where* the failure was handled.

### The handling lived one layer too high

It sat in `BackendDispatcher.runWithFallback` (`src/agent/dispatcher.ts`), which serves routed
messages only. Two consequences, both measured:

- **A sub-agent never saw it.** `SubAgentRunner` builds its own `AgentBridge` and calls it directly
  (`src/subagents/runner.ts`), so a child had the provider's own three attempts and nothing else.
  The child above died with healthy providers sitting unused.
- **A run that had already worked could not use it.** The dispatcher's fallback *replays* the run
  from its first token, which is only safe before anything was written: it guards on
  `anyOutputStarted` and, past that point, a failure was final. A child on its ninth call is exactly
  past that point -- and replaying it would redo every tool it ran, side effects included.

The handling now lives in the bridge, where the call is made (`callModel`,
`src/agent/bridge.ts`), and it **never replays**: the run's messages, its tool results and its log
are intact, so a failure between two calls costs the wait and nothing else. The run adopts whichever
target answers -- its context window, its vision, its usage rows and its cache key follow from
there, for every turn that is left.

What is *not* reroutable is a failure **after the failing call wrote something**: a token or a
reasoning delta is text the owner can see, and retrying it on another provider would say it twice.
That is read per attempt, not per run, which is why the old `anyOutputStarted` guard is gone: a run
that has answered three turns may still fall back on the fourth call.

### 2. The status decided, and the body was not read

`isOutageClass` classified a `403` as auth-or-permission, matched
against the message text. The message above matches none of those words, so the failure was read as
a deliberate refusal and thrown. Retry (`src/llm/retry.ts`) did not cover 403 either, so nothing
tried again.

The rule now, and it is the rule that was already written at the top of that file — a status is
retryable because of what it means:

```ts
if (UPSTREAM_FAULT.test(message)) return true;
```

`UPSTREAM_FAULT` reads the body for a far-side marker (`[server_error]`, "upstream response was not
valid JSON", "upstream request failed", "bad gateway", "invalid upstream", "upstream error/failure/
timeout"). A gateway has no status of its own for "my upstream broke", so it reaches for whatever
its edge returns; the message is the evidence and the status is an accident of that edge. A genuine
403 (bad key, forbidden model) carries no such marker and stays fatal, which the existing tests pin.

### 2. There was nowhere to wait

The route failover moves to the next candidate immediately. On a lane having a bad minute that is
the expensive answer twice over: the next candidate is a different model at a different price, and
the prompt cache this conversation has been building at that endpoint is thrown away.

The run now owes an outage-class failure a schedule, `llm.providerRetry`:

```json
{ "providerRetry": { "enabled": true, "delaysMs": [30000, 60000, 120000] } }
```

- **On by default.** Absent means the three waits above, resolved by `providerRetryDelays`
  (`src/core/config.ts`), which drops anything that is not a positive finite number — junk is not
  something to wait on.
- **The same target first**, then the route failover, then the failure. Deliberately in that order:
  waiting is the recovery a flapping lane actually needs, and switching models is the fallback when
  waiting did not help.
- **One schedule per run.** A budget that rearmed at every candidate would be a loop.
- **Bounded and abortable.** `sleep(ms, signal)` from `src/core/aborted.ts`, so `/stop` interrupts a
  two-minute wait instead of being a no-op for it.
- Each wait is logged (`provider retry scheduled`) and announced in the chat as
  `[retry] <model> failed on the provider's side (…); trying again in 30s.`, so the pause is
  explained rather than mysterious. The note is returned with the run's text as well, so the live
  bubble and the reopened thread say the same thing.

`enabled: false` is the whole feature off: the failure goes straight to the route failover, which is
exactly what every release before this one did. Nothing settles that per agent — waiting on a broken
provider is a property of the provider, not of the agent talking to it.

## Where the run goes: the owner's own configuration

There is no new setting. A `tag:` with a `route` **is** a chain, and `providerFallbackTargets`
(`src/llm/provider-fallback.ts`) reads it in order:

1. **The route the run carries**, then the route its stored `tag:` pick names, when the run arrived
   without one (see below). Its remaining candidates come first, skipping the one that just failed,
   any marked unavailable before the run, and anything this run already tried. A candidate the
   resolver refuses is skipped rather than fatal.
2. **The tag's global default**, when the route says `fallbackToGlobalDefault`, unless the route
   already tried it.
3. **The agent's configured default**, for a run that is not on a route -- and only when the run is
   not already there. When that default is itself a tag with a route (`general` on `tag:Medium`),
   the whole route is walked, then its global default: a sub-agent spawned on a model of its own
   used to get the route's first candidate only, and died when that one failed too while the rest
   of the route sat unused (the veille volet of 2026-09-29: mimo's quota, then a deepseek timeout,
   opus never tried). A run on its default has no target, because the target would be the model
   that just failed; the schedule is all it gets, and the failure is then real.

### The route does not always travel with the run

`RunModel.route` is what step 1 walks, and two of the three doors into the bridge lose it:

- **The dispatcher** hands the bridge the *concrete* winner as a forced model
  (`resolved.route ? resolved.model : undefined`). A forced model resolves to no tag, so the run
  arrives with no route at all.
- **A sub-agent** hands the bridge a `ResolvedLlmConfig`, and the bridge skips resolution entirely
  (`this.llmOverride ? undefined : resolveRunModel(...)`).

A run with no route fell through to step 3 and walked the *agent's* default. Measured 2026-10-27 on
`tag:CubeFlowSol` -- two ChatGPT subscriptions, `fallbackToGlobalDefault` absent: `chatgpt-2` hit
its plan limit and the run answered on `Medium route candidate 1` (`synthetic`), while `chatgpt-3`
answered fine ninety seconds later. Eight runs that day, every one of them out of a route it had
never left.

The fix is not to thread the route through every backend signature: `session.modelOverride` still
holds `tag:<name>`, and the bridge passes it to `providerFallbackTargets` as `tagRef`. The walk then
uses `routeOfTagRef`, which only speaks when the run is **on** one of that tag's candidates -- a
tag the preflight already fell through to the global default must not be walked, or the run would
retry a model the resolver had judged unavailable. A route that did arrive always wins over the
reference: it knows the preflight's verdicts and where the effort and ceiling came from.

One schedule per run (`llm.providerRetry`), then one visit per target. A chain that rearmed at every
attempt would be a loop.

A **spent quota** (`isQuotaSpent`: `quota exhausted`, `insufficient_quota`, `out of credits`,
`usage_limit_reached`, `usage limit exceeded`, ... on a 402 or 429) is never waited for, by the run
or by the transport's own backoff: nothing inside a run refills it. It goes straight to the next
target. It cost each volet of that veille four minutes of waits before it moved on.

The phrase list is the providers' own words, not the ones that sound right. Measured 2026-10-27,
both of these were read as an ordinary 429 and paid three transport retries plus 30 s, 60 s and
120 s of waits -- twelve requests and 210 seconds for one wall:

```
{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":...}}
Go usage limit exceeded
```

A **rate limit** stays out on purpose: it clears on its own, which is exactly what a wait is for.
The distinction is the noun -- a *limit* of the plan, not a *rate*.

## What counts as the provider's own failure

`src/llm/outage.ts`, one answer for every path that talks to a model:

- **Outage-class**: `402 408 425 429 500-504 520-524 529`, a network fault, a 401 (a key problem on
  *that* provider), a 404 naming a model or endpoint that no longer exists, and the `[server_error]`
  family a gateway returns when its own upstream breaks.
- **A policy refusal**: a 4xx whose body says the provider will not carry this content
  (`Content Exists Risk`, `content policy`, `moderation`, `flagged`, ...). Another provider's policy
  differs and the same prompt usually goes through.
- **Not included**: a `400` naming a shape we sent wrong. That is our bug, and rerouting it would
  hide it behind a model that happens to tolerate the shape -- measured the same evening, when
  `glm-5.3` refused the parts array our system prompt was sent as.

## A spent quota never counts toward the circuit breaker

`countsTowardBreaker` (`src/llm/provider.ts`) refuses a quota for the same reason it refuses a
malformed request: neither is evidence that the endpoint is down. It is worse than the malformed
case, because the breaker is keyed on `baseUrl` -- and the subscriptions share one.

Measured 2026-10-27: `chatgpt-2`'s five `usage_limit_reached` refusals opened the breaker on
`https://chatgpt.com/backend-api` at 22:45:11. That endpoint is what `chatgpt`, `chatgpt-2` and
`chatgpt-3` all point at, so the exhausted plan took the other two accounts with it. `chatgpt-3`
answered perfectly at 22:46:36. The plan is out of money; the endpoint is fine.

A rate limit still counts: there the endpoint really is struggling, and a cooldown is what protects
it.

## The switch, on the phone

`agents.config.result` carries `retry: { enabled, delaysMs }`, already resolved, so the app renders
the schedule and holds no copy of the default to drift from. The row sits at the top of the
**defaults** on the Agents page: one tap, no confirmation, and the server answers with the whole
snapshot like every other mutation on that page. Absent on a server that predates it, and the row is
not drawn rather than drawn lying.

Written by `setProviderRetry` (`src/core/config-edit.ts`), which is also where the shape of the file
is decided:

- **off is written** as `{"enabled": false}`, because "off" is a decision the owner made and the
  default is on — deleting the section would turn retries back on at the next reload.
- **on is written by removing the key**: a config that runs the default does not carry a section
  restating it. A custom `delaysMs` survives the switch being turned back on.

## The failure is recorded

`recordApiCall` ran only once a response landed, so a provider outage left no trace at all:
`analytics.db` answered "0 errors today" through an evening of dead runs while two bubbles said
otherwise. A call that never answered is still a call — same row as a success, zeroed, with the
error text — so an outage is countable and its cost is visible.

## Tests

- `tests/agent/bridge-provider-fallback.test.ts` — the run waits then finishes on the configured
  default; a failure **between two calls** keeps the work it already did (the tool ran once, and the
  run continued from its result); a policy refusal reroutes; a `400` naming our own shape does not;
  a failure after the call wrote something does not either; a route walks its remaining candidates
  then the tag's global default; the owner's turn is written once; a run already on its default gets
  the schedule and nothing else; **a run forced onto its tag's first candidate still walks that tag**
  (the dispatcher's hand-off, measured 2026-10-27); **a spent plan limit gets one request, no wait,
  and the next account**. The failures there are `402`, `400` and a quota-shaped `429` on purpose: a
  `503` would be retried three times by the provider layer, blurring every model sequence the tests
  assert.
- `tests/llm/outage.test.ts` — what is the provider's fault and what is ours, and the quota phrases
  the providers actually send (`usage_limit_reached`, `Go usage limit exceeded`) against the rate
  limit that must stay waitable.
- `tests/llm/provider-fallback.test.ts` — the order of the targets, the case that must stay empty,
  and the tag reference that stands in when the route did not travel with the run.
- `tests/llm/codex.test.ts` / `tests/llm/anthropic-provider-generic.test.ts` — a spent plan limit
  gets one request from each transport; a rate limit keeps its three.
- `tests/llm/provider-retry.test.ts` — a quota does not count toward the breaker, a rate limit does.
- `tests/agent/dispatcher.test.ts` — resolution and engine choice only now; the failure handling
  moved out of it, and so did its tests.
- `tests/config.test.ts` — the default schedule, `enabled: false` beating a declared list, junk
  dropped.
- `tests/core/config-edit.test.ts` — off is written, on leaves nothing behind, a schedule survives.
- `tests/my-claw-app-adapter.test.ts` — the frame and the controller.
- App: `__tests__/AgentsSettings.test.tsx` — the switch sends `agents.retry.set`, the row reads the
  schedule the server resolved, and an older server draws no row.
