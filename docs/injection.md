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
its own answer. The injected message's own (unused) streamer is a harmless no-op.

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
  `drainInjections`, `drainOrClose`, `settleMailbox`) and `RerouteSignal`.
- `src/core/router.ts` -- enqueue branch in `route`, `settleMailbox` at the three run exits.
- `src/agent/bridge.ts` -- drains at the iteration boundary and the final-answer point, `injectUserTurn`.
- `src/index.ts` -- `onTurnSwitch` wiring (mutable `active` streamer) + `RerouteSignal` reroute.
