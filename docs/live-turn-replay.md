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

### One delta per subject, and it replaces

The same frames, with one exception that the first version got wrong: the fragments are coalesced.
A bubble that was streamed in forty chunks replays as **one** `chat.stream.delta` carrying the
whole text, flagged `replay: true`, sitting where the first chunk sat. Same for a tool card's
output and for reasoning.

The reason is that the window asking for a sync is usually the window that was already watching.
A blip on the Wi-Fi, a thread left and reopened, a refresh: the client reconnects holding the
bubble, `chat.stream.start` on a known id is a no-op by design, and every replayed chunk was then
appended to text that was already there. The answer appeared twice, and stayed twice for the rest
of the run.

Appending is right for a live delta and wrong for a replay, so the frame says which it is rather
than the client guessing. `replay` means *this is the whole thing*: `appendDelta` and
`appendToolOutput` replace instead of concatenating. A window that never saw the run gets the same
result, since replacing an empty bubble is setting it.

An old client ignores the flag and appends, which is exactly what it did before: no worse, and it
converges as soon as it updates.

## Sends no run has consumed yet

A message sent while a run is in flight is parked in that run's mailbox until its next turn
boundary; one sent during a compaction is held by the router until the history stops moving. In
both cases the message exists in memory and on the sender's screen and nowhere else, for as long
as a tool call or a compaction takes. A window reloading in that gap came back without it: no
entry served it, and the `chat.send.acked` that follows the drain reached a window with no bubble
left to lift. So the journal holds the parked sends as the frames their other windows received,
`chat.user` then `chat.send.queued`, and replays them after the turn's own frames: the bubble at
the bottom of the thread, with its mark. Released when the run drains the message (its entry is on
the log from then on) and when a run opens on the thread (the send that opened it is the first
line of that run, and it is acked at that moment, `chat.send.acked`, since a compaction-parked
send has no turn boundary to be drained through). Held beside the compaction rather than inside a
journal, because a compaction-parked send exists with no run open at all.

The hold exists for every mark, not only the ones whose bubble the adapter still has in hand. It
used to be recorded only when `recentSends` (an LRU of 64) could still name the bubble, and the
`chat.send.queued` frame went out either way: a send whose bubble had aged out was marked on the
device and had nothing for `chat.send.acked` to fire on, so it wore "waiting for the compaction"
until the run ended, and every reconnect was replayed the mark again (2026-09-11). The bubble only
enriches the replay; it is not what makes the mark liftable.

A mid-run compaction does **not** mark anything. The hook marks a send waiting for a run to become
possible, and a run parked mid-answer has no such send: its bubble is the one already being
answered, no `message:route:start` will ever come for it, and the mark could only be lifted by the
end of a run that had nothing to do with it. A run that called tools without ever writing produced
no clear signal at all, and the owner's bubble wore the badge for 1 h 31 while its run was well
underway. The operation is announced by `session:compact:start` / `chat.compacting`, which every
path emits, which the journal replays, and which the app draws as the live compaction rule -- not
by a mark on a send that is not queued.

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

It is driven by the run, not by the message. The app handler used to call it once per inbound
message, and a message sent mid-run is not a run: it is folded into the one in flight. Its call
replaced the journal that run had been filling, so a reload after a steering send came back to the
hole this document exists to plug, and its end was announced a second time. `notifyRun` now hangs
on the router's lifecycle hooks (`message:route:start`, `:complete`, `:error`, `:aborted`), one
start and one end per run, and the journal itself refuses to be reopened while it is open: a thread
with a journal keeps it and says so, so a second announcement of the same run, from whatever
caller, neither wipes nor re-broadcasts. Closing is the same, once.

A sub-agent's thread gets a journal too: the child's streamer is created inside the parent run
(`streamSubAgent`), which is where its run is announced and where its journal opens, and it closes
when the child settles or when the parent run ends with children still painting. Without it a
window opening a child mid-run (a conversation the app explicitly lets the owner open) saw the
question and nothing under it.

An approval is not a streamer frame, so `confirmTool` records its `approval.request` itself and
the resolution removes it. A sheet is replayed only while its promise is still pending: replaying
a question already answered would ask twice.

That replay is per thread, which is not enough on its own. It fires on a `session.sync` of the
thread the sheet belongs to, so a window opening on another conversation -- or an app coming back
from sleep on its last thread -- learned nothing, and the tool sat out its two minutes and was
denied without the owner being asked. Every socket is therefore also handed `approval.pending` at
connect, the whole list for that owner, read from the pending promises rather than from the
journals so it does not depend on a run being open. Authoritative like `question.pending`: the
client replaces its queue, and the empty list is what clears a sheet left behind by a restart.

A compaction in flight (`chat.compacting`) is not replayed like a turn at all, and that is the
point.

Everything above is an **event** a window missed: a stream chunk, a tool card, a parked send, a
sheet. A compaction is a **state**, and a state cannot be caught up on by replaying the events that
built it. The start is broadcast once and the end is broadcast once, to whoever is connected at
that second, and a window that was down for either is left holding whatever it last heard.

That is not theoretical. On 2026-09-13 a `/compact` that had succeeded at 18:57 was still drawn on
the owner's phone at 19:13 -- nineteen minutes on a counter still climbing from the instant the
operation began, next to the boundary it had written. The socket on that device drops every ten to
forty minutes, and a lost end had nothing at all to correct it: the boundary is in the history, the
end of a run arrives with the run, and a fresh page predates what was in flight, but a compaction
that ends while the thread is quiet is an event no later frame mentions. `/stop` then answered
"Nothing running", truthfully, and read as the server losing the plot.

So the state is said by the resynchronisation itself: `session.sync.result` carries `compacting`,
the operation when one runs and **nothing when none does**. The absence is the half that matters,
and it is said on every sync rather than once, so a window that reconnects later converges exactly
the same. It rides beside `activeRun`, which exists for the same reason.

The slot itself stays outside the journals. `/compact` is a command: no run is open for it, and
nothing could open one without lying about a lifecycle. `live.compactionState` is the one reader of
that slot, and `replay` deliberately leaves it out -- an event list is the wrong shape for a state,
and a frame that says "not compacting" is not a replay of anything.

The stop in flight is the other state a window can come back into, and it *is* replayed -- the
same slot, the other way round (docs/stop.md). A claim is answered once, when the abort is taken
(`chat.run.stopping`, broadcast to every socket of the owner), and the work it describes stays in
flight until it unwinds: exactly the window a reload falls into. There is nothing to coalesce here
and no counter to correct -- the frame **is** the state, one per cycle -- so repeating it is not
replaying the events that built something, it is saying the one sentence again, and a sync after
the work has departed hears nothing of it. It lives beside the journals for the compaction's own
reason: a `/stop` against a compaction aborts a hold, and a hold opens no run for a journal to
hang on. Dropped where its cycle ends -- the journal's close for a run's, `clearCompacting` for a
hold's -- never by a caller remembering to.

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
