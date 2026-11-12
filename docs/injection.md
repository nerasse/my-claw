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

### The queue is the mailbox, and the queue merges

A message that cannot be delivered yet waits in one place whatever is holding the session: a run in
flight, a session already claimed by the message ahead of it, or a `/compact` still writing. That place
is the run's mailbox, and whichever run is next takes **everything in it at its first iteration
boundary** -- one LLM call carrying all of them, each as its own user turn and its own bubble. Several
messages waiting means one delivery, not one run each.

The predicate is the mailbox and not "is a run registered". The session claims its mailbox when it takes
the lock, before its run exists, so a message that lands in that window joins it; and `startRoot` keeps a
mailbox the session already claimed instead of replacing it -- replacing it dropped exactly those
messages.

Measured 2026-09-21, thread `3fad6e60`: a `/compact` at 19:27:28, two voice notes at 19:28:16 and
19:28:37. The first started a run when the hold released at 19:31:52; the second waited for that whole
run and took its own turn at 19:48:47 -- twenty minutes, two runs, two answers. The owner:
"tant qu'il y a des items en queue on va pas envoyer plusieurs fois à chacun son tour".

The `/compact` hold itself is untouched: a run must not race the summarizer rewriting the transcript it
would resume. What waits for it now joins the next run instead of queueing behind it.

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

### The entry goes on the log at the drain, where the model reads it

An injected message's `user` entry is written at the drain -- the iteration boundary, once the tool
round in flight has its results -- by `injectUserTurn`, the same call that pushes it to the prompt.
Three surfaces take that one position:

- the **prompt**: a user message cannot sit between an assistant's `tool_calls` and their results,
  so the boundary is the earliest place it is legal;
- the **app**, live: a parked send holds the bottom of the thread until its ack (fired at the
  drain), and every row the run emits meanwhile is inserted above it (`insertionIndex` in the
  app's `chat.ts`);
- the **log**, which is what a reopened thread replays.

From 2026-09-21 to 2026-09-22 the log disagreed (9aacf30): the entry was written the moment the turn
in flight came back, above that turn's rows, on the reasoning that the turn was the message's
reaction. That held for one case -- a voice answer that cancels a pending question, whose reaction
turn started after the send -- and was wrong for every other: a turn that started before the
message and merely came back after it. Measured on thread `fbe927c6`, 2026-09-22 23:04: a voice note
sent while the model was writing "Compris..." and calling two `bash` was drawn below those two
cards live, and above the phase on reload (`seq 30569` user, `30570` phase). The owner's decision:
one rule everywhere, the drain.

What that costs is the question case: the run's reaction to a cancel ("The user cancelled the
questions") sits above the voice that cancelled it, in live and on reload alike. The alternative
-- a causal rule, the bubble before the first turn started after the send -- needs the server to
tell the app where the bubble goes and the bubble to jump when the turn comes back; not taken.

The entry carries what the trigger turn's does: its images, its location, and its `transcripts`
(`preprocessor.transcriptsOf`). The injected path used to drop the transcripts, and a voice note
sent mid-run came back from a reload as a bare waveform (`seq 30569`, same thread).

A bubble is written once: `injectUserTurn` skips an id the log already holds (`Log.append` throws on
a duplicate rather than writing a second one), which is what covers a run that force-closes and
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

### A message the run never read is never lost

The mailbox has two halves, and a stop treats them differently since 2026-11-12.

A **pending** message was never read: the run did not reach a turn boundary after it arrived, so it
is not part of anything the owner stopped. It is rerouted to a run of its own (`RerouteSignal`,
turned into a fresh routing by `routeWithReroute`), on an abort exactly like on an error or a forced
close. It used to be killed with the run, which is the "message sent around Stop goes nowhere" bug:
the bubble stayed on screen with nothing under it and the owner typed it again.

A **claimed** message was drained into the run and answered in it, so the stop does interrupt it:
its outcome is the run's, and it learns the abort.

The distinction is the drain, not the stop. `settleMailbox` reads it off `claimed` versus `pending`,
so no caller has to decide which case it is in.

A message typed **after** the stop never enters the dying run at all: the mailbox was closed for its
wind-down (see below), so it opens a run of its own directly.

The app's two surfaces agree through the run's own life: `chat.run.end` (reason `aborted`) lifts every
queued badge for the thread, matching the journal's `close` dropping the parked sends, so a badge is
never replayed for a run that will not read it. The rerouted message's run then answers normally.

### A stop closes the mailbox for its wind-down

A stopped run has no next boundary, and `settleMailbox` rejects whatever it never read. So a message
typed right after Stop used to be parked in a run that was already aborting, rejected by that run's
abort, and never run at all: the bubble said "queued for the next turn" and nothing came, and the
owner typed it again (2026-10-25). `stop()` now marks the mailbox not-accepting the moment the abort
lands, so the message waits for the session lock and opens a run of its own -- which is what sending
it meant. `startRoot` reopens the mailbox for that run, so the messages after it fold into it
normally, and nothing is left refusing injections for the rest of the process.

The mailbox is not deleted at the stop: its pending items are still owed their rejection, and dropping
it would leave their promises unsettled.

The line is drawn by the drain, not by the stop: a message parked **before** the stop but never read
is rerouted, not killed. See "A message the run never read is never lost" above -- this section only
concerns arrivals *after* the stop.

The app's two surfaces agreed too late, which is the other half of the same report. The live journal
kept a parked send until the run drained it, and a run that dies never does -- so `close` now drops
the thread's parked sends with the journal, matching the `chat.run.end` that already lifts every queued
mark. Without that, the badge came back on the next sync (the replay re-sent `chat.send.queued`) and
stayed until a reload replaced the thread.

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
  `peekInjections`, `drainInjections`, `drainOrClose`, `settleMailbox`, and the `stop` that closes it
  for the wind-down) and `RerouteSignal`.
- `src/channels/my-claw-app/live-turn.ts` -- `holdQueued`/`releaseQueued`, dropped with the journal
  on `close` so a run that dies does not replay a badge nothing will lift.
- `src/core/router.ts` -- enqueue branch in `route`, `settleMailbox` at the three run exits.
- `src/agent/bridge.ts` -- drains at the iteration boundary and the final-answer point,
  `recordInjectedEntries` at the turn's return, `injectUserTurn`.
- `src/index.ts` -- `onTurnSwitch` wiring (mutable `active` streamer) + `RerouteSignal` reroute.
