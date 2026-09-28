# Agent roles: what a run is, and how deep sub-agents go

## The rule

A run's role decides its tools, its model chain and its iteration budget. It is read off the
**session** the run works in, never off the message that started it:

| Session | Role |
| --- | --- |
| a sub-agent (`meta.type` set) | its type: `general`, `research`, `browser`, or a file agent |
| a cron run (`cron/<job>/<ts>`) | `cron` |
| anything else | `main` |

One function says it, `agentTypeOf` (`src/sessions/store.ts`). The bridge, the dispatcher, the
compaction summarizer and the conversation archive all go through it or the same test.

Sub-agents nest at most **two deep** (`MAX_SUBAGENT_DEPTH`, `src/subagents/runner.ts`): a run's own
sub-agents are level 1, a browser task one of them delegates is level 2, and a browser task starts
nothing. The runner enforces it in `spawn`, where `spawn` and `delegate_browser_task` both arrive,
from the sessions' own parent links. A refused spawn tells the model to do the step with its own
tools or hand back what it has. The tool sets already imply the same bound; the check is there so
that bound never depends on them alone.

## Why (2026-09-28)

The role used to come from `message.platform === "cron"`. A sub-agent's message carries its root's
platform, so every sub-agent of a cron job, at any level, ran as the cron role: `spawn`, `send`,
`bash`, `delegate_browser_task`, and none of the `browser_*` tools. A browser task could therefore
not browse. It read the web-browsing skill, which says to delegate, and delegated to another browser
task, which did the same.

The morning jobs of 28/09 ran for six hours that way: chains 325 and 298 levels deep, 2,353 sub-agent
sessions in a day, 8,131 model calls, the runs waiting on a leaf that could never answer. The weekly
research of 27/09 was already in it at 45 levels when its thirty-minute wall killed it, which is what
had been blamed at the time. Research volets, meant read-only, ran `bash` 53 times each for the same
reason. The defect dates from the first cron commit; it stayed invisible until jobs started
delegating (the `career` jobs, 26/09).

Two more things only held because of it, fixed with it:

- The runner gave every sub-agent `depth = 1`, whatever its real level: nothing could have bounded
  nesting even if it had wanted to. The depth is now derived from the parent chain.
- A cron run's cost summed its direct sub-agents only (`getDelegatedModelUsage`): the browser tasks
  below them were never counted. `getTreeModelUsage` sums the whole tree, each row still counted for
  the parent recorded on it.

## What a long run tells the owner

No wall by default (docs/cron.md): a run still going is announced, and the announcement says what it
is doing, so a normal five-hour job reads as one and a run that keeps growing reads as the anomaly:

> Still running after 3 h · 4 sub-agents working, 2 levels deep · $1.80. Open it to follow it or stop it.

A run stopped from the app is `interrupted`, read off its own log, not `error`.

## Tested

- `tests/agents/agent-roles.test.ts`: the real runner and bridge, on the exact shape that failed (a
  sub-agent of a cron run, message platform `cron`): a browser task gets the browser tools and
  nothing to delegate with, a research agent stays read-only, a general agent reaches the browser but
  never spawns; a level-3 spawn is refused before anything runs, a level-2 browser task runs.
- `tests/cron/cron-robustness.test.ts`: the alert's tree, a Stop read as `interrupted`.
- `tests/analytics/tree-usage.test.ts`: the whole tree counted, nothing of another payer's.

Each fails without its fix.
