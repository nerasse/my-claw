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

## Cost & economy

Every sub-agent (and the browser sub-agent) is extra LLM calls — real time and real money.
Spawn deliberately:

- Prefer **1-2 focused sub-agents** over a swarm. Give each a precise, bounded task
  ("find Instagram posts for clubs X, Y, Z"), not "get everything possible".
- A parallel batch of the same tool asks the user for approval **once** (concurrent prompts
  are coalesced into a single decision) — but still keep the batch small.
- For large web pages, a sub-agent should page through `fetch` with `offset` (see the
  web-browsing skill) instead of dumping whole raw pages into its context — a single huge
  page poisons the session and inflates every later call.
- Do NOT fire several near-identical `web_search` calls in one batch: the search engines
  behind SearXNG rate-limit fast, and one degraded batch suspends them for everyone. One
  well-phrased query beats four variations. If `web_search` reports "backend degraded",
  STOP searching (it enters a cooldown) — use what you already have or `fetch` known URLs.
- `delegate_browser_task` runs on ONE shared browser: calls are serialized, never launch
  them in parallel (see the web-browsing skill).

## Types

| Type | Tools | Use for |
|---|---|---|
| `research` | read, grep, find, ls, fetch, web_search, list_skills, read_skill | Exploration, analysis, web research, no filesystem changes |
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
- **One level deep only**: you (main) spawn sub-agents; sub-agents have no `spawn` tool, so they cannot spawn further
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
