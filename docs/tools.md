# Tools -- Result Handling

## Why

Tool results are fed straight back to the model. If a result is empty or ambiguous, the model cannot
tell "the tool ran and there was nothing" from "the tool is broken" -- so it guesses, retries, and
spins. Two rules keep tool output honest.

## Decisions

### Every tool result is non-empty

`AgentBridge.executeTool` normalizes results before they reach the model:
- success with empty output -> `[tool returned an empty response]`
- failure with no message -> `Error: tool failed with no message`

An empty string as a tool result confuses some models/APIs and hides the difference between "ran,
nothing to show" (e.g. `bash` `mkdir`) and a silent failure. A single chokepoint guarantees the model
always sees an explicit marker.

### web_search distinguishes "no results" from "backend degraded"

SearXNG returns **HTTP 200 with an empty `results` array** in two very different cases: nothing was
found, OR its engines are rate-limited/down (it then lists them in `unresponsive_engines`). Treating
both as "no results" makes the agent fire query after query against a dead backend (observed: a self-
hosted instance returned empty on ~17 of ~24 queries after the first few, all in <2s).

So `web_search` inspects `unresponsive_engines`:
- empty results **+ unresponsive engines** -> `success: false` with an explicit degraded/rate-limited
  reason, telling the agent not to retry and to answer from its own knowledge or say search is down.
- empty results **+ no unresponsive engines** -> `success: true`, `No results found for this query.`
  (genuine empty, distinct signal -> the agent can rephrase).
- non-200 -> error as before.

Limitation: this relies on SearXNG populating `unresponsive_engines`. An instance that returns a clean
empty body while throttled would still look like a genuine "no results".

## Tool availability

`ToolRegistry.getForAgent(agentType, disabled)` builds each agent's tool set: per-agent exclusion lists
(research is read-only; sub-agents and cron drop orchestration tools), then the config denylist
`tools.disabled` (hot-reloadable), applied last. `setDynamicProvider` injects runtime tools -- external
MCP servers (`config.mcp`) -- surfaced to acting agents only and namespaced `mcp__<server>__<tool>`. Both
backends build from `getForAgent`, so the denylist and MCP tools apply uniformly to the home loop and the
Claude SDK. See `docs/config.md` and `docs/hot-reload-extensions.md`.
