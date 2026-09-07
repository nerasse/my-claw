# Bubble identity

## One bubble, one id

A phase entry now carries the id of the live bubble its text was streamed into.

Before, the two were minted independently: the channel gave the bubble a uuid of its own, and the
entry store minted an id when the phase was appended. The same prose therefore had two identities,
and nothing could tell that the persisted phase and the bubble on screen were the same thing.

That is what forbade replaying or re-syncing a settled bubble: a client handed both would print
the run's prose twice, permanently, and could not dedupe it. `docs/live-turn-replay.md` works
around it by dropping a bubble from the live journal the moment it closes. With one id, that
workaround stops being load-bearing and an end-of-run sync becomes possible.

A user turn already worked this way -- the entry keeps the id the device sent -- which is exactly
why a mirrored question never doubled. This extends the same rule to what the agent writes.

Commands are the one deliberate two-bubble exception. One `CommandEntry` keeps the `sourceId`
of the `chat.send`; the display projection derives the input bubble as `<sourceId>` and the answer
as `cmd-<sourceId>`. A replay therefore replaces both live command bubbles instead of appending
another pair. Legacy command entries without `sourceId` use their own entry id as the fallback.

## Identity first, then the stream, then the log

The order is the one OpenCode and pi-mono both settled on: the message exists, with its id, before
the first token; the stream fills it; persistence writes the same identity.

Where this differs from them: they mutate a row in SQLite as the parts arrive, so the entry is
created empty and updated. Our session log is append-only, deliberately -- a tool entry is written
when the call settles, never before, because a process killed mid-tool used to leave a request no
answer would ever match, and an OpenAI-compatible provider refuses that prompt outright.

So the id is minted early and the entry is still appended once, whole:

```
bubble opens   -> streamer mints an entry id (newEntryId) and streams under it
call returns   -> recorder appends the phase WITH that id
```

Nothing is mutated, nothing is written before it is complete, and the two identities collapse into
one.

## How the id travels

Not through the run loop's signature. `handleMessageStreaming` already carries eleven positional
parameters across five layers, and this is not information the loop reasons about.

It rides on the run context (`utils/run-context.ts`), the AsyncLocalStorage that already exists for
exactly this shape of problem, keyed by session id: the root run and each sub-agent register their
own streamer, and the recorder reads the sink of the session it is writing to. Without the key, a
sub-agent's bubbles would be handed to its parent's phases.

## The reroute replays the run, not the bookkeeping

One id, one entry, is enforced by the log itself: `append` refuses an id it already holds, because
reusing one makes the tree ambiguous and lets a retried send attach to an older turn.

A model fallback (`dispatcher.runWithFallback`) replays the whole run on another model. The owner's
turn is already in the log by then, written by the attempt that just failed, and under the id the
client minted -- so the replay walked straight into that refusal. Every fallback died ten
milliseconds in, reporting `Entry id already exists` where the provider outage that caused the
reroute should have been. It was measured on every reroute in production, and it was invisible in
the suite because the dispatcher tests hand it a bridge that keeps no log.

The replay therefore carries `userEntryWritten`, the same flag the sub-agent runner already used
for the same reason: the turn is recorded once, by whoever received it, and a run that is a second
attempt at an existing turn does not re-record it.

## When the counts disagree

The recorder pairs ids to phases by position, and **only when there are exactly as many of one as
of the other**. Otherwise it mints as it always did, and that turn keeps the old behaviour.

Segments and phases usually match one for one -- the streamer seals a bubble where the provider
cuts a phase -- but nothing guarantees it: a segment can hold reasoning that never becomes prose,
and a provider can report phases the stream never split. Pairing those by position would give a
phase the id of a bubble holding something else, which is worse than two ids: the client would
merge one into the other. A conservative fallback costs a turn's alignment; a wrong pairing costs
the reader's trust in what they are reading.

## A failure is a bubble too

A run that dies is shown in a bubble like anything else: the streamer aborts, and the app either
patches the bubble it was streaming into or invents one from the id the abort frame carries. The
`failure` entry the run's error path journals used to mint an id of its own, which is the same
two-identities bug one layer down -- and it showed: a page handed to a window that had seen the
error live drew it a second time, at the end of the thread, under the answer to the next question.

So the id travels the same way the phases' does, through the run context: the streamer remembers
the bubble its abort painted in (`errorBubble()`), the sink exposes it (`runErrorBubble`), and
`recordFailure` appends the entry under it. Read, never taken: the phases of the same run go on
claiming their own ids from the sink.

`append` refuses an id the log already holds (a reroute can hand back a turn already written), and
here that refusal must not cost the entry: the failure falls back to an id of its own. A duplicated
error is a nuisance, a question with nothing under it is a mystery.

The app closes the same hole from its side, for a thread drawn by an older server: a window
replaces the range it covers instead of piling onto it (app docs/thread-sync.md).
