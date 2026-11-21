# /stop -- Stopping a Run

## Why

A run can be long: many tool-calling iterations, sub-agents, a shell command that hangs. `/stop`
cancels the current session's run and every sub-agent it spawned (recursively), instantly and cleanly,
without affecting other sessions.

## Decisions

### One AbortController per session, one shared signal for the whole subtree

The router creates an `AbortController` per top-level session run (`runRegistry.startRoot`). The same
`signal` is threaded by reference into the LLM calls, the tools, and every sub-agent (`AgentBridge`
runs nested in-process and awaited). Aborting that one controller flips `signal.aborted` everywhere at
once, so every in-flight `fetch` (main + sub-agents + sub-sub-agents) rejects immediately.

There is no parent->child registry to walk: the shared signal *is* the cross-level link. This avoids the
class of bug where bookkeeping diverges from the real abort (a run marked "killed" while it keeps running).

The browser subagent runs its own loop (not an `AgentBridge`), so it takes the signal explicitly:
`delegate_browser_task` reads the injected `__signal` and passes it to `BrowserSubagent.run`, which
checks it at the top of each step, before each tool call, and hands it to `chatCompletion`.

### Scoped to the current session only

`runRegistry.stop(sessionId)` aborts only that session's controller. Each chat/thread has its own
controller; other sessions are untouched. The `/stop` command resolves the same deterministic
`sessionId` as the router, so it targets exactly the channel it was typed in.

### AbortedError is never swallowed

Every tool `try/catch` that would normally turn an error into a tool result calls `rethrowIfAborted`.
Otherwise a sub-agent's abort would be converted into "tool result: error" and the parent would keep
going. This is the key to making the stop actually stop. The LLM provider also treats an external abort
as terminal: no retry, no circuit-breaker trip.

### Nothing on the wind-down path may wait on the workspace

The abort is instant; the report is not. Between `agent run aborted` and the router's `run stopped
by user` the run walks its `finally`, and that block used to take a second full snapshot of the
workspace. Measured 2026-11-12: 12.0 s for the start capture + 9.3 s for the end one on a 34 GB
workspace, 26.6 s between the abort and the stop being reported on a real session. The snapshot is
taken for `/undo`, and the one at the end had no reader at all (`changesSince` recaptures the
workspace when the owner asks), so it was removed outright rather than merely moved off the path.

The start capture does not block the wind-down either, and since 2026-11-21 it does not block the
run's *start*: it is launched with the run and awaited before the first tool. Measured on `~/dev`
(31 depots, 11 GB): 0.6 s on an idle tree, 18.1 s after a build, 73 s with cold shadows, and 197.8 s
under disk pressure -- all of it used to sit between the router taking the message and the first
token. A run that calls no tool still records it, in the background.

`captureWorkspace` itself was the cost: a `readdir` + `stat` walk of every file to find untracked
ones past the size cap, 3.7 s on a 33k-file tree and 12 s on an 88k-file one, run once per depot.
It now asks git (`ls-files --others --exclude-standard`) and stats only what that returns: 0.32 s on
the same 33k-file workspace, 0.6 s warm on the 88k-file one. The shadow's `info/exclude` is derived
whole instead of appended, which also stops it growing an unbounded copy of itself.

### Kill the whole process group for `bash`

Shell commands run under `setsid` (own process group). On abort the group is killed
(`SIGTERM` then `SIGKILL`), so children and grandchildren die too -- no orphaned background processes.
`fetch` and `web_search` combine the run signal with their own timeout via `AbortSignal.any`.

### History is kept, dangling tool_calls are sealed

A stopped run is not rolled back: the user's message and any completed turns stay in history.
A run that dies of an error now ends the same way, and for the same reason (`session-log.md` §2.6):
it writes its `run_end` and leaves the cursor where it stands. If the abort
lands while an assistant `tool_calls` message has no matching tool result, `sealDanglingToolCalls` appends
a synthetic `[Stopped by user]` result so the next turn's API call stays valid.

### No interrupt-vs-/stop split

Codex/Hermes separate "interrupt current turn" from "/stop cleanup background work" because they have
backgrounded processes. MyClaw awaits every tool and sub-agent, so a single `/stop` is authoritative.

### The backoff waits on the signal, not on a timer

Every retry in the three transports sleeps through `sleep(ms, signal)`, which rejects with
`AbortedError` the moment the run is stopped. A bare `setTimeout` is what made `/stop` a no-op for
half a minute whenever a provider answered `429 Retry-After: 30`: the signal was aborted, the run
was marked stopped, and the process sat in a timer nothing could reach while the owner watched the
button do nothing. The check runs before the wait too, so a stop that landed a moment earlier does
not buy one more delay.

### One stop per cycle

The stop is not a boolean. `runRegistry.stop(sessionId)` answers one of three named cases:

- `stopped`: this call issued the abort of the current cycle (a run, or a compaction hold);
- `stopping`: the abort of the same cycle is already in flight -- nothing left to abort;
- `idle`: no cycle to stop.

The second stop of a cycle stops nothing more than the first: the abort is already travelling,
and the only thing another answer can add is another bubble -- three `/stop` used to draw three.
So the two surfaces that report a stop, the app's Stop button and a typed `/stop`, stay
completely silent on `stopping`: no frame, no text, no journal line.

### The state is derived, never stored

One rule lives in `src/core/stop.ts`:

```ts
type StopOutcome = "stopped" | "stopping" | "idle";
stopOutcomeOf(controllers: readonly AbortController[]): StopOutcome;
```

No controllers: `idle`. Every controller already aborted: `stopping`. Otherwise each one that is
not aborted is aborted, once, and the answer is `stopped`.

Both authorities hold their controllers and answer through that one function -- the registry
(roots and compaction holds) and the runner (the `activeRuns` of the children the spawn/send tools
drive) -- because the channel calls both and compares the answers. `src/index.ts` returns the root
authority's answer unless it is `idle`, and only then asks the runner; the union travels whole
instead of being flattened into a boolean.

Why derived and not a flag: "a stop is in flight" is a fact about the work -- true exactly as long
as aborted work has not departed -- and `signal.aborted` cannot desynchronise from it. The
transition to "no stop anymore" is not a call: it is the entry leaving the map when the work is
over (a run's `end()`, a hold's `release()`), which is also what makes a new cycle's first stop
anew `stopped`, including when `startRoot` replaces the controller before the old run unwinds.

### The state travels with the turn in flight

One writer, one door: `MyClawAppAdapter.claimStop(sessionId, owner, threadId)`. Both the
`chat.stop` frame and a typed `/stop` claim through it (the command resolves it through the
dependency `index.ts` wires to that same method), so a stop taken by one surface is visible to
the other.

A claim answered `stopped` emits **one** `chat.run.stopping` frame
(`{ type, threadId, run? }`), broadcast to every socket of the owner; `stopping` and `idle` emit
nothing. The frame is recorded in the live turn journal (`LiveTurnJournal`, docs/live-turn-replay.md)
and replayed to a window that syncs while the abort travels -- including a stop against a
compaction, which open no journal at all, so the slot lives beside the journal and not inside it.
The run it names is the one `chat.run.start` announced, kept on the journal when that run opened.

It is dropped where the cycle it described ends: the journal's `close` (the run's end) or
`clearCompacting` (the compaction held and settled). Same rule as the derivation: it is over when
the work is over, never when someone remembers to clear it.

### A sub-agent stopped after its launch turn had ended

A background child outlives the turn that launched it: the launch answers in milliseconds and the
child keeps working, so the subscriptions registered inside that turn are gone by the time it
settles. Two consequences, both of them a state that never resolved on the child's own thread:

- the end that says the run is over was announced from that turn's closure, so it never reached
the app once the parent had ended;
- the journal the end travels through was opened by the same turn and closed by its own end, so
the `chat.run.stopping` frame a fresh Stop claimed had nowhere to be recorded.

Measured 2026-11-16: stopping a sub-agent from its own chat left the composer reading
`Stopping…` for good, while leaving the thread -- which refetches its page -- showed the run
stopped. Where it lives now:

- `subagent:complete|error|aborted|killed|reset` end the child's run at boot level (`src/index.ts`,
  beside the roster push), resolved through the same `ownerOfAppSession` + `subagentSessionToThread`
  pair, so a thread whose launcher is long gone still gets its `chat.run.end`;
- `claimStop` opens the journal for a stopped run that has none (`live-turn.ts` `isOpen`), so the
  abort it names is replayed to a window that reloads and closed by the end that reports it.

A child of a sub-agent (a browser task inside one) keeps the older path: its thread belongs to the
app conversation its grandparent turn carries, which is still alive while it runs.

### A stopped compaction leaves a trace

Before this, a compaction the owner aborted left nothing behind: a boundary (`compaction`) is
written only when the summary lands, so minutes of work left no mark and a thread reopened
elsewhere could not tell the operation had been interrupted. `compaction_stopped` is that mark,
appended on the branch where the pass stopped (`src/sessions/compaction.ts`, in the catch that
sees the abort, before the rethrow):

```ts
{ type: "compaction_stopped", prompt: false, kept: number, compactionMs?: number }
```

`kept` is the count a boundary would have carried for the same plan -- the entries the summary
stood for -- and every one of them is still on the branch, since nothing was folded. The type is
distinct and `prompt: false` exactly for that: the projection (`src/sessions/projection.ts`) finds
its floor by reading `entry.type === "compaction"`, so an entry of its own type cannot be mistaken
for a ceiling and can never move the prompt. `display.ts` maps it as the boundary's sibling -- a
rule with the count, an empty body, `summaryOf: kept`, `compactionStopped: true` -- hoisted out of
any run group: at the moment it is written there is no run open at all.

### Reply

`/stop` replies `Stopped.` for the first stop of a cycle, `Nothing running.` when there is
nothing to stop, and nothing at all when a stop is already in flight (see "One stop per cycle").
The cancelled run delivers no message (the router returns nothing on abort). `/status` shows the
live run tree (`Active run: main, researcher[1]`).

### A stop is a stop of *this* run

Measured 2026-09-21, on a research thread: a sub-agent's `fetch` hung, the tool's own 30s budget
fired, and the whole run ended as "run stopped by user". Nobody had stopped anything:

| time | what happened |
|---|---|
| 09:11:17.665 | the sub-agent fires 4 `fetch` calls; one never answers |
| 09:11:47.704 | it dies "aborted" -- **30.039 s** later, which is exactly the tool's own wall |
| 09:11:49.737 | the **parent** run dies "aborted" |
| 09:11:58.198 | the router writes "run stopped by user" -- the Stop nobody gave |
| 09:16:41 / 09:20:11 | its **two siblings** finish, 5 and 9 minutes later, and write into the log after `run_end` |

The proof that no stop happened is in the survivors: the three sub-agents are children of the
*same* signal (`runner.ts`), so a real Stop would have cut all three. Two of them ran on.

Four shapes arrive as an "abort" while the run's signal is perfectly alive, and none of them is a
stop:

| what arrives | what it is | what it must do |
|---|---|---|
| a tool's own wall (`fetch` 30s, `web_search` 20s) | a host that does not answer | an **error result**, naming the budget |
| a dead socket (`AbortError`) | the network | the transport's own retry/classification |
| a sub-agent stopped on its own | *that* agent's card | an **error result** for its caller |
| the run's signal | the owner's Stop | the end of the run |

The rule that replaced the shape-matching: **`isAbort(err, signal)` answers with the signal**
(`src/core/aborted.ts`), because every `AbortedError` this codebase raises is raised under
`if (signal?.aborted)` of that same signal. Without a signal there is nothing to derive the answer
from, and the shape is all that is left.

Each wall names itself (`src/utils/deadline.ts`, `requestWall`): the timer aborts a controller of
its own, the request carries `AbortSignal.any([own, run])`, and `expired()` -- true for this wall
and never for a Stop -- is the only question a caller asks. A `Stop` still cuts the request
through the composite. `web_search`'s "timed out" branch used to be unreachable for exactly this
reason: `rethrowIfAborted` ran before it and swallowed its own budget.

And the batch is waited for **in full** (`Promise.allSettled`, `src/agent/bridge.ts`): one call
failing is a result, the other calls were asked for by the same turn and their answers are still
wanted, and the model decides what to do about the failure on its next turn. Waiting in full also
means a run that ends -- whatever ends it -- has none of its own calls still in flight, which is
what makes an entry after `run_end` impossible rather than merely unlikely.

## Hooks

`agent:run:aborted` (per run, main and sub-agents) and `subagent:aborted` fire on stop.

## What a Stop leaves in the log

A Stop ends the run, not the record of what it started. Every call of the tool batch in flight is
written before `run_end`: the ones that finished with their result, the ones the Stop cut with the
interruption as theirs (`ToolEntry.interrupted`). The batch used to be thrown away whole on the first
call that rethrew the abort, finished siblings included, and a stopped run's sub-agents vanished from
the prompt. A call that returns *after* the Stop is still dropped (a stop is a stop): its result is
the interruption. Continue picks the run back up from there -- docs/continue.md.

