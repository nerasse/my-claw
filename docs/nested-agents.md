# Nested AGENTS.md (subtree instructions)

Status: implemented, on both engines (home loop and Claude Agent SDK).

## Why

Today a single `AGENTS.md` is loaded once, from the workspace root, into the system
prompt at run start (`src/agent/prompt/builder.ts`, `loader.ts`). That is enough when
everything the agent does lives directly under the workspace root. It is not enough when
the agent descends into a subtree (a checked-out project, a package in a monorepo) that
carries its own conventions: those local rules are never seen.

The industry convention (agents.md spec, OpenAI Codex, Claude Code) is hierarchical:
the agent reads the `AGENTS.md` files on the path from a project root down to the file it
is touching, closest file last (highest priority). This spec brings that behaviour to
my-claw in a lazy, context-aware way: local instructions are surfaced only when the agent
actually works in that subtree, not preloaded up front.

## Decisions

### Lazy, on tool execution -- not preloaded

The root `AGENTS.md` stays in the system prompt (unchanged). Nested files are discovered
at the moment a tool touches a path and injected by appending to that tool's result, the
same channel already used to surface local context. Preloading every `AGENTS.md` in the
workspace was rejected: it wastes context on subtrees the run never visits and does not
generalise to arbitrary external repos.

### Two trigger paths, by signal reliability

- File tools (`read`, `write`, `apply_patch`, `ls`, `search`) expose an explicit `path` argument.
  This is a deterministic signal: the target directory is `dirname(resolvedPath)`. These
  tools are workspace-locked (`src/tools/workspace.ts`), so this path only ever fires for
  subtrees inside the workspace. This is the primary, reliable trigger. A path that does not
  exist yet still counts: `write` is about to create it, and the rules of the tree it lands in
  are what the model needs beforehand.
- `bash` is stateless: each call spawns a fresh shell with `cwd = workspace`
  (`src/tools/bash.ts`), so a `cd` never persists across calls and there is no working
  directory to track. It exposes an optional `workdir` parameter (the pattern OpenAI Codex
  and Aider use): the model declares the directory, bash spawns with that `cwd`, and the
  parameter doubles as the discovery signal. That is also a real functional gain, since a
  stateless bash otherwise only reaches a subtree through `cd X && ...` on one line.
- `spawn` exposes `workspaceDir`: a sub-agent given a tree works in it for its whole life.
- **The command text itself**, because the parameter built for this is not what the model
  reaches for. Measured over one run on 2026-08-15, 1162 bash calls: `workdir` used **0**
  times, a leading `cd` in 768 (66%), and an existing path elsewhere in the command in
  another 384 (33%), invisible to the old rule. Two additions close that gap:
  - every `cd <path>` in the command, not only a leading one (`make && cd sub && test`),
  - any token holding a slash that **resolves to something that exists on disk**.

  The original design rejected "a shell lexer over arbitrary tokens" over false positives
  like `search "path/to/file"`. The filesystem settles it: a token is kept only if it
  exists, so a false positive is by construction a real directory the command names, which
  is exactly the signal wanted. Sed programs (`s/foo/bar/`), URLs and globs resolve to
  nothing and are dropped. Bounded by 60 stat calls per command and 4 directories per call,
  all in-process against the inode cache, negligible next to spawning a shell.

  Still rejected: a persistent shell (breaks the parallel tool-call model in
  `src/agent/bridge.ts`, complicates abort/kill) and a `pwd` sentinel (fragile output
  parsing).

### Walk boundary: git root

From the target directory, walk up until a directory containing `.git` is found (the
project root), then stop. If no `.git` is found before the filesystem root (or before
leaving the workspace), stop at that edge. Git root is the intuitive project boundary and
avoids walking into `/home` or `/`.

### Chain root -> dir, closest last

Collect every `AGENTS.md` from the git root down to the target directory and inject them
in order, root first, closest last (closest has highest priority). This mirrors Codex's
concatenation model and is more faithful than closest-only for projects that layer rules
across levels. The workspace-root `AGENTS.md` is excluded from the chain: it is already in
the system prompt, injecting it again would duplicate it.

### Precedence

Core directives (hardcoded `CORE_PROMPT`) and the user prompt always win. Then, most
specific first: nested `AGENTS.md` closest to the file > parent nested files > workspace
root `AGENTS.md` > global. Local instructions extend or locally override; they can never
neutralise core rules. The injected block states this explicitly.

### Untrusted content: normalisation

A nested `AGENTS.md` can come from an external repository the agent cloned or was pointed
at. It is untrusted input and MUST pass through `normalizeUntrusted()` (already applied to
the root files) before injection. This is the main security difference from tools that
assume a trusted local codebase.

### Byte budget

Total nested content injected per run is capped (`agents.nested.maxBytes`, default 32 KiB,
same order as Codex `project_doc_max_bytes`). Once the cap is reached, further files are
skipped for the rest of the run. Protects the context window (mimo has a limited window).

### Dedup per run, keyed on the real file

A run-local `Set` tracks already-injected files, keyed on `realpathSync`: the same
instructions reached through a symlink, or through two spellings of one path (`~/dev/x` and
`/home/me/dev/x`), are one file and must not be paid for twice out of the same budget. Each
nested `AGENTS.md` is injected at most once per run. The set lives as a local variable in the `reply` loop, NOT
on the `session` object -- the session is persisted to disk as JSON and this state is
transient. A new run that touches the same subtree re-injects (cheap, and picks up edits).

### Both engines, same behaviour

The collector is built per run by each backend and reads from disk every time, so editing a
nested `AGENTS.md` mid-conversation applies from the next message on either engine. The
Claude Agent SDK subprocess stays hermetic (`settingSources: []`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`): it never loads `CLAUDE.md` or `.claude/settings.json`
by itself. Nested instructions reach it only through this collector, so one mechanism
governs both engines instead of two divergent ones.

## Scope and limits

- No `@import` / file-reference expansion.
- No path-scoped glob rules (`.claude/rules`-style).
- No persistent shell: bash stays stateless per call; `workdir` is per-call, not tracked
  across calls. This preserves the parallel tool-call model and simple abort/kill.
- Sub-agents inherit the same mechanism (including the browser sub-agent where it runs
  tools with paths).
- Disable with `agents.nested.enabled: false` -> only the workspace-root `AGENTS.md` is
  used, i.e. today's behaviour.
- Config is hot-reloadable.

## Config

```jsonc
{
  "agents": {
    "nested": {
      "enabled": true,      // default true
      "maxBytes": 32768     // per-run cap on total injected nested bytes
    }
  }
}
```

## Where

- `src/tools/bash.ts` -- optional `workdir` parameter: resolved against the workspace, used
  as the spawn `cwd` (falls back to workspace root). Documented in the tool description so
  the model sets it when operating in a subtree.
- `src/agent/prompt/nested-agents.ts` -- `extractTargetDirs` per tool (`path` for file tools,
  `workspaceDir` for spawn, `workdir` plus every `cd` plus existing path tokens for bash),
  git-root walk, chain collection, and the `NestedAgentsCollector` holding the realpath dedup
  set, byte budget, `normalizeUntrusted` and block formatting. One call may name several trees;
  their chains are concatenated in order and deduped.
- `src/agent/bridge.ts` -- home loop: collector built per `reply`, block appended to the
  tool result after the `transform:tool:result` hook. The collector's `onInject` records each
  file into `session.nestedAgents`: the dedup set is run-local, so without that trace nothing
  outside the tool result itself would ever say which local rules a conversation picked up.
  See docs/session-instructions.md.
- `src/agent/claude-sdk/backend.ts` + `tools.ts` -- SDK backend: the collector travels on
  the per-run `SdkRunContext` and is appended at the same point, right after the same hook.
- `src/core/config.ts` -- `agents.nested` (`nestedAgentsEnabled`,
  `resolveNestedAgentsMaxBytes`), defaults, hot-reload section registration.
- `docs/config.md` -- documents `agents.nested`.
