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

### An MCP server is never on the critical path

Three rules, each of them a fault that was there:

- **Boot does not wait for it.** The dynamic provider is read per call, so a server that connects a
  second late is simply in the next tool list. Awaiting the sync put every declared server on the
  path of the boot: one unreachable host meant no channels at all until it gave up.
- **`connect()` has a deadline** (15 s, handshake and first `listTools` alike). The SDK has none of
  its own, so a stdio server that starts and says nothing hung whoever awaited it.
- **A peer that goes away is noticed.** `onclose`/`onerror` drop the entry, mark the server
  `failed`, and arm a jittered reconnect (5 s doubling to 5 min). Without them a stdio server that
  exited kept its tools listed and every call failed one at a time until the next restart. A retry
  that fires after the server left the config, or after its wiring changed, does nothing: it
  re-reads what is declared before dialling.

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

### Its environment is built by name, not inherited

`Bun.spawn` without `env` hands the child the whole process environment. On a host that loads its
keys from an `.env` -- this one does -- that meant every provider credential was one `echo` away,
and the model is what writes the commands: a page it was asked to summarise only has to suggest
one.

So the child gets a base that makes a shell a shell (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`,
`TMPDIR`, `LANG`, `TZ`, `PWD`, `MY_CLAW_DIR`, plus `LC_*` and `XDG_*`), and then exactly the
service tokens named in `tools.bashEnvPassthrough` -- by default the Forgejo and Nextcloud ones,
which is what the skills actually drive. The LLM keys are not among them and there is no reason
for them to be: nothing in a shell calls a provider API by hand, the transports do that
in-process.

This is not a sandbox. `bash` can still read `/etc/my-claw/.env` if it is told to, and that is the
escape hatch working as designed. What it removes is the accident: a credential sitting in the
environment of every command, waiting for one `env` to print it.

## fetch speaks http and https, and nothing else

`fetch` used to hand any URL to the runtime's `fetch`, which speaks more schemes than the tool
was ever meant to. `fetch("file:///home/neras/.my-claw/config.json")` returned the file. That is
a filesystem read, outside the workspace, with no approval, and it was available to a `research`
sub-agent whose whole point is that it has no filesystem tool. A hostile page reaches it without
the model's help: a `302` to `file:///etc/passwd` is followed by the redirect loop, not typed by
anyone.

The scheme is now an allowlist (`http:`, `https:`), checked on the URL the model passes **and on
every `Location`** along the way. `isPrivateUrl` refuses a foreign scheme too, so the browser
tools that share that gate inherit the same answer. Local files have a tool already: `read`.

### The address guard, and why a DNS failure now blocks

`resolveAndCheckUrl` resolves the hostname and refuses private space. Three ranges were missing
and one of them is the homelab's own: **`100.64.0.0/10`**, which is what Tailscale hands every
node, plus `198.18/15` (benchmarking) and everything from `224.0.0.0` up (multicast and reserved).
`64:ff9b::/96` carries an IPv4 loopback across a NAT64 translator.

A lookup that throws used to be allowed through, on the reasoning that the fetch would fail
anyway. It does not follow: the resolver that failed here is not the resolver inside `fetch`
(different cache, different `/etc/hosts`, different timing), and the gap between the two answers
is the whole of a rebinding attack. It fails closed.

The cost is that the guard needs a resolver, and the default test suite must never need the
network. `setHostResolver` is the seam, swapped through `tests/helpers/mock-dns.ts`: a test about
the tool gets one public address for every name, a test about the guard supplies its own.

What this still does not close: the name is resolved twice, once here and once by `fetch`, and Bun
offers no way to pin the address between the two.
