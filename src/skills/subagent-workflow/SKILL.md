---
name: subagent-workflow
description: When and how to use sub-agents effectively for parallel, isolated, or complex tasks
---

# Sub-Agent Workflow

Sub-agents are isolated LLM sessions with their own history. Use them to parallelize work, isolate context, or run complex multi-step tasks.

## When to Spawn

- **Complex exploration** — research a codebase, analyze logs, trace dependencies
- **Parallel work** — analyze src/ and tests/ simultaneously, compare two approaches
- **Clean context** — messy task you do not want polluting your main session history
- **Long-running tracking** — preserve intermediate state across multiple messages

## When NOT to Spawn

- Simple question answerable in 1-2 tool calls
- Single `read` or `bash` is sufficient
- The task fits in your current context without bloat

## Types

| Type | Tools | Use for |
|---|---|---|
| `research` | read, grep, find, ls, fetch | Exploration, analysis, no filesystem changes |
| `general` | All tools (bash, write, memory...) | Execution, coding, modifications |

## Workflow

1. **Spawn** : `spawn(name, type, mode, task, workspaceDir?)`
   - `mode: "run"` — one-shot, auto-deleted after. Use for simple isolated tasks.
   - `mode: "session"` — persistent, keeps history. Returns ID like `subagent/explorer-a7b3`.
   - `workspaceDir` — optional absolute path. Sub-agent filesystem tools resolve here instead of shared workspace.

2. **Send** : `send(id, message, attachments?)`
   - Continues the conversation. Full history preserved.
   - Attachments: `[{path, type}]` to pass images, videos, documents.
   - Concurrent sends to the same sub-agent queue automatically.

3. **List / Monitor** : `list_agents()` to see status (`running` or `idle`).

4. **Kill / Reset** : `kill_agent(id)` deletes permanently. `reset_agent(id)` archives history and starts fresh (keeps name, type, workspaceDir).

## Limits

- Max **3 concurrent** one-shot runs globally
- Max spawn **depth: 2** (you -> sub-agent -> sub-sub-agent)
- Sub-agent sessions auto-truncate at **500 messages** (keeps last 50)
- **Unlimited** persistent sub-agents on disk

## Example

```
// Parallel code review
spawn("review-src", "research", "run", "Review src/core/ for race conditions")
spawn("review-tests", "research", "run", "Review tests/ for missing edge cases")

// Persistent explorer
spawn("code-explorer", "research", "session", "Map the codebase architecture")
send("subagent/code-explorer-a7b3", "Now analyze src/agent/ in detail")
send("subagent/code-explorer-a7b3", "Check for TODO comments", [{path: "/tmp/scan.png", type: "image"}])
kill_agent("subagent/code-explorer-a7b3")
```

## Reboot Safety

Persistent sub-agents survive restarts. After a reboot, `list_agents()` shows them as idle, and `send()` resumes from where it left off.
