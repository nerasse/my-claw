---
name: agents
description: Create and edit file-defined sub-agents (agents/*.md) with the right frontmatter, after interviewing the owner about what the agent is for
---

# File-Defined Agents

A sub-agent is one file, `agents/<name>.md`: a prompt with a flat `key: value` frontmatter.
The name **is** the filename — there is no `name` field. The loader watches the tiers, so a
new or edited file applies within ~300 ms, no restart.

## When to Use

- The owner wants a reusable sub-agent (a persona, a specialist, a narrowed toolset)
- The owner asks to create, edit or delete a file-defined agent
- A project needs its own agent inside a workspace (`<workspace>/agents/`)

## Discovery — ask the owner first

Interview the owner before writing anything. Ask about:

1. **Name** — filename without `.md`: lowercase letters/digits, single hyphens between
   (`^[a-z0-9]+(-[a-z0-9]+)*$`), max 64 chars. Reserved and refused: `orchestrator`, `cron`, `main`.
2. **Description** — one line, <= 1024 chars. This is what the orchestrator reads in the
   spawn catalog to decide whether to use the agent: it is the most important field.
3. **Base** — `general` (default) or `research` (read-only). See `references/baselines.md`.
4. **Tools** — which tools it may use. The list **intersects** the baseline, it never adds
   to it: an agent file can only narrow, never widen.
5. **Skills / MCP** — scope: absent (inherit), `all`, `*`, `none`, or comma-separated names.
6. **Workspace** — a `config.workspaces` key the agent runs in (see the workspaces skill).
7. **Model, maxIterations, contextCap** — optional pins; an unknown model id is dropped
   with a warning and the default applies.
8. **Instructions layers** — which prompt layers to include: any of `CORE, SOUL, AGENTS,
   USER`, or `none`. Default: all four.
9. **The prompt itself** — what the agent is, what it may do, how it reports.

## Quick Workflow

1. Run the Q&A above and agree on the fields and the prompt.
2. Write the file with `write`: `~/.my-claw/agents/<name>.md` (global) or
   `<workspace>/agents/<name>.md` (project-only).
3. Verify it registered: `/agents` lists it, and `spawn` accepts the name.
4. Fix what the loader rejected (watch for warnings in the logs: invalid name, reserved
   name, missing description, too large).

## Format

```markdown
---
description: Reviews a diff and reports risks, without touching the tree
base: research
tools: read, grep, find, ls
skills: code-review
---

You review code. Report findings ordered by severity.
```

Flat frontmatter only: one `key: value` per line, no nesting, no lists. Everything except
`description` is optional. See `references/frontmatter.md` for every field.

## Rules and traps

- **Override is replacement**: `~/.my-claw/agents/general.md` does not patch the built-in
  `general`; it becomes `general` wholesale. To change one field, restate the rest.
- Tiers: built-in < custom (`~/.my-claw/agents/`) < workspace (`<workspace>/agents/`).
  Higher tier wins; shadowing is logged.
- Caps: 50 agents per tier, 64 KB per file, description truncated at 1024 chars.
- A file that stops parsing keeps its last good version (the watcher logs it).
- The orchestrator is not a file: its instructions are the workspace prompt files.
- `spawn` shows only spawnable agents of the current workspace; `/agents` lists everything.

## References

- `references/frontmatter.md` — every field, one by one
- `references/baselines.md` — what the `general` and `research` baselines allow
