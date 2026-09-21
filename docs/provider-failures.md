# A provider failure does not end the run

What happens when a model call dies for a reason that is not the request's fault, and why the run
waits rather than moving on.

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

## Two defects, and the fix for each

### 1. The status decided, and the body was not read

`isOutageClass` (`src/agent/dispatcher.ts`) classified a `403` as auth-or-permission, matched
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

- `tests/agent/dispatcher.test.ts` — the measured 403 is an outage and reroutes; a far-side fault
  waits on the configured schedule **on the same model** before any reroute; the schedule is spent
  once per run and the route takes over after it. The shared config in that file turns retries off,
  so the failover tests keep proving the failover without waiting thirty seconds for it.
- `tests/config.test.ts` — the default schedule, `enabled: false` beating a declared list, junk
  dropped.
- `tests/core/config-edit.test.ts` — off is written, on leaves nothing behind, a schedule survives.
- `tests/my-claw-app-adapter.test.ts` — the frame and the controller.
- App: `__tests__/AgentsSettings.test.tsx` — the switch sends `agents.retry.set`, the row reads the
  schedule the server resolved, and an older server draws no row.
