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

## search: the default is paths, not lines

Measured on 2026-08-23, over one sub-agent asked to inspect two repositories: **304 tool calls,
3.4 M characters of tool output, roughly 864 000 tokens**. It was not looping -- 300 of 304 results
were distinct, and 95 % of its searches returned something. It was simply being answered too
loudly.

Three numbers explain it, and each is a design fault rather than a model fault:

| observed | cause |
| --- | --- |
| `filesOnly` used **0 times out of 256** | it was opt-in, so it was never discovered |
| `context` requested **214 times out of 256** | it was free, and nothing said it was expensive |
| 53 results at exactly **60 053 chars** | the agent-loop ceiling, hit repeatedly and silently |

A single broad `content` search cost about 15 000 tokens. The agent then had to narrow and search
again, which is the correct strategy and which it paid for twice.

**What the field does.** Claude Code's `Grep` exposes `output_mode: content | files_with_matches |
count` and defaults to **`files_with_matches`** -- paths only, content on request -- with a
`head_limit` defaulting to 250 and an explicit `[Showing results with pagination = ...]` footer when
it cuts. opencode's V1 grep caps at 100 matches, leads with `Found N matches`, and closes a
truncated result with `(Results truncated. Consider using a more specific path or pattern.)`;
neither of its engines offers context lines at all. Both agree on the shape: **cheap by default,
counted, and loud about being cut.**

So:

- **`mode` replaces `filesOnly`**, with `files` as the default. `count` gives matches per file,
  `content` gives the lines. The description says outright that a broad `content` search is the most
  expensive call the agent can make.
- **Every mode leads with a count** (`1 284 match(es) in 63 file(s)`). Without it a model handed 250
  lines cannot tell whether it saw everything or a fifth, so it either trusts a partial answer or
  re-runs wider -- both of which were observed.
- **`limit` defaults to 250**, and being cut is stated with the true total and a way out: narrow the
  glob, deepen the path, or go back to `files` first.
- **`context` is honoured in `content` mode only.** grep drops `-C` beside `-l` and `-c` silently,
  and a model that believes it asked for context reads a truncated answer as a complete one.
- **Each line is clipped at 500 chars.** One hit inside a minified bundle was otherwise the whole
  result.

The prior fix in this area is the same story: `search` shelled out to plain `grep`, which is BRE, so
`(alpha|beta)` was matched as an eleven-character literal and answered "No matches found" on a file
containing both words. See `docs/context-pruning.md`.

## The file surface: write creates, apply_patch edits, search finds

Measured on 2026-08-15, over a session that shipped three releases: nearly every file operation went
through `bash`, and the file tools were barely touched. Not a preference, a consequence.

- **There was no way to edit a file.** `write` replaces the whole thing, so changing three lines in a
  2700-line file meant re-emitting 2700 lines: expensive, and one hallucinated line anywhere in the
  file destroys the rest. The agent's actual workaround was a `python3` heredoc through `bash`, with
  a hand-written `assert s.count(anchor) == 1` before each replacement. That is an edit tool,
  reinvented per call, untested, with no atomic write and no config snapshot.
- **`grep` and `find` were strict subsets of their shell equivalents.** No context lines, no name
  filter, no files-only mode, so any real search fell back to `bash grep -A 20`. (Both were folded
  into `search`; its output discipline is the section above.)

What the field does. Anthropic's Claude Code keeps `Read`, `Write`, `Edit`, `Grep` and `Glob` as
first-class tools next to `Bash`, precisely so edits are anchored replacements and searches are
bounded and available to read-only modes. OpenAI's Codex goes further and exposes exactly two:
`shell` and `apply_patch` (a V4A diff), with exploration left to the shell. Both agree on the part
that matters here: **no serious agent edits a file by rewriting it**, and the edit tool is a patch.

The choice made, given the Claude SDK is the engine and Claude models are post-trained on the
Claude Code surface:

- **`apply_patch`** takes `{ path, edits: [{ old, new, all? }] }`. Anchored text, never line numbers,
  which drift between the read and the write. The anchor must be unique unless `all` is set; an
  ambiguous or missing anchor is refused with the count and the line numbers, and **nothing is
  written** (a half-applied patch leaves a file that is neither version). All edits of a call apply
  or none does, then one atomic write, with the same tracked-file snapshot `write` takes.
- **`write` creates**. An existing file is refused with a pointer to `apply_patch`, unless
  `overwrite: true` says the full replacement is deliberate.
- **`search` replaces `grep` and `find`** (one tool, not two): `pattern` searches contents,
  `glob` filters them or, alone, lists files by name, plus `context`, `filesOnly` and `ignoreCase`.
  It is kept rather than folded into `bash` for two reasons: research sub-agents have no `bash` at
  all (`READ_ONLY_TOOLS`), and the tool bounds its own output where a piped shell search does not.

`bash` stays unconfined by design: it is the escape hatch, and it is the only tool that does not go
through `resolveWorkspacePath`. Tightening the file tools does not sandbox anything as long as it is
there; that is a separate decision, not a side effect of this one.
