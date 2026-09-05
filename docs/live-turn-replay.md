# Live turn replay

## The hole

A window that reloads while a run is in flight comes back to a thread with a hole in it.

Two facts meet:

- A session entry is written when the call it describes is **settled**. `session.sync` serves the
  persisted thread, so nothing of the turn in flight is in it -- that is the normal state of any
  run in progress, not an edge case.
- Everything the turn has shown so far went out through `broadcast`, to the sockets that were
  connected at that instant. Nothing pushed while a socket was down is replayed.

So after a reload mid-run the app knows a run is active (`session.sync.result` carries
`activeRun`) and has nothing to show for it: the assistant text already streamed, the reasoning,
the tool card that is running and the live output under it are all gone until the next frame
arrives. A pending approval is worse than gone: the sheet was broadcast once, so the tool now
waits out `CONFIRM_TIMEOUT_MS` and is denied, and the owner never sees what they were asked.

The device is not at fault and cannot fix this: it never received the frames.

## The rule

**The server keeps the turn in flight replayable for as long as it is in flight.**

A live turn journal, per owner and thread, holds the frames the turn emitted. On `session.sync`
for a thread whose run is active, the journal is replayed after the delta. When the run ends the
journal is dropped: its content is in the session by then, and the persisted thread is the one
truth for anything settled.

Nothing new is invented on the wire. The journal replays **the same frames**, in the order they
were sent, so the client applies them through the paths it already has and a replayed turn and a
watched turn converge on the same thread. That is the whole reason for choosing frames over a
summary: a second representation of a turn is a second thing to keep true.

## It holds only what the store cannot know yet

A journal is not a copy of the run. A bubble that closes and a tool that settles are dropped from
it on the spot: `recorder.turn` writes the phases as soon as the model call returns, and a tool
entry is written when the call settles, so from that instant the delta is what serves them.

This is not an optimisation, it is what keeps the replay correct. It was written when a persisted
phase and the live bubble it was streamed into did **not** share an id; they do now
(`docs/bubble-identity.md`), so the rule is no longer load-bearing and an end-of-run sync has
become possible. It stays as it is because a journal that holds only what the store cannot know is
smaller and easier to reason about, not because a duplicate would still be permanent.

The reasoning it was built on, kept because it is what any change here has to answer to: a
persisted phase and the live bubble it was streamed into did not share an id -- a user turn did,
since its entry carries the id the device sent, but a phase id was minted by the entry store. A
client handed the same prose twice could not tell, so replaying a settled bubble beside the delta
that already carried it printed the run's text twice, for good, on screen.

The trade is a window of sub-millisecond width: between the `chat.stream.done` that drops a bubble
and the entry that replaces it, a sync would miss that bubble. A gap that narrow, in exchange for
no duplicate at all, is the right way round -- a duplicate is permanent and a reader cannot tell
which copy is real.

Tool cards are the opposite case and need no rule: a live card and its entry **do** share an id, so
a replay upserts rather than doubles.

## Where it lives

`createStreamer` is the single door every frame of a turn goes through
(`send: (frame) => this.broadcast(owner, frame)`), so recording happens there and nowhere else.
`notifyRun` is the lifecycle: `active` opens a journal for the thread, the matching end drops it.

An approval is not a streamer frame, so `confirmTool` records its `approval.request` itself and
the resolution removes it. A sheet is replayed only while its promise is still pending: replaying
a question already answered would ask twice.

A compaction in flight (`chat.compacting`) is held **outside** the journals, in a slot of its own.
It is the same kind of hole -- minutes of silence a reloading window cannot reconstruct from the
store -- but it is not part of a turn: `/compact` is a command, so there is no journal open for it
and nothing to open one from. A fake run would have been the alternative, and it would have had to
lie about a lifecycle. It is replayed after the turn's frames and before the pending sheets, and
cleared when the operation settles, so a window that arrives late is never shown an operation that
has already stopped.

## Bounds

A journal is memory, so it is capped, and the cap is a design decision rather than a guard:

- Assistant text and reasoning are never dropped. A turn's prose is small, and it is the part a
  reader would miss most.
- A tool's live output is what can grow without limit (a `bash` printing megabytes). Past the
  journal's budget the oldest tool output is dropped and its card is replayed **flagged
  truncated**, which is a state the protocol already has: the app shows the cap and asks for the
  rest with `chat.tool.full` once the call settles. A truncated card is honest; a card missing
  from the thread is not.
- One journal per thread, dropped at the end of its run. A thread with no run in flight costs
  nothing.

## What this is not

- Not durability. A server restart loses the journal, and it should: the run died with it.
- Not history. The journal never holds a settled turn, and `session.sync` keeps serving the
  session for everything the store owns. There is exactly one writer per state.
- Not a replacement for `resume`. A reconnecting socket still asks for the delta first; the
  journal only fills the tail the store cannot know about yet.
