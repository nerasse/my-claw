---
name: workspaces
description: Create, configure, reorganize and switch my-claw workspaces with the workspaces tool, after interviewing the owner about what they want
---

# Workspaces

A workspace is a directory that roots a run: the filesystem tools (`bash`, `read`, `write`,
`ls`, `find`, `grep`) resolve paths against it, the prompt files (CORE.md, SOUL.md, AGENTS.md,
USER.md) are read from it, and its own `skills/` and `agents/` tiers live inside it. The
default workspace is `~/.my-claw/workspace`; `config.workspaces` declares named ones.

## When to Use

- The owner wants a project isolated in its own directory with its own prompts and skills
- The owner asks to create, rename, repoint, remove or list workspaces
- The owner asks to run the current conversation in a different workspace
- You are scaffolding a new project and need to decide where the work happens

## Discovery — ask the owner first

Never guess. Interview the owner before creating or changing anything. Ask:

1. **Purpose** — what will live in this workspace? Is a named workspace even needed, or is the default one right?
2. **Key** — short name: lowercase, digits, `-`, `_`; must start with a letter or digit. Reserved: `default`, `builtin`, `none`.
3. **Path** — absolute directory. It is created if missing; it may be anywhere on disk.
4. **Prompt files** — which of CORE.md, SOUL.md, AGENTS.md, USER.md should the workspace override? Everything missing falls back through the inheritance ladder.
5. **Inheritance** — should a missing prompt file come from the default workspace (normal), another named workspace, the shipped template, or nothing? (See `references/prompt-inheritance.md`.)
6. **Skills and agents** — any workspace-tier `skills/` or `agents/` to create with it?
7. **Current conversation** — should this conversation switch to the new workspace?

Propose defaults for everything and confirm before writing. One question batch is better than one per message.

## Quick Workflow

1. Run the Q&A above and agree on key, path and overrides.
2. Create with the tool:
   `workspaces(action="create", key="sofa", path="/home/neras/dev/SOFA")`
3. Scaffold what was agreed: `skills/`, `agents/`, prompt files — with `bash`/`write`, inside the new directory.
4. If the owner wants it, switch the conversation: `workspaces(action="switch", key="sofa")`.
5. Report the resulting list: `workspaces(action="list")`.

## Tool Reference

- `list` — every workspace (key, path, default marker, current conversation).
- `switch {key}` — moves **this conversation** to another workspace, from the next run onward. History stays; nothing is moved on disk.
- `create {key, path}` — declares a named workspace and creates the directory.
- `rename {from, to}` — renames a key; agent pins are rewritten with it. The directory is not moved.
- `path {key, path}` — repoints a key at a different directory.
- `remove {key}` — deletes the declaration; the directory is **not** deleted. Agent pins that referenced it stay and are flagged red in the app.

The default workspace can never be created, renamed, removed or repointed through the tool.
Changes apply without restart (hot reload). The tool is orchestrator-only.

## References

- `references/prompt-inheritance.md` — the fallback ladder and `config.workspacePrompts` policies
- `references/structure.md` — what lives inside a workspace vs what stays global
