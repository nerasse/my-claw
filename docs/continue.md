# Continue: pick a stopped run back up

## Why

A run that stops before it is done -- a provider error, a Stop, a server that went down under it --
used to leave two choices: type a new message ("continue"), or start the task over. The first one
worked more often than not, since the prompt is rebuilt from the log. The second is what happened to
sub-agents: a run stopped while its sub-agents worked lost them from the prompt entirely, so the next
run spawned new ones and their work was redone from nothing. Measured on 2026-09-28 across the logs
of this install: **295 stopped runs left sub-agents the prompt no longer showed**, against 37 failed
runs that ended on a tool result (which a plain "continue" handles) and 18 stopped mid-answer.

Continue is a button under the last run of a thread when that run was stopped, failed or lost. It
adds no message. It resumes the interrupted sub-agents first, each in its own session, then lets the
model go on from where the conversation stands. The same button works in a sub-agent's own chat.

## What was losing the sub-agents

The tool batch of a turn is awaited in full (`Promise.allSettled`), but on the first rejection -- a
Stop reaching a `spawn`, which rethrows the caller's abort -- the whole batch was thrown away before
anything was written, the siblings that had finished included. A turn's calls are derived from their
results in the prompt (`projection.ts`), so calls with no result are calls the model never made.

Now every call of the batch is written before the run ends. One the run ended under gets the
interruption as its result (`ToolEntry.interrupted`), and for a sub-agent that result names the child
and how to get it back: `send(id) with no message resumes it where it stopped`. A server that died
mid-batch writes nothing at all; its `spawn_state` entries survive and name the call, the child and
its task, so a Continue writes those results itself, in the turn that made them (`orphanCalls`), only
when nothing the model said comes after that turn.

## What Continue does

`chat.continue { threadId, parentThreadId? }` goes through the same pipeline as a `chat.send`
(`messageHandler`, router, streamer), with `UnifiedMessage.resume` set and no bubble of its own.

1. **Refused** when a run is already going on the thread, or when the owner's last message was
   answered to the end (the last run marker after it is a `done`): there is nothing to pick up. Checked at the frame, then again under the session's lock in the
   bridge, since the run that was going when the button was pressed may have finished since.
2. **No turn is written.** The prompt is the log, exactly as it stands. `message.text` carries the
   last question, for what reads it (skill suggestions, memory) and nothing else; it is not archived.
3. **Interrupted sub-agents are resumed first, by the run itself** (`interruptedSubagents`): a turn
   of `send(id)` calls with no message, run through the same tool path as the model's own calls, so
   the parent's card shows each child working and the results land in the log like any. Not left to
   the model: told the id, deepseek-v4.1-flash copied it wrong two times in three (`wttj`,
   `wttj-4f2a` for `subagent/wttj-4f2a`).
4. **Then the model goes on.** After a tool result or a question, it just answers. After its own
   text it was cut off mid-answer, and handed that alone it starts its answer over two times in three
   (measured); a one-line instruction tells it to continue from where it stopped, in the prompt only,
   never in the log (four in four, mid-sentence).

One press, one run: if the same error comes back, the run fails as it would have, and the button is
there again.

## A message stopped at once

The owner sends, and stops before anything comes back. 51 runs of this install ended that way
(and 25 failed on their first call): `user -> run_start -> run_end(aborted)`, nothing in between.
Two things kept the button away from them (2026-10-02):

- **The app had nothing to hang it on.** The button rides a run's signature, the signature rides
  an item of that run, and a run that wrote nothing had none. `runFold` now puts the meta of an
  empty run on the message that triggered it, so the message is signed (`run · 0.4 s · Stopped`)
  and the button appears under it, live and on a reopened thread alike.
- **A Stop before the run's own marker was refused.** A Stop during the snapshot, the
  transcription or a compaction ahead of the run writes an end with no start; `continuable` read
  the last *run*, found the one before, finished, and answered "the last run finished". It now
  reads from the last message: the last run marker after it decides (an end says how it ended, a
  start with no end is a lost run, no marker is a message no run took up).

The Continue of such a message is the "after a question" shape: no turn is written, the prompt ends
on the message, the model answers it once.

## Sub-agents

`send(id)` with no message (or a blank one) resumes: no turn is added, and the child's own run is a
Continue, which resumes its own interrupted children the same way. A child whose last run had in fact
finished is not run again: its answer is returned as it stands (`lastAnswer`). A sub-agent reopened
as a chat has the same button, which reaches it through the router's sub-agent path.

`send` also takes the id the way models write it: without the `subagent/` prefix, or as the display
name when exactly one sub-agent the caller can reach carries it.

A sub-agent that fails on its own (its provider, not the parent's Stop) keeps its session, whatever
its mode; the error its caller gets names it and says the same thing: resume it, do not start over.
A `mode: "session"` spawn used to be deleted on a failure instead, its caller having no id to name
it by, and the caller redid its task from nothing (the veille of 2026-09-29, 24 tool calls lost).

## Tested

- `tests/continue/continue.test.ts`: reading the log (continuable, lost calls, where the prompt ends),
  the batch kept whole on a Stop, and a Continue after a failure, mid-answer, with interrupted
  sub-agents, after a crash, and on a finished run. Each fails without its fix.
- `tests/continue/subagent-resume.test.ts`: `send` with no message, a finished child, loose ids.
- `tests/my-claw-app-adapter.test.ts`: the frame, its refusals.
- `tests-e2e/continue/deepseek.test.ts` (`CONTINUE_E2E=1`, needs `OPENCODE_GO_KEY`): the three shapes
  against the real deepseek-v4.1-flash on OpenCode Go. 15 of 15 over five runs (2026-09-28).

## Where it lives

| What | Where |
| --- | --- |
| Reading what a conversation stopped on | `src/sessions/resume.ts` |
| The batch written whole, the resume turn, the cut-off instruction | `src/agent/bridge.ts` |
| `send(id)` with no message, loose ids, failure hints | `src/subagents/runner.ts`, `src/tools/send.ts`, `src/tools/spawn.ts` |
| No injection, no archive for a Continue | `src/core/router.ts` |
| The frame | `src/channels/my-claw-app/adapter.ts` (`handleChatContinue`) |
| The button | app: `src/components/RunFoot.tsx` |
