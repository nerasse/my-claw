# Tool telemetry

What a tool is worth is not whether it ran but what the model made of it. A call the model was told
had failed costs a turn even when nothing was wrong: the model reasons about a broken tool, retries,
or routes around it through bash. This file is the record of how that is measured, the false
failures the first measure found, and what was decided about them.

## The measure (2026-10-25)

60 days of conversation logs, 1 632 sessions, read with a one-off script over every `ToolEntry`:

| Tool | Calls | Failed |
|---|---|---|
| bash | 64 215 | 3.0 % |
| apply_patch | 5 486 | 5.1 % |
| read | 3 458 | 2.1 % |
| write | 2 344 | 4.3 % |
| search | 1 741 | 3.2 % |
| ls | 577 | 11.6 % |

Bash is used for reading and searching (66 % of its calls), then for editing through Python,
heredocs and `sed -i` (16 %). After a failed `apply_patch`, the next call was `apply_patch` again
141 times and `bash` 122 times.

Three things in it were not the model's fault.

### A failed tool lost its output (2026-06-07 to 2026-10-25)

`AgentBridge.executeTool` turned a failed `ToolResult` into `Error: ${error ?? output}`. Bash is the
one tool that sets both, so from 2026-06-07 every failed command reached the model as
`Command failed with exit code N. Check STDERR above for details.`, with nothing above it: no
stdout, no stderr. The model was told to read an output it was never given.

The failure now carries both, error first: `Error: <error>\n\n<output>`. The bash error no longer
says "above".

### A search that found nothing was a failure

`grep`, `rg` and `git grep` exit 1 when nothing matches. 780 of the 1 159 bash calls that "failed
with exit code 1" were exactly that: a search with an empty answer, reported as a broken command.
`diff`, `cmp` and `git diff --quiet` exit 1 when the inputs differ, with the differences on stdout.

`exitOneMeaning` (`src/tools/bash.ts`) reads the last simple command of the line, the one whose
status the shell returns, and an exit 1 with nothing on stderr from one of those is a success:
`outcome: "no-match"` or `"differ"`, and the output ends with `[exit 1: no match]` so the model
still sees the status. Quote-aware (`rg 'a|b'` is one command), redirections are not separators
(`2>&1`), `VAR=x`, `sudo`, `timeout N` and `git -C dir` are stepped over. Anything it cannot read
plainly (a loop, `grep -q x && echo y`, a function) stays a failure: the rule only ever errs
towards calling a failure a failure. Claude Code made the same call in 2.1.144.

### An unchanged block refused the whole patch

The first cause of `apply_patch` failures was `edits[i] changes nothing: old and new are
identical`: 94 times, the two strings byte for byte the same, 84 of them inside a batch of two
edits or more. The model includes a block as context, the batch is all-or-nothing, and the real
edits beside it were refused with it.

An edit whose `old` equals its `new` is now skipped and named (`edits[1]: old and new are
identical, skipped`), and the others apply; the result carries `outcome: "noop-skipped"`. A batch
made only of such edits is still refused: the model believes it changed something, and saying
nothing happened is the useful answer.

## The recorder

`tool_calls` in `analytics.db`, one row per call the model made (`src/analytics/tool-calls.ts`):

| Column | |
|---|---|
| `timestamp`, `session_id`, `caller` | when, which conversation, `orchestrator` or `subagent` |
| `tool`, `ok`, `duration_ms` | what the model was told: a failure here is a failure it read |
| `outcome` | `ToolResult.outcome`: a success read out of an exit that looked like a failure |
| `error` | the failure's kind: first line, paths, ids and long numbers taken out. Never the output |

Written by `AgentBridge` right after `executeTool`, so every path that reaches the model is
counted and nothing else is.

### The backfill

The logs already hold every past call (`ToolEntry`: name, ok, duration, what the model was told),
so the history does not start the day the recorder shipped. At boot, off the boot path, the logs
are read once into the table: one transaction with the flag that says it is done, so an
interrupted pass leaves nothing and the next boot starts again. The cutoff between the backfill
and the live recorder is written the first time the table exists and never moves, so a restart
halfway can neither count a call twice nor lose one.

Those rows have no `outcome` (nothing set one before) and their bash errors still say "Check STDERR
above": the before and after of the fixes above are both on the page, which is the point.

### The page

Statistics, tab **Tools**: per tool, the calls, the failure rate, what the model did next after a
failure (`retried`: the same tool again in the same conversation; `switched`: another tool), the
successes read out of an exit 1, and the three most frequent failure kinds. The filter reaches
the tools by conversation and by source only; set to a model or a workspace, the tab answers for
the whole window and says so.

## Not done yet, on purpose

Measured ideas, kept here until there is a reason to spend on them.

**An edit benchmark.** `oh-my-pi/packages/typescript-edit-benchmark` (MIT, fixtures included,
cloned in `~/dev/oh-my-pi`) takes real files, injects mechanical bugs (a swapped operator, a removed
guard) and checks the agent puts them back. Run against variants of the edit tool -- the current
one, bash only, a hashline variant where every line read carries a short hash and an edit names
the hash instead of copying the text -- on three or four models, three runs each. That is where
"anchored edit vs patch vs bash vs hashline" gets decided rather than argued. Reference: Can Bölük,
"The Harness Problem" (2026-02): over 16 models, a patch format was the worst for 14, hashline beat
exact replacement on most, by up to 10x on the weakest models. Cost there: about $300 for 16 models
x 3 formats; ours would be smaller.

**A harness benchmark.** Two existing benches take an adapter: `openbench` (same model, different
harness: Codex, Pi, OpenCode, Cursor; its finding is that success saturates and speed and tokens
separate the harnesses, up to 4x and 8x) and Harness-Bench (106 offline assistant-style tasks,
closer to what my-claw does; part of its score is an LLM judge). Once one runs, ablations: no
`search`, bash only, no `ls`. At least three runs per cell, Wilson intervals, and a gap counts only
when the intervals separate. Worth doing only if the edit benchmark shows differences worth
chasing.
