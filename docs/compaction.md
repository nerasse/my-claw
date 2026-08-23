# Compaction

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

`/compact` shrinks a conversation's context. Two engines answer it, one shared command
(`src/channels/compact-command.ts`) drives both for every channel.

## A boundary, not a deletion

The local summarizer used to *replace* `session.messages` with `head + summary + tail`. That served
the loop and destroyed everything else: one conversation on this install went from ten days of
history to nine messages, and the summaries were the only trace left of the turns they stood for.

`session.messages` is read by two things that want opposite answers — the loop, which wants what the
model must see, and the app's history, which wants what the owner wrote. Cutting answered the first
by destroying the second. A boundary answers both:

| | before | now |
|---|---|---|
| `session.messages` | rewritten, the middle deleted | append-only, every turn kept |
| what the prompt carries | the whole array | `promptMessages(session)`: the array from `session.promptBase` on |
| what the app replays | whatever survived | the whole array, the boundary drawn as a rule |

`promptBase` is the index the prompt starts at, and the summary sits exactly on it: the model reads
summary + tail, the thread still scrolls back through everything. Absent means the whole array is
the prompt. An index past the end reads as no boundary rather than as an empty prompt, so a session
rewritten under a stale index degrades to "send everything" instead of "send nothing".

**`promptMessages` is the only way to read a session for a prompt.** The gate, the prompt build, the
vision pass, `/status` and the summarizer itself all go through it. That is what makes the rule hold:
keeping the history can never widen what a model reads, because no caller touches `messages` directly.

A second compaction summarises only what is past the previous boundary. Reading from index 0 would
summarise a summary and re-bill turns the model cannot see.

Three places have to clear or clamp the index, and all three are bugs if they are missed: `/clear`
(the array it indexes is gone), a failed run rolling `messages` back past the boundary, and `/status`
reporting occupancy (a share of the window has to count what is in the window).

### The gate measures the prompt, and so does everything that reports it

The boundary alone would not have stopped what happened: thirty of the thirty-five compactions on
that thread were fired on a number that was wrong by 8.7x. The loop runs `pruneOldToolResults` over
the prompt before every call, stubbing old tool results to 200 chars, but the gate estimated the
untouched history — 410k tokens against 47k the provider actually billed, on a session sitting at
nine percent of its window. `occupiedContextTokens` floors on the estimate (`Math.max`), so the real
measurement could never talk the gate down.

`promptSideChat` (`agent/context-pruning.ts`) is the one answer to "what does the prompt carry":
`promptMessages` for the boundary, then the same pruning the loop applies, skipped for the Anthropic
backend whose cache is a prefix and whose prompt is therefore sent whole.

Three places read occupancy and all three go through it, because a private copy in each is how they
came to disagree by a factor of eight about one conversation:

| reader | where |
|---|---|
| the compaction gate, run-start and mid-run | `bridge.ts` `contextGate` |
| `/status` | `status-command.ts` |
| the app's chat header (`context.used`) | `index.ts` |

The header was the worst of the three once the boundary landed: it read `session.messages` whole, and
that array is append-only now, so the gauge would have climbed to full and stayed there forever.

### What the owner sees

The summary is stored in a `user` turn because that is the role the prompt needs it in. Replayed as
one it was a wall of `[Prior context summarized]` in the owner's own voice — the thread read as a
transcript he had typed of himself. The entry therefore carries `summaryOf`, the number of turns it
stands for, and the app draws it as a rule across the thread (`CompactionBoundary`) with the summary
folded under it. `text` on such an entry is the summary alone: the instructions wrapped around it
("respond to the message below") are addressed to the model and have no reader in a thread.

Both counts in the `/compact` answer are prompt-window sizes. `session.messages` only grows now, so
reporting its length would announce a compaction as `12 → 13 messages`.

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

### Every agent, not only the orchestrator

The gate used to be `depth === 0 && !isCron`, which left the two profiles most likely to fill a
window with nothing but the hard trim: a research sub-agent reading documents, and a cron job doing
the same work on a schedule. Both are sessions, both resume, both grow. The gate is now scoped by
`context.autoCompact` alone.

That makes the summarizer's model matter. It follows `agentTypeOf(session)` (`cron` for a scheduled
session, the sub-agent's kind for `subagent/*`, else the orchestrator), so a sub-agent pinned to a
cheap provider is summarized by that provider instead of the expensive default. `/status` reads the
same helper for the context ceiling it reports, which is where the rule came from.

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

The SDK also compacts by itself, and reports it with `trigger: "auto"` in the transcript boundary.
Every boundary it reports is recorded as `sdkTranscriptBase` with the stale measurement dropped, so
the mirror stops being counted as if the model still held it (`docs/context-window.md`).

### Inside a run, not only between two

The gate above runs once, at the start of a run. That was the whole story while a run was a turn or
two; it is not, on either engine: one agentic run can add hundreds of thousands of tokens of tool
output before it answers.

| | what used to happen mid-run | what happens now |
|---|---|---|
| home loop | `trimToContextWindow` kept the prompt legal by **dropping** the oldest turns | the gate runs again between iterations and summarises instead |
| claude-sdk | the engine's own compaction fired on the **model's** window (~967k for a 1M model) | it is handed our effective window, so it fires under our ceiling |

The trim stays, and has to: a compaction can fail (a refusal, a provider outage, a history with no
middle to summarise) and the request still has to fit. It is the floor under the gate, not its
replacement, which is why it is a warning in the log when it fires.

On the home loop the check sits between two iterations, before the prompt is assembled. The run is
the only writer at that point (the router serialises runs per session and meta-commands are refused
while one holds it), so the risk is not a race but consistency: the prompt is built from the history,
so a rewritten history means a rebuilt prompt, and the rollback point the error path uses is moved
with it (`session.messages.length = messageCountBeforeLoop` on a shorter history would extend the
array with holes). The recalled memory block is not re-injected: it is a hint on the inbound turn,
the run has already read it, and it never was part of the history the summary came from.

A summarization that changes nothing (history too short to split, a refused summary, a provider
error) backs off for ten turns. Every iteration past the threshold is a candidate, and without the
backoff a run would pay for one summarization attempt per tool round and never move.

On the SDK side the ratio cannot be set, only the window: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` was
measured against `getContextUsage()` and left the reported threshold untouched, so it is not used.
The engine's own threshold inside the window we hand it lands around `window - 33k` (measured:
479 000 for a 512k window, against 934 000 with no setting), which makes it a backstop under our 80
percent rather than a second policy.

### What the owner sees

A triggered gate spends one to two minutes with nothing on the wire, on a message that was just
sent, or in the middle of an answer already streaming. Both engines therefore emit `message:queued`
with reason `compaction` when they fire, run start and mid-run alike, the
same event a send held behind a `/compact` produces, so the app marks the bubble "waiting for the
compaction" with its elapsed counter. The mark is lifted by whatever comes next (`chat.stream.start`,
`chat.message` or `chat.run.end`), so a lost frame cannot strand it.
