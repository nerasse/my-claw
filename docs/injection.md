# Mid-run message injection (steering)

## Why

A message arriving while a run is already in progress for the same session used to wait for the whole
run to finish (serialized behind it by `sessionLocks`). For a back-and-forth chat that feels dead: the
user adds a correction or a follow-up and the bot ignores it until it is completely done.

Injection lets that message join the **current** run at the next iteration boundary, so the **next LLM
call sees it** and the bot reacts -- without restarting or interrupting work already done.

## Decisions

### Steering, not interruption

The message is injected at the next loop iteration (after the tool round in flight finishes), never in
the middle of a tool. This is also the only point allowed by the OpenAI format: a `user` message cannot
sit between an `assistant` message with `tool_calls` and its `tool` results. Consequence: if a long tool
(browser, sub-agent, bash) is running, the injection waits for it -- accepted trade-off. Interrupting
mid-tool (abort+restart) was rejected: it would waste work and could re-fire side-effecting tools.

### Blocking promise = free, correct reactions

`router.route` for an injected message returns a promise that resolves only when the run finishes
addressing it. The adapter's existing reaction state machine (`received -> thinking -> done/error`,
typing, dedup commit) is driven by `await messageHandler(...)`, so it works unchanged: the message shows
"thinking" while the bot works and flips to "done" when the run ends. As a bonus, attachment cleanup
(deferred to the same `finally`) keeps an injected image/voice file alive long enough for the run to read
it -- a fire-and-return design would have deleted it too early.

### Output in its own threaded bubble (`onTurnSwitch`)

When the run starts addressing an injected message, the bridge calls `onTurnSwitch(message)`. The output
layer finalizes the current bubble and opens a fresh reply threaded to that message, so each message gets
its own answer. The injected message's own streamer is never used: the run paints in one it created
itself, under the same id.

That unused streamer was called a harmless no-op, and on the way out it was not. Every handler settles
its streamer when its `route` throws, and a stop makes all of them throw at once with the same error, so
one `/stop` sent an abort per folded message on top of the run's own. An abort for an id the app never
saw is drawn there as an empty bubble carrying the error text: the owner got `Stopped.` followed by
`Run aborted by user`, once per message he had sent during the run. A streamer that painted nothing and
has nothing to report is now silent, and a stop reports nothing -- `docs/my-claw-app-channel.md`, "The
failure journal".

### The entry goes on the log before the rows it caused

An injected message's `user` entry used to be written at the drain -- the iteration boundary, once
the tool round in flight had its results. That is right for the **prompt** (a user message cannot
sit between an assistant's `tool_calls` and their results) and wrong for the **log**, which is what
the owner reads: between the arrival and the next boundary the run can write rows of its own, and
when the message is what caused them the bubble lands underneath them.

Measured 2026-09-21, thread `4d5775e7`, answering a pending question by voice: the cancel lands at
06:31:35, the run's reaction turn -- a phase and a `bash` call -- is written at 06:31:52, and the
bubble at 06:31:52, behind it. `Log.append` gives every entry its `seq` in call order, the file
order is the display order, so the inversion is permanent and a reopened thread shows it too.

So the write is split from the push. `recordInjectedEntries` peeks the mailbox the moment the turn
in flight comes back and, before anything of that turn is recorded, puts the entry on the log;
`injectUserTurn` at the boundary then pushes to the prompt only, taking the text from what was
written so the channel's `transform:user:content` hook still runs exactly once. A bubble is written
once either way: the normal path skips an id the log already holds (`Log.append` throws on a
duplicate rather than writing a second one), which is also what covers a run that force-closes and
reroutes its message to a fresh run.

### Done reaction at run end

The injected message stays "thinking" until the whole run ends, then flips to "done". Simple and honest:
the bot is genuinely still working. On `/stop` or error the run aborts and pending injections reject
(error reaction).

### Lossless close (race + forced close)

`drainOrClose` closes the mailbox to new injections only when nothing is pending, atomically (no `await`
around it). A message that loses the race lands after the close and falls back to a normal new run --
never lost, never double-run. If a run is force-closed with an undrained injection (iteration budget
exhausted), that injection is rerouted to a fresh run via `RerouteSignal`.

### Scope and limits

- Per **session root** only: the mailbox is keyed by the root `sessionId`; sub-agents (depth > 0) never
  drain it, and a message can never inject across sessions or into a cron run.
- Hard cap `MAX_INJECTIONS_PER_RUN` (25): beyond it, messages fall back to queued runs (anti-runaway).
- Each injected user turn grants `injection.budgetBonus` extra iterations (default 8) -- it is a real new
  turn, not the model looping.
- Non-streaming mode has no `onTurnSwitch`; the injected answer folds into the run's final text delivered
  to the original message (degraded; streaming is the normal mode).
- Disable with `injection.enabled: false` -> falls back to the old `sessionLocks` queueing.

## Where

- `src/core/run-registry.ts` -- the per-session injection mailbox (`enqueueInjection`,
  `peekInjections`, `drainInjections`, `drainOrClose`, `settleMailbox`) and `RerouteSignal`.
- `src/core/router.ts` -- enqueue branch in `route`, `settleMailbox` at the three run exits.
- `src/agent/bridge.ts` -- drains at the iteration boundary and the final-answer point,
  `recordInjectedEntries` at the turn's return, `injectUserTurn`.
- `src/index.ts` -- `onTurnSwitch` wiring (mutable `active` streamer) + `RerouteSignal` reroute.
