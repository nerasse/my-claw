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

## A run can refuse to leave its model at all

The chain above is a best-effort policy: it answers the owner's question on whatever can answer it.
That is the right default for a chat and the wrong one for a task whose **model is part of the
requirement** -- an implementation pass that has to stay on GPT, a review that has to be done by the
model it vouches for, a benchmark measuring one endpoint.

Measured 2026-10-28: a research run pinned on `chatgpt-2` hit `usage_limit_reached`; the research
agent's configured default was a Cheap tag whose first candidate is DeepSeek, so the run continued
there and the `[fallback]` note announcing it arrived **after** the work was done. The parent
discarded the investigation, because evidence produced by a model it never approved is not evidence
about the model it asked for. Announcing an unauthorised fallback does not authorise it.

`SessionData.fallbackPolicy` is the switch, and it is a session field like `/effort` and `/cap`:

```ts
fallbackPolicy?: "forbid";   // absent = the inherited chain, which is what every run had before
```

- **Enforced where the decision is made** (`AgentBridge.callModel`, before
  `providerFallbackTargets` is even consulted), not after the fact. A policy read after the answer
  would be a warning, and a warning is what this replaced.
- **The failure travels with its provider.** `withFailureContext` stamps `provider` and `model` on
  the error, so a caller that is told "blocked" can still tell a spent account from an outage.
- **The wait schedule still runs.** A `forbid` run that hits a one-minute rate limit may still retry
  the *same* model -- that is not a fallback. Only leaving the model is refused.
- **It is per invocation by default.** `send` writes it run-scoped unless the caller asked for
  `scope: "session"`, and a run-scoped setting is put back before the session is persisted: the run
  rewrites `modelOverride` with what it resolved, so restoring afterwards is what keeps a one-off
  account choice from becoming the agent's standing one.

## A blocked run reports itself, in fields

`String(err)` was the whole answer a parent got. It had to read prose to choose between waiting,
changing account and giving up, and it had no way at all to know whether the run had already
done something. `blockedReportOf` (`src/subagents/blocked.ts`) answers in fields:

```json
{ "status": "blocked", "agentId": "subagent/x-1", "reason": "quota_exhausted",
  "requested": { "model": "gptacct/gpt-6.1-sol", "provider": "gptacct" },
  "partialWork": "possible", "historyPreserved": true, "resumable": true,
  "retry": { "eligibleAt": "2026-10-29T08:47:12.000Z", "source": "provider_hint" },
  "nextActions": ["resume_with_allowed_config", "wait", "resume", "inspect"] }
```

- **`reason`** comes from `classifyProviderFailure` (`src/llm/outage.ts`), which names what the
  predicates above already knew: `quota_exhausted`, `rate_limited`, `auth`, `transport`,
  `invalid_request`, `policy_refusal`, `capability`. Two of those call for opposite decisions and
  used to be the same string.
- **`partialWork`** is `possible` once a tool entry settled past the last user turn, and `unknown`
  otherwise -- **never `none`**. A call cut off mid-flight settles no entry, so an empty log does not
  prove nothing happened, and a parent told "nothing happened" is a parent that redoes work already
  done.
- **`retry.eligibleAt`** comes from the provider's own fields, lifted off the payload by the
  transports (`resetAtMs`, `resetInSeconds`, `Retry-After`) rather than parsed out of a sentence a
  gateway may have rewritten. A provider that names no time yields `source: "none"`, never a
  guessed hour.
- The same text also carries the report as one `blocked: {...}` line, so a parent that wants the
  fields does not have to parse prose, and a parent that just reads gets the sentence.

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

## A stream that dies mid-answer

A provider can accept the request, start streaming, and then announce a failure from inside the
stream. That is not a verdict on the request: nothing about it changed between the first byte and
the last one. Before 2026-11-05 the Codex transport turned every such event into a fatal error, and
read its code from the root of the event while the backend nests it under `error`:

```text
Codex stream error : unknown          # 34 minutes, 26 tool calls, run dead
```

The reference client (`openai/codex`) does three things this install now does as well:

- **The code is read wherever it was put**: `error.code`, `error.error.code`, `response.error.code`.
- **An unknown code is retryable**, not terminal (`codex-api/src/sse/responses_error.rs` maps it to
  `ApiError::Retryable`); only the codes it recognises are verdicts.
- **A stream that ends without `response.completed`** is retried too, re-sending the request from
  the top.

`CodexStreamError` (`src/llm/codex.ts`) classifies the payload into the vocabularies this install
already acts on: a spent plan becomes a `429` quota error (one request, then the fallback), a rate
limit is replayed with the server's own `retry_after`, a `context_length_exceeded` stays an overflow
for the compactor to recover, a policy code keeps its words, and anything unrecognised is an
outage-class transport fault: replayed up to three times, then reroutable.

Replaying after the first visible word is only safe when the channel can take that word back, so the
sink carries `onRestart` (`src/agent/backend.ts`). The app implements it by sending an empty `replay`
delta, which replaces the bubble instead of appending to it, and the bridge re-opens its "this call
already wrote something, do not reroute" gate from the same callback. A channel without the hook
keeps the old rule: no replay once something is on screen, because a retry nobody can erase would
print the answer twice.

A stream failure does not count toward the circuit breaker (`isStreamFault`): the breaker is keyed on
`baseUrl`, and every subscription in this install shares one, so five dead streams on one account
would darken the other two.

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

- `tests/llm/codex.test.ts` — an unnamed stream error is replayed instead of ending the run; a
  replay after visible text calls `onRestart` first; without that hook it is not replayed at all; a
  plan limit and a context overflow announced mid-stream keep their own meaning and cost one
  request.
- `tests/my-claw-app-stream.test.ts` — a replayed call replaces the bubble rather than adding to
  it, its thinking is taken back with it, and a sealed bubble keeps the tool card that really ran.
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
