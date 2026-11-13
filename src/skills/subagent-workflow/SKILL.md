---
name: subagent-workflow
description: When and how to use sub-agents effectively for parallel, isolated, or complex tasks
---

# Sub-Agent Workflow

Sub-agents are LLM sessions with their own history. Use them to parallelize work, keep a messy
task out of your context, or carry a long task across several messages.

## When to spawn

- **Exploration**: research a codebase, analyze logs, trace dependencies
- **Parallel work**: independent targets at once (src/ and tests/, three sites, two approaches)
- **Clean context**: a task whose intermediate noise should not pollute your session
- **Long-running work**: a persistent agent you keep driving with `send`

Not for a question one or two tool calls answer, or a task that already fits your context.

Give a short progress update before lengthy research; share useful conclusions as they become
available instead of holding the whole answer for optional follow-ups. Run independent read-only
research in parallel, not as successive blocking spawns. Keep dependent steps and edits to shared
files sequential. Do not add agents merely to fill every available slot.

## Types

| Type | Tools | Use for |
|---|---|---|
| `research` | read, search, ls, fetch, web_search, conversation_search, skills (read) | Exploration and analysis, nothing written |
| `general` | Everything except sub-agent management, skill writes, `memory`, `cron`, `workspaces`, `question`, `notify` and the raw browser tools | Execution, coding, changes |

The browser is reached with `delegate_browser_task`, never `spawn` (see the web-browsing skill).

## Quick workflow

```
spawn("review-src", "research", "run", "Review src/core/ for race conditions")
spawn("review-tests", "research", "run", "Review tests/ for missing edge cases")

spawn("explorer", "research", "session", "Map the codebase architecture")
send("subagent/explorer-a7b3", "Now analyze src/agent/ in detail")
agents(action="kill", id="subagent/explorer-a7b3")
```

- `mode: "run"`: answers once, not meant to be driven again. `mode: "session"`: persistent, the
  answer ends with the id to pass to `send`.
- `agents(action="list")` shows what this conversation can reach, and whether each is `running`
  or `idle`.
- **A sub-agent that was stopped or failed keeps its work.** Its result says so and names it:
  `send(id)` with no message resumes it where it stopped. Never spawn a new one for the same task.
- Parameters (`workspaceDir`, `visibility`, `model`), sends with attachments, reset and kill:
  read `references/workflow.md`.

## Background: a spawn never waits

`spawn`, `send` and `delegate_browser_task` return as soon as the child is working, with its id.
The answer comes back later as a turn of this conversation, tagged `<subagent id=… status=…>`:
the run that launched it may well be over by then, and the return wakes the conversation.

- **Do not poll.** No `agents(action="list")` loop, no sleep-and-check, no spawning a second agent
  for the same task. End your turn, or do work that does not overlap.
- **A return is not the owner talking.** It says so itself; treat it as a report, then act on it.
- **`wait: true`** blocks the call and gives you the answer inline. Use it only when the next step
  cannot start without the result: a cron job, one step of a browser chain, a task whose output is
  the whole point of the turn. A fan-out that fires three agents and waits for all three is not
  that: fire three background spawns and let the returns come.
- **A Stop of the conversation stops its background children too**, and their cards settle as
  terminated. A child working on its own can still be stopped from its own thread or card.
- Peak parallelism is what the owner asked for: background is how you use it without blocking.

## Limits

- **No cap** on concurrent runs, of any type, the browser included.
- A background child survives the end of the run that launched it, but not a server restart: after
  a reboot its card reads interrupted and `send` resumes it.
- **One level deep**: sub-agents have no `spawn`, so they cannot spawn further.
- Persistent sub-agents survive restarts: after a reboot they show as idle and `send` resumes.

## Cost

Every sub-agent is extra LLM calls, real time and money: give each one a precise, bounded task,
and keep web research economical. Read `references/economy.md` before a large fan-out or a
batch of web searches.
