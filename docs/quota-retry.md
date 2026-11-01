# Retry a run when the quota comes back

A run that dies on a spent quota leaves the conversation where it stopped. Continue is the manual
answer; this is the same answer, armed to fire at the second the provider said it would reset.

## The setting

Off by default, per conversation, in the 3-dot menu: **Retry when the quota returns**. It is a
setting, not a one-shot: once on, every quota wall in that conversation arms a wait until the owner
turns it off. The pill under the last run is where the wait shows, and where it can be cancelled
or fired now — cancelling is the same switch, said from where the owner is looking.

## The switch is a mutation, so it reads with `peek`

`meta.json` carries it, and the three mutations that write it (`setQuotaRetryEnabled`,
`armQuotaRetry`, `clearQuotaRetryPending`) go through `SessionManager.peek()`. That is not
incidental: `read()` deliberately leaves a session it had to load out of the cache, and `persist()`
writes the cache -- so a mutator on `read` answered the new value over the wire, stored nothing,
and had it overwritten by the stored one on the next sync. Every wall on a conversation that had
not been opened since the server booted hit that; the switch simply never stayed on. `read()` is
for the paths that only look.

## What arms a wait

A run that **failed** (not one that recovered on a fallback) with a quota-shaped error: status 402
or 429, or one of the quota texts `outage.ts` already knows. The error alone never decides the
reset, though — the usage endpoint does:

1. The bridge attaches `provider` and `model` to the error it throws, because a run that walked
   three fallbacks has no other record of which one it ended on.
2. `quotaFor(config, provider, { force: true })` reads the provider's own windows.
3. `quotaWaitFrom` takes the **earliest future reset among the windows at 100%**, plus a minute of
   slack. Earliest, not latest: a plan can be full on its 5-hour window and comfortable on its
   week, and waiting for the week would park the conversation for days over a bucket that refills
   tonight. If another window is blocking too, the next attempt fails the same way and re-arms on
   the new answer.
4. Nothing spent, or no reset published, or no source: no wait, and the failure stands with
   Continue.

This is what makes OpenCode Go waitable at all: its 429 body says nothing, its usage endpoint names
every reset. A plain per-minute 429 reads every window below full and arms nothing.

## A plan is several bars, and they reopen on different clocks

`kindOfWindow` classifies every window as `5h`, `day`, `week`, `month` or `other`, from the duration
when the provider publishes one (`windowSeconds`: Claude, Codex, OpenCode Go, Synthetic) and from the
id or label when it does not. The four periods are the ones plans actually use:

| Source | 5 h | Week | Month |
|---|---|---|---|
| `claude` | `session` | `weekly_all`, `weekly_scoped:<model>` | -- |
| `codex` | `18000` | `604800` | `2628000` when the plan has one |
| `opencode-go` | `rolling` | `weekly` | `monthly` |
| `synthetic` | `rollingFiveHourLimit` | `planWeeklyLimit` | -- |
| `openrouter` | -- | -- | -- (`key-limit` is a spend cap, not a period) |

The wait reasons about **which** bar is full, never about "the quota":

- `spentWindowOf` names the narrowest spent bar, because that is the one a single call hit. A plan
  at 100 % on its 5 h and 11 % on its week does not refuse for the week, and telling the reader the
  week is what blocked them is a bug in the message.
- `quotaWaitFrom` takes the earliest future reset among all spent bars, plus the buffer. A monthly
  wall waits a month, because that is when it opens.
- The whole spent set travels with the wait, labelled, so the pill can say which bars are full.

## A wall costs one request, not twelve

Two things used to burn requests on a bar that does not move, and both are now closed:

1. **The run's own schedule** (30 s, 60 s, 120 s). The bridge asks `quotaWallOf` before spending it:
   a confirmed wall skips the waits and moves to the next candidate at once.
2. **Each transport's three attempts.** They see a 429 before the bridge does, and they cannot await
   a probe at that instant. `ResolvedLlmConfig.isWall` is the predicate they await instead, and
   `wallConfig` (llm/quota/wall.ts) is the single place it is built -- the agent loop, the
   compaction summarizer and memory consolidation all go through it, because the last two call the
   transport directly and were paying the three attempts on every wall.

**The predicate forces its read.** The question is asked at the moment the 429 arrives, so a cached
reading must not answer it: `claude`'s TTL is five minutes, and on 2026-11-01 a reading taken while
the five-hour window was still open made the same 429 answer "not a wall" at 13:20 (three transport
attempts, 30 s then 60 s) and "wall" at 13:24, when the cache had expired. `quotaFor`'s
`blockedUntil` still applies, so a 429 from the usage endpoint itself is its own answer.

Measured 2026-10-31, career session on `claude-2`: `{"type":"rate_limit_error","message":"This
request would exceed your account's rate limit."}` — word for word what a per-minute burst says —
with the 5 h bar at 100 % and a reset twenty-two minutes out. Twelve requests and 210 seconds for
one wall, before the run moved at all.

## The switch outranks the fallback

A conversation with **Retry when the quota returns** on does not fall back when the oracle confirms
a wall: it stops, the adapter arms the wait, and the run resumes at the reset. A conversation
without it moves to the next candidate immediately — the other model answers now, and the note says
which bar was full.

The asymmetry is deliberate. Without the switch the run's job is to answer; with it the owner has
said the wall is what they want to wait for, and a silent fallback would look exactly like a run
that respected the setting.

## Which failures consult the oracle

`needsQuotaOracle` is the filter, because a probe is a request:

- **Already decisive, no probe**: `isQuotaSpent` phrases (`usage_limit_reached`, `quota exhausted`,
  `exceeded your subscription limits`), a 402, a balance phrase (`out of credits`).
- **Ambiguous, probe once**: any other 429 or quota-shaped failure — the bare `rate_limit_error`, a
  429 with no body, an unknown gateway.
- **Never**: anything that is not quota-shaped. An ordinary 500 keeps its backoff.

"Decisive" is only about the *verdict*, never about the window. A phrase that already says the plan
is spent is a wall with no probe, but it still has to name the bar, because that bar is what the
adapter arms a wait on. `quotaWallOf` therefore probes every wall whose provider publishes usage,
decisive phrase or not -- and skips the probe only when the provider has no source at all. Without
that, each provider whose refusal is explicit (Codex's `usage_limit_reached`, OpenCode Go's "Go
usage limit exceeded", Synthetic's subscription limits) moved to the next candidate on a wall the
conversation had asked to wait out: the switch did nothing on exactly the four providers it matters
for. Verified 2026-11-01 against the live bars of claude-2, chatgpt/-2/-3/-4, opencode_go and
synthetic.

Synthetic is the case where the wording lies: its refusal says "You've exceeded your subscription
**rate** limits", while `/quotas` answers with the plan's weekly bar at 100 % and the next 2 % tick
a couple of hours out. The text is read as a spent quota, so the run stops on the wall instead of
waiting 30 s, 60 s and 120 s on it and opening the endpoint's breaker for every model behind it.

## The wait

`pending: { at, attempts, windows, error }` lives in the session's own `meta.json`, so it survives
a restart and disappears with the conversation. The adapter keeps the armed conversations in
memory, reads them back at boot, and ticks every 30 s:

- due, no run on the session → `startContinue`, the exact function behind the Continue button;
- a run is going → skip, the next tick settles it;
- the run starts, ends well, is stopped, or the owner sends something → the wait is cancelled.

The set of armed waits is keyed by **session id**, the one handle every writer and reader shares:
`settleQuotaRetry` arms a conversation, the sub-agent runner arms a child, `listQuotaWaits` reads
them both back by session. It held `owner\0thread` for conversations once, which no lookup ever
produced -- the tick read no pending wait for that key, **deleted the entry**, and the retry never
fired. The pill's manual "retry now" was the only path that worked, which is exactly what the owner
reported on 2026-11-01: a wait armed for 22:30 was still sitting there at 03:00.

A retry that dies on the quota again arms the next one with `attempts + 1`. Eight attempts is the
guard against a provider that keeps saying no across resets; the wait itself has no ceiling,
because the owner chose the reset over a shorter schedule.

`session.quotaRetry.set` is the switch (turning it off cancels), `session.quotaRetry.now` fires the
wait immediately, and `session.quotaRetry.state` is pushed to every device when either changes.
`session.sync.result` carries the same state, because a push only ever reaches the windows that
were connected at that second.

Two ways that promise broke, both worth keeping in mind when touching either side:

- The store built `quotaRetry` on every page and the adapter dropped it when it composed the
  frame, so the field was in the type and in the doc and never on the wire. A page is not carried
  by constructing it: check the frame, not the object it came from.
- The app's conversation menu is composed once and opened from two places -- a drawer row and the
  chat header. It read the setting through the drawer's own selection, which is null for the
  header, and had no listing row to fall back on: the row drew `off` forever and every tap sent
  `enabled: true` again. Whatever composes a shared menu takes its subject as an argument.

## A sub-agent waits too

The wait used to belong to the app channel alone, because that is where the tick runs. A sub-agent
has no chat thread: it died on a wall, stayed `blocked` in the roster, and nothing ever resumed it.

The decision and the ownership are now separate, and that split is the whole design:

- **`decideQuotaWait`** (`src/llm/quota/arm.ts`) answers "should a wait be armed, and for when" and
  starts nothing. Both paths call it, so the app's pill and a child's roster entry cannot disagree
  about a reopening time or about the attempt ceiling.
- **The runner arms** (`SubAgentRunner.armQuotaWait`), in the `catch` that saw the failure. It
  writes the wait on the child's own `meta.json`, which is where a conversation keeps its own.
- **One tick fires both.** `listQuotaWaits` scans `sessions/subagent/` as well as the app threads,
  the set is keyed by session id, and `fireSubAgentQuotaRetry` routes a sub-agent to
  `resumeArmedWait` -- the same no-turn Continue, driven through the runner because a child has no
  chat thread of its own. The outcome is reported on the parent's roster, which is where the owner
  is looking.

What stays identical is what made the feature safe in the first place: `continuable` decides
whether there is anything to pick up, so a timer never makes a finished agent run again.

## The switch is the conversation's, at every depth

A sub-agent has no switch of its own, and nothing ever set one: the runner read
`session.quotaRetry.enabled` on the **child**, which was always absent, so a whole delegated tree
silently ignored a switch the owner had visibly turned on. `armQuotaWait` now walks to the root
(`rootSessionOf`) and reads the setting there. A child with the conversation's switch off arms
nothing, which is the same rule said the other way round.

The wait itself stays on the child's own session: a resumed child is its own run, and the
attempt ceiling has always been per session. What the root supplies is the decision, not the
bookkeeping -- copying the switch down would go stale the moment the owner turned it off while a
chain was running.

`tests/subagents/quota-switch-tree.test.ts` pins it: a child with no switch of its own arms off the
conversation's, two levels down reaches the same root, and the conversation's switch off still
arms nothing.

## One resume per tree per tick

Several sessions of one conversation can be waiting at the same second, and the tick resumed them
all in one pass. They then hit a provider that had only just reopened together, and the one that
lost that race re-armed the wall the first had just cleared: a tree came back from one wall
straight into the next.

The tick reads each wait's root (`rootOfSession`, the same `rootSessionOf` chain) and spends **one
resume per root per pass**; the siblings get the next tick, 30 s later. When the root is due it
goes first on its own: a root run replays the turn that spawned the children, and its own `spawn`
calls drive them from there, which is the chain rebuilding itself rather than being replayed.

The grouping needs no state: the root is a property of the session's own `invokedBy` chain, so a
restart regroups everything the same way, and a wait that moved to another conversation's tree is
regrouped with it.

`tests/subagents/quota-switch-tree.test.ts` pins it: two children of one conversation, both due,
are resumed one per tick and both eventually.

## Tests

`tests/llm/quota-retry.test.ts`: a spent window with a future reset arms at that second plus the
buffer; the earliest of several spent windows wins; a window at 98% does not arm; a past reset does
not; a balance-only answer does not.
`tests/subagents/quota-retry.test.ts`: a child with the switch off arms nothing; with it on, the
provider's published reset becomes the wait, on the child's own session, with the same buffer; the
attempt count climbs across walls; `resumeArmedWait` refuses a finished child and resumes an
unanswered one without adding a turn.
