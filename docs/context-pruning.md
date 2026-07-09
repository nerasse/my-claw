# Context Pruning & Auto-Compaction

## Why

Long iterative sessions (media renders, builds, debugging) accumulate verbose tool
outputs — ffmpeg/libx264 stats, pip logs, raw web pages — that stay in the history
forever and are re-sent on every LLM call. A real Matrix session reached 25.6M
cumulative prompt tokens (378 calls, 4.6K -> 280K tokens/call) with ~90% of the
per-call weight being dead tool results from turns the conversation had moved past.

The existing safeties never fire in practice: `trimToContextWindow` only acts at the
hard context limit (430K configured), and `compactSession` is manual-only (`/compact`).

## Decisions

Two-stage pipeline: deterministic first, LLM second. The agent keeps full autonomy —
data leaves the *prompt*, never the world: anything pruned can be re-fetched by
re-running a tool, and the session file on disk keeps everything.

### Stage 1 — Tool-result pruning (every call, free)

- Applied at prompt-build time, on the in-flight `ChatMessage[]` only. The persisted
  session (`session.messages`) is never mutated: audit and `/compact` still see full data.
- Tool results older than the last `keepLastAssistantTurns` assistant turns (default 5)
  are replaced by their first `headChars` chars (default 200) plus an explicit marker
  telling the model the output was pruned and can be re-fetched by re-running the tool.
- Small results are exempt: pruning only pays when it saves at least 256 chars over
  the kept head — stubbing a 180-char result would *add* tokens.
- Never touched: the system prompt, user messages, assistant messages, and every tool
  result inside the protected recent-turns window. Runs shorter than the window are
  untouched.
- Applied on every loop iteration, so it also follows long single runs (90-iteration
  budgets): the window slides as the run grows.

### Stage 2 — Auto-compaction (rare, threshold-gated)

- Checked once per run, at run start, main agent only (depth 0, non-cron). Run start is
  the only moment the session is guaranteed idle — compacting mid-run would race the
  tool loop; compacting post-run would race the next inbound message.
- Trigger: estimated history tokens > `thresholdRatio` (default 0.8) of the model
  context limit. 80% and not 100% because the estimation is a chars/4 heuristic
  (±15%), the response needs output room, and the request must still succeed *before*
  compaction can help — at 100% the API rejects first.
- Reuses `compactSession` as-is (LLM summarization, head/tail kept, refusal detection).
  A compaction failure is logged and never blocks the run.
- `/compact` stays available for manual use.

### Configuration

```json
"context": {
  "pruning": { "enabled": true, "keepLastAssistantTurns": 5, "headChars": 200 },
  "autoCompact": { "enabled": true, "thresholdRatio": 0.8 }
}
```

Both stages default to enabled. `context` is hot-reloadable (read live per run).

### Rejected alternatives

- Truncating at tool-execution time: the current turn *needs* the full output
  (debugging ffmpeg stderr is the point of running it).
- LLM summarization per tool result: cost, latency, non-determinism at every call.
- Hard instructions forcing quiet commands: replaced by a soft core-prompt guidance
  (prefer `-hide_banner -loglevel error`, `pip -q` for known-noisy commands) — the
  agent stays free to go verbose when debugging.

## Scope and limits

- Pruning counts *assistant messages* as turns; parallel tool calls within a turn are
  protected or pruned together with their turn.
- The head kept by the stub is informational, not guaranteed to contain the useful
  part of the output.
- Auto-compaction estimates tokens with the same chars/4 heuristic as trimming; it is
  a soft gate, `trimToContextWindow` remains the hard fallback at the limit.
- Sub-agents inherit pruning (same bridge loop) but not auto-compaction (their
  sessions are short-lived and reset).

## Where

- `src/agent/context-pruning.ts` — pure pruning function
- `src/agent/bridge.ts` — pruning applied each iteration; auto-compact check at run start
- `src/sessions/compaction.ts` — unchanged, reused by the auto trigger
- `src/core/config.ts` — `ContextConfig` types, defaults, resolvers
- `src/core/config-watcher.ts` — `context` registered hot-reloadable
- `src/agent/prompt/core-prompts.ts` — output-hygiene guidance line
- `tests/agent/context-pruning.test.ts`, `tests/agent/bridge-context.test.ts`
