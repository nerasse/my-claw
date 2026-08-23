# Context Pruning & Auto-Compaction

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

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
- The protected window is a **token budget**, not a turn count: walking backwards from the
  newest result, `protectTokens` (default 40000) worth of tool output is kept whole and
  everything older is stubbed. Turns were the wrong unit — five turns is a paragraph on one
  run and half a megabyte on the next, while the thing that has to fit is a budget.
- A stub keeps `headChars` (default 400) of the original, **split between head and tail**.
  Head alone was a measured mistake: a command's verdict is on its last line, so keeping only
  the opening threw away the answer and kept the preamble.
- Small results are exempt: pruning only pays when it saves at least 256 chars over
  the kept head — stubbing a 180-char result would *add* tokens.
- Never touched: the system prompt, user messages, assistant messages, and every tool
  result inside the budget. A run whose tool output fits in the budget is untouched.
- Applied on every loop iteration, so it also follows long single runs: the budget slides
  as the run grows.

#### The spill file

What leaves the stub is written to `~/.my-claw/tool-output/<sha256>.txt`, and the marker
names that path.

This replaces the old marker, which ended with *"re-run the tool if you need the full
output"*. On a measured 142-iteration run that instruction was present about 137 times: the
component whose job is to shrink the context was writing an invitation to redo completed work
into every prompt, once per pruned result. Small models took it. The marker now ends with
`read that file, do not re-run the tool` — recovering the detail is a read, which is cheap and
idempotent, instead of an execution, which is neither.

Mechanics:

- **Content-addressed.** The path is a hash of the output, so the same result stubbed on
  twenty consecutive prompt builds is written once and skipped nineteen times.
- **Only the sending path writes.** `pruneOldToolResults` takes an optional `spill` callback.
  The bridge passes one; `/status` and the app header, which run the same function purely to
  measure occupancy, pass none. Because the path is derived from the content rather than
  allocated at write time, the measured string is byte-identical to the sent string — the
  three occupancy readers stay in agreement.
- **Failures are swallowed.** An unwritable disk leaves a dead path in a marker; the prompt is
  still correct and the run still completes. It must not take a run down.
- **Swept at boot.** `sweepSpilledToolOutput()` drops spills older than seven days. They exist
  to be re-read during a run, not archived.

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
  "pruning": { "enabled": true, "protectTokens": 40000, "headChars": 400 },
  "autoCompact": { "enabled": true, "thresholdRatio": 0.8 }
}
```

Both stages default to enabled. `context` is hot-reloadable (read live per run).

### Rejected alternatives

- Truncating at tool-execution time: the current turn *needs* the full output
  (debugging ffmpeg stderr is the point of running it).
- Spilling at tool-execution time rather than at prune time: most results are never pruned
  (short, or still inside the budget), so it would put a disk write on the hot path of every
  tool call to serve the minority that outlive their usefulness.
- A turn-counted window (the original design): see above. It cannot express a budget, which
  is the actual constraint.
- LLM summarization per tool result: cost, latency, non-determinism at every call.
- Hard instructions forcing quiet commands: replaced by a soft core-prompt guidance
  (prefer `-hide_banner -loglevel error`, `pip -q` for known-noisy commands) — the
  agent stays free to go verbose when debugging.

## Stagnation: measured, not yet acted on

After the reasoning-replay work (docs/reasoning-replay.md) the remaining question was whether the
loop should detect a run that has stopped making progress and intervene. 141 runs of real history
from `sessions/` and `sessions-archive/` say: not on this evidence.

Duplicate tool *calls* were already known to be near zero on the models that wander. Duplicate tool
*results* looked much better:

| tool results in the run | median duplicate rate |
| --- | --- |
| <= 120 | 0 - 4.7 % |
| > 120 | 47.6 % |

But a detector does not see a whole run, it sees a sliding window. Scored that way the populations
overlap, and in places invert:

```
LONG  (129 results)  max barren in 10 = 7     SHORT (67 results) = 10
LONG  (163 results)  max barren in 10 = 4     SHORT (16 results) =  9
LONG  (198 results)  max barren in 10 = 8     SHORT ( 8 results) =  8
```

A healthy 8-result run saturates the count and finishes fine; the second-longest run in the corpus
peaks at 4. Any threshold fires hardest on the shortest runs and misses one pathological run in
four. With four long runs in the whole corpus, the sample cannot settle it either.

So `src/agent/stagnation.ts` measures and reports, and nothing reads it but the log. Every run
finishes with a `stagnation` block in `agent run finished`: total results, distinct results, the
worst repeat and the worst barren count inside a ten-result window. When there are enough long runs
to separate the populations, the threshold comes from the data.

What the corpus *did* settle is a different bug, since fixed: the top two repeated results in the
worst run were `No matches found` (x40) and `grep failed (exit 2): Unmatched ( or \(` (x13), and
both were the `search` tool running BRE while the model wrote ERE. See below.

## Tool output that lies

`search` shelled out to plain `grep`, which is POSIX **basic** regex: `(`, `|`, `+` and `?` are
literal characters there. A model writing `(alpha|beta)` -- ERE, as every model does -- was having
that exact eleven-character string searched for. On a file containing both words the tool answered
exit 1, "No matches found".

That is worse than an error. An error gets retried differently; a confident wrong answer gets
believed, and the model goes and looks somewhere else. Forty of them in one run.

Three changes, all in `src/tools/search.ts`:

- `grep -E`. The dialect is now the one the callers were already writing, and the tool description
  and the `pattern` schema both say so.
- A regex error names the dialect. grep says which character is unbalanced but never which flavour
  it speaks, which is the one thing the caller needs to fix it. Thirteen identical failures in one
  run is what that omission costs.
- A miss names what was searched: `No matches for "foo" in /path` instead of `No matches found`.
  The bare string gave the model no way to see it had already run that exact query.

## Scope and limits

- The budget is measured with the same chars/4 heuristic as trimming, so it is approximate.
- The head and tail kept by the stub are informational; the useful part of a long output can
  sit in the elided middle. That is what the spill file is for.
- A spill file is readable by the agent's own `read` tool because it lives under
  `~/.my-claw/`, outside the workspace but on a path the marker states explicitly.
- Auto-compaction estimates tokens with the same chars/4 heuristic as trimming; it is
  a soft gate, `trimToContextWindow` remains the hard fallback at the limit.
- Sub-agents inherit pruning (same bridge loop) but not auto-compaction (their
  sessions are short-lived and reset).

## Where

- `src/agent/context-pruning.ts` — pruning, spill write/sweep, `promptSideChat`
- `src/agent/bridge.ts` — pruning applied each iteration; auto-compact check at run start
- `src/sessions/compaction.ts` — unchanged, reused by the auto trigger
- `src/core/config.ts` — `ContextConfig` types, defaults, resolvers
- `src/core/config-watcher.ts` — `context` registered hot-reloadable
- `src/agent/prompt/core-prompts.ts` — output-hygiene guidance line
- `src/index.ts` — `sweepSpilledToolOutput()` at boot, next to the session sweep
- `tests/agent/context-pruning.test.ts`, `tests/agent/bridge-context.test.ts`
