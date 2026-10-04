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

## Limits

- **No cap** on concurrent runs, of any type, the browser included.
- **One level deep**: sub-agents have no `spawn`, so they cannot spawn further.
- Persistent sub-agents survive restarts: after a reboot they show as idle and `send` resumes.

## Cost

Every sub-agent is extra LLM calls, real time and money: give each one a precise, bounded task,
and keep web research economical. Read `references/economy.md` before a large fan-out or a
batch of web searches.
