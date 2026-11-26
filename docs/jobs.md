# A call that outlives its turn is a job

## Why

2026-11-25, the CubeFlow lead watched a sub-agent sit on `running` for 85 minutes and stopped it by
hand, twice. Nothing was frozen. The log says what happened: one `bash` call ran
`cargo build --workspace && cargo test --workspace` and returned **41.4 minutes** later with 86
characters of output; the next one ran `cargo test --no-default-features` for **43.8** minutes until
the Stop. Between the spawn and the exit, my-claw wrote nothing -- no log line, no hook, no frame.
A build that is compiling and a process that is wedged were the same picture.

The same day, the main agent spent three calls of 45, 53 and 53.5 minutes in shell polling loops
(`for i in $(seq 1 270); do [ -e $E/agents/ax9/gate-AX9.done ] && break; sleep 10; done`), each one
silent by construction.

The tool had two answers, and both were wrong: wait (up to an hour), or write `setsid ... &` and
lose the exit code, the output and any way to know it ended.

## What the three harnesses do

Read for this design, not remembered:

- **OpenCode V2** (`packages/core/src/tool/plugin/shell.ts`, `packages/core/src/job.ts`): a
  `background` flag, a 2-minute foreground timeout, and **on timeout the command moves to the
  background instead of being killed**. The call answers with a shell id, a pid and an output file;
  the end arrives as a synthetic session message (`<background-result kind="…">`). Jobs are rows in
  SQLite, so a restarted server re-attaches and still notifies. The same `Job` service carries
  image generation, video generation and sub-agents.
- **DeepSeek Harness** (`packages/shell`, `packages/jobs`): every `bash` call registers with
  `ctx.jobs` as it starts; `run_in_background` returns `started background job <jobId>`, and
  `job_output` / `job_list` / `job_kill` read and stop it. A foreground command that outlives its
  deadline **keeps running as the job it already was**. Completion is delivered in-session;
  `wait` yields on a user steer. The registry is generic and the prompt says not to poll.
- **Codex** (`codex-rs/core/src/tools/handlers/unified_exec`): the odd one out. `exec_command`
  yields after 10 s (max 30 s) and returns a `session_id`; the model polls it with `write_stdin`
  (5 minutes per empty poll) or sleeps. Nothing is pushed.

Two converge on the shape this install took: **a call that runs past its yield becomes a job its
session owns, and the end is pushed into the conversation, never polled.**

## The rules here

1. **The yield.** A `bash` call waits `yieldMs` (default 120 000, max 600 000) for the command. If
   it is still running, the call answers `Started as job job-<id> (pid …, output …)` and the run
   goes on. `background: true` yields at once.
2. **The wall belongs to the command, not the call.** A declared `timeout` is the command's own
   budget: shorter than the yield, the call waits and it dies as it always did; longer, the job may
   run that far. With no `timeout`, a job may run 6 hours. A call with no session (`bash` outside a
   conversation, in a test) keeps the old 5-minute wall and never hands off.
3. **The output goes to a file.** `<session>/jobs/<id>.log`, written chunk by chunk as the command
   produces it, up to 64 MiB: past that it stops growing and says so once, so a command that prints
   in a loop cannot fill the disk the sessions live on. The call's own result carries what was
   collected before the yield; the rest is the file's. `job action=output` reads it from a cursor.
4. **The end is a message.** When the command exits, the record settles and the conversation gets a
   `<job id status exit command>` notice with the last 4 000 chars, through the same door as a
   sub-agent's return: it wakes the conversation when it is at rest, and folds into the run in
   flight when there is one. The card is the return card, marked `job`.
5. **No polling.** The launch text, the notice and the `job` tool all say it. A model that sleeps
   in a loop to watch a job is the freeze this replaced, one level up.
6. **Stop takes it.** A Stop on the conversation kills its jobs, backgrounded or not; the output
   stays. A job's own `kill` is the `job` tool. The process group and the memory scope are the ones
   `docs/bash-limits.md` builds.
7. **A restart is honest.** The record is one small JSON per job under the session. At boot
   `jobs.reconcile()` walks the tree and marks every `running` record `lost` with the reason: the
   process went with the server that spawned it. No card spins forever.
8. **One owner.** A job is read and killed only by the session that started it. The id is checked
   against its shape before it becomes a path.

## Where it lives

| file | role |
|---|---|
| `src/core/jobs.ts` | the registry: records, output, settle, kill, list, reconcile, the notice text |
| `src/tools/bash.ts` | the yield, the hand-off, the wall, the file sink |
| `src/tools/job.ts` | the model's door: `output`, `list`, `kill` |
| `src/index.ts` | the sink into the conversation, Stop, the "still working" count |
| `src/components/SubAgentReturn.tsx` (app) | the card, with `mark: 'job'` |

## What is not a job yet

- A **node's** `bash` (remote machine): it is bounded at 10 minutes by the node's own tool timeout
  and the round-trip backstop, so it cannot produce the hour this fixes. Making it a job means a
  protocol frame the node client has to learn; it is the next tranche.
- `fetch` (30 s) and `web_search` (20 s): bounded, and a slow one fails loudly. A hand-off on a
  20-second budget would add a record to every call for nothing.
- `search`: a grep that outlives its 60-second wall should be narrowed, not backgrounded.
- `question` and `approval`: they wait on a person by design, and their wait already has a card.

## What it changed for the 2026-11-25 case

The sub-agent's `cargo build --workspace && cargo test --workspace` would have answered at 2
minutes with a job id, kept compiling, and dropped a card with the tail and the exit code at
minute 41 -- with the conversation free in between, and its Stop still reaching the build.
