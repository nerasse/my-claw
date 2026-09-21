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

1. **The route's remaining candidates**, skipping the one that just failed, any marked unavailable
   before the run, and anything this run already tried. A candidate the resolver refuses is skipped
   rather than fatal.
2. **The tag's global default**, when the route says `fallbackToGlobalDefault`.
3. **The agent's configured default**, for a run that is not on a route -- and only when the run is
   not already there. A run on its default has no target, because the target would be the model
   that just failed; the schedule is all it gets, and the failure is then real.

One schedule per run (`llm.providerRetry`), then one visit per target. A chain that rearmed at every
attempt would be a loop.

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
  the schedule and nothing else. The failures there are `402` and `400` on purpose: a `503` would be
  retried three times by the provider layer, blurring every model sequence the tests assert.
- `tests/llm/outage.test.ts` — what is the provider's fault and what is ours.
- `tests/llm/provider-fallback.test.ts` — the order of the targets, and the case that must stay
  empty.
- `tests/agent/dispatcher.test.ts` — resolution and engine choice only now; the failure handling
  moved out of it, and so did its tests.
- `tests/config.test.ts` — the default schedule, `enabled: false` beating a declared list, junk
  dropped.
- `tests/core/config-edit.test.ts` — off is written, on leaves nothing behind, a schedule survives.
- `tests/my-claw-app-adapter.test.ts` — the frame and the controller.
- App: `__tests__/AgentsSettings.test.tsx` — the switch sends `agents.retry.set`, the row reads the
  schedule the server resolved, and an older server draws no row.
