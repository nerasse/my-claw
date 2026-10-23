# Retry a run when the quota comes back

A run that dies on a spent quota leaves the conversation where it stopped. Continue is the manual
answer; this is the same answer, armed to fire at the second the provider said it would reset.

## The setting

Off by default, per conversation, in the 3-dot menu: **Retry when the quota returns**. It is a
setting, not a one-shot: once on, every quota wall in that conversation arms a wait until the owner
turns it off. The pill under the last run is where the wait shows, and where it can be cancelled
or fired now — cancelling is the same switch, said from where the owner is looking.

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

## The wait

`pending: { at, attempts, windows, error }` lives in the session's own `meta.json`, so it survives
a restart and disappears with the conversation. The adapter keeps the armed conversations in
memory, reads them back at boot, and ticks every 30 s:

- due, no run on the session → `startContinue`, the exact function behind the Continue button;
- a run is going → skip, the next tick settles it;
- the run starts, ends well, is stopped, or the owner sends something → the wait is cancelled.

A retry that dies on the quota again arms the next one with `attempts + 1`. Eight attempts is the
guard against a provider that keeps saying no across resets; the wait itself has no ceiling,
because the owner chose the reset over a shorter schedule.

`session.quotaRetry.set` is the switch (turning it off cancels), `session.quotaRetry.now` fires the
wait immediately, and `session.quotaRetry.state` is pushed to every device when either changes.
`session.sync.result` carries the same state so a window that opens later shows it without asking.

## Tests

`tests/llm/quota-retry.test.ts`: a spent window with a future reset arms at that second plus the
buffer; the earliest of several spent windows wins; a window at 98% does not arm; a past reset does
not; a balance-only answer does not.
