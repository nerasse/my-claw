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
bubble in place (see `docs/my-claw-app-channel.md`). Telegram and Matrix show only the final
answer.

## Auto-compaction

The home loop compacts on its own when the context fills (`bridge.ts`, `context.autoCompact`,
threshold in `docs/context-window.md`). It runs *inside* the run that triggered it, so it takes
no hold: the run already owns the session. The SDK does its own auto-compaction, out of reach
from here, and reports it with `trigger: "auto"` in the transcript boundary.
