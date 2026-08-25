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

## When the counts disagree

The recorder pairs ids to phases by position, and **only when there are exactly as many of one as
of the other**. Otherwise it mints as it always did, and that turn keeps the old behaviour.

Segments and phases usually match one for one -- the streamer seals a bubble where the provider
cuts a phase -- but nothing guarantees it: a segment can hold reasoning that never becomes prose,
and a provider can report phases the stream never split. Pairing those by position would give a
phase the id of a bubble holding something else, which is worse than two ids: the client would
merge one into the other. A conservative fallback costs a turn's alignment; a wrong pairing costs
the reader's trust in what they are reading.
