# /stop -- Stopping a Run

## Why

A run can be long: many tool-calling iterations, sub-agents, a shell command that hangs. `/stop`
cancels the current session's run and every sub-agent it spawned (recursively), instantly and cleanly,
without affecting other sessions.

## Decisions

### One AbortController per session, one shared signal for the whole subtree

The router creates an `AbortController` per top-level session run (`runRegistry.startRoot`). The same
`signal` is threaded by reference into the LLM calls, the tools, and every sub-agent (`AgentBridge`
runs nested in-process and awaited). Aborting that one controller flips `signal.aborted` everywhere at
once, so every in-flight `fetch` (main + sub-agents + sub-sub-agents) rejects immediately.

There is no parent->child registry to walk: the shared signal *is* the cross-level link. This avoids the
class of bug where bookkeeping diverges from the real abort (a run marked "killed" while it keeps running).

The browser subagent runs its own loop (not an `AgentBridge`), so it takes the signal explicitly:
`delegate_browser_task` reads the injected `__signal` and passes it to `BrowserSubagent.run`, which
checks it at the top of each step, before each tool call, and hands it to `chatCompletion`.

### Scoped to the current session only

`runRegistry.stop(sessionId)` aborts only that session's controller. Each chat/thread has its own
controller; other sessions are untouched. The `/stop` command resolves the same deterministic
`sessionId` as the router, so it targets exactly the channel it was typed in.

### AbortedError is never swallowed

Every tool `try/catch` that would normally turn an error into a tool result calls `rethrowIfAborted`.
Otherwise a sub-agent's abort would be converted into "tool result: error" and the parent would keep
going. This is the key to making the stop actually stop. The LLM provider also treats an external abort
as terminal: no retry, no circuit-breaker trip.

### Kill the whole process group for `bash`

Shell commands run under `setsid` (own process group). On abort the group is killed
(`SIGTERM` then `SIGKILL`), so children and grandchildren die too -- no orphaned background processes.
`fetch` and `web_search` combine the run signal with their own timeout via `AbortSignal.any`.

### History is kept, dangling tool_calls are sealed

A stopped run is not rolled back: the user's message and any completed turns stay in history. If the abort
lands while an assistant `tool_calls` message has no matching tool result, `sealDanglingToolCalls` appends
a synthetic `[Stopped by user]` result so the next turn's API call stays valid.

### No interrupt-vs-/stop split

Codex/Hermes separate "interrupt current turn" from "/stop cleanup background work" because they have
backgrounded processes. MyClaw awaits every tool and sub-agent, so a single `/stop` is authoritative.

### Reply

`/stop` replies `Stopped.` if a run was cancelled, `Nothing running.` otherwise. The cancelled run
delivers no message (the router returns nothing on abort). `/status` shows the live run tree
(`Active run: main, researcher[1]`).

## Hooks

`agent:run:aborted` (per run, main and sub-agents) and `subagent:aborted` fire on stop.
