# Hooks / Event System

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

> WHY: Single-tenant project, single dev. One unified event bus covers 100% of needs without the complexity of Hermes' 3 systems or OpenClaw's 2 systems.
> Three execution patterns: void (fire-and-forget parallel), gate (sequential, can block), waterfall (sequential, transforms data).
> 96 hooks (84 void + 7 gate + 5 waterfall) instrument the entire lifecycle from app boot to message delivery.

## Architecture

```
src/hooks/
  types.ts    -- typed event maps for all 96 hooks
  bus.ts      -- HookBus with on/off/emit, gate/check, tap/transform
  index.ts    -- exports hooks singleton + types
```

### Execution patterns

| Pattern | When to use | Execution | Can modify? | Can cancel? |
|---------|-------------|-----------|-------------|-------------|
| **void** | Logging, analytics, side-effects | Parallel (`Promise.all`) | No | No |
| **gate** | Rate limiting, approval, blocking | Sequential | No | Yes (short-circuit) |
| **waterfall** | Transform prompts, redact output | Sequential | Yes (chain) | No |

### Error handling

All hooks are fail-safe. Errors are caught, logged, never propagated.
- Gate errors = fail-open (operation allowed)
- Waterfall errors = passthrough (value unchanged)
- Void errors = other handlers continue

## Usage

```typescript
import { hooks } from "./hooks/index.ts";

// Observe
hooks.on("agent:run:finish", (payload) => {
  console.log(`Turn done: ${payload.iterations} iterations, ${payload.toolExecutions} tools`);
});

// Block
hooks.gate("gate:tool:before", ({ toolName }) => {
  if (toolName === "bash" && isWeekend()) {
    return { allow: false, reason: "No shell commands on weekends" };
  }
  return { allow: true };
});

// Transform
hooks.tap("transform:system:prompt", ({ prompt, sessionId }) => {
  return { prompt: prompt + "\n\n[Injected context for " + sessionId + "]", sessionId, model: "gpt-4" };
});
```

## Event catalog

### App lifecycle
- `app:ready` -- all channels started
- `app:shutdown` -- SIGINT/SIGTERM received
- `app:error` -- unhandled rejection or uncaught exception
- `config:fallback` -- `config.json` was unusable at boot and a snapshot was loaded instead
  (`docs/config-backup.md`); carries the snapshot `ref` and the parse `error`

### Message lifecycle
- `message:received` -- raw message from channel adapter
- `message:preprocessed` -- after audio/video processing
- `message:route:start` -- before agent handle
- `message:injected` -- mid-run steering: the message joined an in-flight run instead of
  starting its own, so it gets no delivery of its own
- `message:queued` -- the message is parked behind a compaction; the my-claw-app channel turns
  it into a `chat.send.queued` frame so the wait is visible on the bubble
- `message:route:complete` -- after response generated
- `message:route:error` -- routing threw exception
- `message:delivered` -- response sent to channel

### Agent lifecycle
- `agent:run:start` -- before system prompt built
- `agent:prompt:built` -- after buildSystemPrompt
- `agent:turn:start` -- each LLM iteration begins
- `agent:turn:end` -- each LLM iteration ends
- `agent:run:finish` -- final text response ready
- `agent:run:error` -- exception during agent loop
- `agent:run:aborted` -- run stopped by user (`/stop`)
- `agent:budget:exhausted` -- max iterations reached

### LLM lifecycle
- `llm:call:start` -- before fetch to LLM API
- `llm:call:end` -- after LLM response parsed
- `llm:call:error` -- retryable or final error
- `llm:circuit:opened` -- 5 consecutive failures
- `llm:circuit:closed` -- successful call resets failures

### Tool lifecycle
- `tool:execute:start` -- before tool.run()
- `tool:execute:end` -- tool returned successfully
- `tool:execute:error` -- tool threw or returned error
- `tool:approval:check` -- approval decision made
- `tool:bash:execute` -- bash command finished
- `tool:file:write` -- file written
- `tool:file:read` -- file read
- `tool:fetch:request` -- HTTP request completed

### Session lifecycle
- `session:created` -- new session on disk
- `session:loaded` -- existing session loaded from disk
- `session:persisted` -- session saved to disk
- `session:cleared` -- history emptied in place
- `session:archived` -- session file moved to archive
- `session:evicted` -- LRU cache eviction
- `session:compact:start/end/error` -- context compaction (local summarizer only)
- `session:compact:settled` -- the summarizer stopped, whatever the outcome. Emitted from a
  `finally`, so it is the one end no exit path skips: `end` and `error` cover two of the five
  (a session too short, a summary that came back empty and an abort that rethrows are silent).
  Whoever raised something on `start` must lower it on this one (`docs/compaction.md`)
- `session:compact:finished` -- a `/compact` is over, both engines, success or not
- `session:messages:trimmed` -- overflow trim to 50
- `session:model:changed` -- /model command

### Memory lifecycle
- `memory:store` -- a fact was stored (remember/update)
- `memory:recall` -- memories retrieved for a query
- `memory:consolidate` -- background merge pass completed
- `memory:backfill` -- existing entries embedded after embeddings enabled

### Skill lifecycle
- `skills:loaded` -- initial load on boot
- `skills:reloaded` -- /reload command
- `skill:read/created/updated/deleted` -- manage_skills tool

### Subagent lifecycle
- `subagent:spawn` -- new subagent created
- `subagent:complete` -- subagent returned result
- `subagent:error` -- subagent threw exception
- `subagent:aborted` -- subagent stopped by user (`/stop`)
- `subagent:killed` -- `agents` tool, `kill`
- `subagent:reset` -- `agents` tool, `reset`

### Cron lifecycle
- `cron:tick` -- scheduler tick
- `cron:job:start/end/error` -- job execution
- `cron:job:delivered` -- result sent to chat
- `cron:job:created/updated/removed/paused/resumed/triggered` -- cron tool CRUD

### Command lifecycle
- `command:received` -- /foo parsed by session handler
- `command:handled` -- command processed, response ready

### Streaming lifecycle
- `stream:start/finish/abort` -- Telegram/Matrix streaming

### Channel lifecycle
- `channel:started/stopped/error` -- adapter boot/shutdown

## Gate events (can block)

- `gate:message:incoming` -- drop message before routing
- `gate:tool:before` -- deny tool execution
- `gate:agent:before:reply` -- short-circuit agent run
- `gate:message:outgoing` -- suppress delivery
- `gate:cron:job:before` -- skip scheduled job
- `gate:memory:write` -- block a memory write (remember/update)

## Waterfall events (transform data)

- `transform:system:prompt` -- modify system prompt before LLM
- `transform:user:content` -- modify user message before session
- `transform:tool:result` -- modify tool result before LLM
- `transform:agent:response` -- modify final response
- `transform:outgoing:message` -- modify text before channel send

## Decisions

### One system, not three
Hermes has plugin hooks + gateway events + shell hooks. OpenClaw has internal hooks + plugin hooks. MyClaw is single-tenant -- one `HookBus` covers everything.

### No filesystem hooks
No `~/.my-claw/hooks/` directory. Single-dev = code directly in `src/`. Adding filesystem loading later is 5 lines if needed.

### No priorities
Single-dev writes all handlers. Registration order is sufficient. OpenClaw needs priorities because plugins from different authors can conflict.

### 96 hooks, not 10
The cost of `hooks.emit("foo", payload)` is a Map lookup + early return when no handlers registered. Effectively free. Instrumenting everything enables adding behavior (logging, analytics, rate limiting) without touching core code.

### Cron bypass incoming gate
Cron jobs are synthetic, not user-originated. They skip `gate:message:incoming` by design. Blocking a scheduled job through an incoming-message gate would silently break scheduling.

### Gate deny is not an error
When `gate:tool:before` blocks a tool, `tool:execute:end` is emitted with `success: false`, not `tool:execute:error`. A policy deny is a deliberate decision, not a runtime failure. Monitoring needs to distinguish "blocked by policy" from "crashed".

### Fail-open gates
If a gate handler crashes, the operation is allowed. This is the safe default for a single-tenant system where custom code is trusted.
