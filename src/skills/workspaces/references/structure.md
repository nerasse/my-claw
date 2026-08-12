# What lives in a workspace

## Inside each workspace

```
<workspace>/
├── CORE.md SOUL.md AGENTS.md USER.md   # prompt files, only the ones it overrides
├── skills/<name>/SKILL.md              # workspace-tier skills, one directory each
├── agents/<name>.md                    # workspace-tier file-defined agents
└── ...                                 # the project itself (the owner's files)
```

- The filesystem tools root here: relative paths resolve against the workspace root, and
  `bash` spawns with it as cwd. Absolute paths must stay inside the workspace (or the
  attachment root).
- Skills come from three tiers: built-in, custom (`~/.my-claw/skills/`), then the
  **workspace's own** `skills/`. Same name in two workspaces never collides.
- Agents work the same way: built-in, custom (`~/.my-claw/agents/`), then the workspace's
  `agents/`. A higher tier **replaces** a lower one wholesale.

## Seeding rules

- The default workspace is seeded with the prompt templates at first boot.
- Named workspaces get **no seeding**: they only get the files the owner authors there, and
  everything missing falls back through the prompt ladder.
- `workspaces(action="create")` creates the directory but seeds nothing — scaffold only
  what the Q&A agreed on.

## What stays global (deliberately not split per workspace)

- Memory: SQLite in `~/.my-claw/memory.db`; the MEMORY.md view is written to the default
  workspace.
- Analytics (`analytics.db`), the conversation archive (`conversations.db`), session
  attachments (`~/.my-claw/files/`).
- `config.workspace` itself: the default workspace directory is reboot-bound.

## Rules worth repeating

- Keys: lowercase letters, digits, `-`, `_`; must not start with `-` or `_`. Reserved:
  `default`, `builtin`, `none`.
- Paths must be absolute; the directory is created when missing.
- Removing a workspace never deletes its directory, only the declaration.
- Renaming a workspace key does not move the directory.
