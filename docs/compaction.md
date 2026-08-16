# Compaction

`/compact` shrinks a conversation's context. Two engines answer it, one shared command
(`src/channels/compact-command.ts`) drives both for every channel.

## The two engines

| Session | Engine | What it rewrites |
|---|---|---|
| Model backed by the Claude SDK | the SDK's own `/compact`, sent into the resumed session (`ClaudeSdkBackend.compact`) | the SDK transcript (`~/.my-claw/claude-sdk/projects/…jsonl`), which emits a `compact_boundary` |
| Any other model | the local summarizer (`sessions/compaction.ts`) | `session.messages`, the my-claw mirror |

The split is not cosmetic. On the SDK path the prompt is built by resuming `sdkSessionId`, so
summarizing the mirror would change nothing the model sees; on the home loop the mirror *is* the
prompt. Which one runs is decided by `isSdkBackedModel(config.llm, session.modelOverride)`, tags
expanded.

Consequence to expect on the SDK path: the app's message list and the `messages` count in
`/status` do not move after a compaction. They report the mirror. Only the next run's prompt
tokens drop, and that number shows up in `/status` as `context measured` once that run is done.

## The session is held, not merely checked

Both engines rewrite the history a run resumes, and the SDK one drives a second CLI process on
the same session file. So a compaction takes the session for its whole duration
(`runRegistry.beginCompaction`), and the exclusion works in both directions:

- a run in flight refuses the hold (`/compact` answers that a run is active),
- a second `/compact` refuses too,
- a message arriving during a compaction **waits** for it in the router
  (`runRegistry.waitForCompaction`) instead of opening a run.

That last one is the bug this design exists for. Observed in production: a `/compact` ran for
101 seconds, a message sent 30 seconds later opened a run that resumed the pre-compaction
transcript, both processes appended to the same `.jsonl`, and the finished compaction ended up
in a branch nobody read. The prompt went from 271k tokens to 291k across the boundary.

`/stop` reaches a compaction: the hold carries an `AbortSignal` that the SDK engine passes to
its CLI process, and the answer says `Compaction stopped.` rather than the timeout wording.
`/status` names it in `active run` as `compaction`, since a compaction has no run node.

## Feedback while it runs

A compaction on a full session is minutes long. The app is told with a `chat.command.pending`
frame once the command has been silent for 400 ms, and the result replaces that placeholder
bubble in place (see `docs/my-claw-app-channel.md`). That placeholder counts the seconds up on
the device, from its own timer: nothing is on the wire between the notice and the result, and a
bubble frozen on the same words for two minutes reads as a dead app. Telegram and Matrix show
only the final answer.

The end of the command is also announced out of band. `handleCompactCommand` emits
`session:compact:finished` for both engines, on success and on failure alike, and the push
wiring turns it into a device notification (`docs/notifications.md`), skipped on a device that
is already looking at the thread. The three `session:compact:start/end/error` events cannot
serve here: they live inside the local summarizer and the SDK engine never reaches them.

A message sent while a compaction runs is held by the router, and that wait is announced too:
`message:queued` fires before `waitForCompaction`, `index.ts` turns it into a `chat.send.queued`
frame, and the app marks that bubble `waiting for the compaction` with the same running counter.
Without it the send looked dropped for the length of the compaction, which is what made the hold
read as a frozen app: on 2026-08-15 a `/compact` ran 110s, the message sent 62s in was released
with it, and both landed at the same instant, so the message looked like the cause of the result.
The mark is lifted by the stream, by a non-streamed answer, or by the run's end, so no single lost
frame can strand it.

The wall on a compaction is 15 minutes, and it is a wall, not an expectation: 250k tokens
measured at 101 seconds, so the previous two-minute wall aborted a session barely larger than
that and called it a timeout. It exists for a CLI that hangs, and a hung one hangs forever.

## The summary

`/compact` answers with a `CompactOutcome`: the outcome line, plus the summary when the engine
can hand one back. The local summarizer wrote it, so it returns it directly. The SDK does not
put it on the wire (`compact_boundary` carries counters only), so it is read back from the
transcript afterwards (`claude-sdk/transcript.ts`): the summary is the continuation message that
opens the compacted session, between the `Summary:` line and the instructions the CLI appends
under it. The transcript is located by session id across the project directories, because a
compaction runs without a cwd and the file lives under the project of whoever created the
session.

The app renders it folded under the outcome line, the same collapsed aside it uses for a model's
reasoning: reading it is a choice, not a wall of text in the thread. Telegram and Matrix get the
outcome line alone, since a 16 kB summary posted into a room is not a feature.

## Auto-compaction

Both engines compact on their own when the context fills (`context.autoCompact`, threshold in
`docs/context-window.md`). The gate runs *inside* the run that triggered it, so it takes no
hold: the run already owns the session, and a `/compact` typed meanwhile is refused for exactly
that reason.

|  | home loop (`bridge.ts`) | claude-sdk (`claude-sdk/backend.ts`) |
|---|---|---|
| what it measures | `occupiedContextTokens` over the history it is about to send | the billed prompt of the last call, the mirror estimate when there is none |
| what it runs | the local summarizer (`compactSession`) | the SDK's native `/compact` |
| after a success | the history is rewritten, so the measurement invalidates itself | `lastPrompt` is dropped by hand |

The asymmetry is the whole point of the second engine's gate. On the SDK the transcript is not
ours: `session.messages` is a mirror that nothing ever shrinks, and the cap we resolve is a
number the SDK never hears about. Without the gate the ceiling was decorative there, a
conversation sat at 110 percent of it, and only the SDK's own threshold, computed on the model's
full window, ever fired. Dropping `lastPrompt` after a compaction is not bookkeeping either: the
measurement describes a transcript that no longer exists, and keeping it would re-trigger the
gate on every run from then on.

The SDK also compacts by itself, out of reach from here, and reports it with `trigger: "auto"`
in the transcript boundary.
