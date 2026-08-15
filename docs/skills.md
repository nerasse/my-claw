# Skills System

my-claw uses a hybrid skill system with three levels: built-in (versioned in repo), custom (user-managed), and workspace (agent-generated).

## Architecture

```
my-claw/src/skills/           # Built-in skills (versioned in repo)
~/.my-claw/skills/.builtin/   # Auto-synced copy of built-in skills (managed)
~/.my-claw/skills/            # Custom skills (user-created manually)
~/.my-claw/workspace/skills/  # Workspace skills (agent-created)
```

## Format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: skill-name
description: Short description of what this skill does
version: 1.0.0
---

# Instructions

Detailed markdown instructions for the agent.
```

### Multi-File Skills

Skills can reference additional files in subdirectories. The agent reads them on demand via `read_skill(name, file_path)`.

```
skill-name/
├── SKILL.md              # Entry point (required)
├── references/           # Optional: detailed docs
│   └── format.md
├── examples/             # Optional: sample outputs
│   └── minimal.md
└── scripts/              # Optional: executable helpers
    └── helper.sh
```

Reference files from SKILL.md using relative paths:

```markdown
## References

- Detailed format: read `references/format.md`
- Minimal example: read `examples/minimal.md`
```

## Resolution Priority

When multiple skills share the same name, the following priority applies, **per workspace**
(see `docs/multi-workspace.md`):

1. The run's workspace (`<workspace>/skills/` for the default, each `config.workspaces` entry
   for a named one) — highest
2. **Custom** (`~/.my-claw/skills/`)
3. **Built-in** (`~/.my-claw/skills/.builtin/`) — lowest

A skill in workspace A never shadows the same name in workspace B: resolution happens inside
the workspace of the run, and a secondary workspace never sees the default workspace's skills.

The priority applies to the *listing* as much as to the lookup: `registry.list()` returns one
entry per name, so a name never appears twice in the system prompt. The only unresolved view is
`registry.listAll()`, the app's browse catalog, which shows every layer on purpose and annotates
each entry with `overriddenIn` (the workspaces masking a global skill) or `overrides` (the global
tier a workspace skill masks).

## Moving a Skill Between Tiers

A skill is a *directory*, so moving one is a recursive copy of the folder, never a file write.
The app does it from the skill page (`skills.copy` / `skills.move`, see
`docs/my-claw-app-channel.md`); by hand it is a plain `cp -r` into the target `skills/` dir,
picked up by the watcher.

- **Promote** (workspace to custom) is the answer to "this skill is useful in two projects".
  Duplicating it into each workspace makes two copies that drift apart in silence.
- **Fork** (built-in to custom or to a workspace) is the way to diverge from a shipped skill:
  the copy shadows the original, which stays intact and keeps being resynced.
- The built-in tier is copy-*from* only. Writing into it is undone by the next boot's hash
  resync, and deleting from it brings the skill back on that same resync.
- After a move, check the SKILL.md for absolute paths pointing at the old workspace: the file
  travels, the paths it names do not.

This allows users and agents to override built-in skills without modifying the repository.

## Auto-Update of Built-in Skills

At startup, my-claw compares the skills in `src/skills/` (repo) against the cached copy in `~/.my-claw/skills/.builtin/`:

- New skills are copied.
- Modified skills (SHA256 hash mismatch) are overwritten.
- Removed skills are deleted from the cache.
- A `manifest.json` tracks hashes and sync timestamps.

Built-in skills are **read-only** for the agent. The agent cannot modify or delete them.

## Live Reload (no restart)

An `fs.watch` (`src/skills/watcher.ts`) watches the custom and workspace skill tiers: dropping in a new
`SKILL.md`, editing one, or deleting a skill refreshes the registry automatically, effective on the next
run. The agent can also force a rescan with `manage_skills(action='reload')`. The built-in tier is synced
at boot only. Bun's recursive watch is unreliable on Linux, so the watcher tracks each tier dir plus every
skill subdir. See `docs/hot-reload-extensions.md`.

A reload rebuilds the registry wholesale, so a skill edited into a broken frontmatter used to just
vanish. The loader now keeps the last version of each `SKILL.md` that parsed and logs the retention;
a skill whose *file* is deleted still disappears, since that is a removal rather than a mistake.
`manage_skills(action='update')` also re-parses its own output before reporting success, so a skill
can no longer delete itself by corrupting the frontmatter it copies over. Custom and workspace
`SKILL.md` files are snapshotted (`docs/config-backup.md`).

## Prompt Injection

Only the **skill index** (name + description) is injected into the system prompt on every run. The full skill content is loaded on-demand via the `read_skill` tool. This keeps the context window light while making all skills discoverable.

```
# Available skills

- skill-builder: Build high-quality reusable skills with progressive disclosure and multi-file references
- git-workflow: Advanced git operations and branching strategies

Before replying, scan the skills above. If a skill matches your task,
you MUST call read_skill(name) to load its full instructions.
```

## Tools

| Tool | Description |
|---|---|
| `list_skills()` | List all available skills with source |
| `read_skill(name, file_path?)` | Load full content of a skill. If `file_path` is provided, reads a specific file within the skill directory (e.g., `references/format.md`). Replaces `${SKILL_DIR}` with the absolute skill directory path in the returned content. |
| `manage_skills(action, name?, description?, instructions?)` | Manage skills: `create` (needs name + description + instructions), `update` (needs name + instructions), `delete` (needs name), `reload` (no args). Auto-refreshes registry after create/update/delete. |
| `/reload-skills` | User command to force rescan all skills from disk |

## Scripts in Skills

Skills may contain executable scripts in a `scripts/` directory. Reference them in `SKILL.md` using the `${SKILL_DIR}` placeholder:

```markdown
Run the analysis: `bash python3 ${SKILL_DIR}/scripts/analyze.py`
```

When `read_skill("my-skill")` is called, the returned content has `${SKILL_DIR}` replaced with the absolute path to the skill directory, allowing the agent to execute scripts directly.

## Sub-Agent Sharing

Skills are **global** and shared between the main agent and all sub-agents. A sub-agent spawned with `workspaceDir=/tmp/project` still has access to all skills. Only filesystem tools (`read`, `write`, `apply_patch`, `bash`, `ls`, `search`) are scoped to `workspaceDir`.

## Future Extensibility

### Gating

The `SkillMeta` type includes a reserved `requires` field for future gating:

```ts
interface SkillMeta {
  // ...
  requires?: { bins?: string[]; env?: string[]; platform?: string[] };
}
```

When implemented, skills could be conditionally shown based on installed binaries, environment variables, or the host platform.

### Token Budget / Compact Mode

If the number of skills grows large enough to impact the context window, a compact mode can be implemented where only skill names (no descriptions) are shown, or pagination can be added to `list_skills(offset)`.

## Notes

- The system is compatible with the [Agent Skills](https://agentskills.io) standard, meaning skills from Claude Code (`~/.claude/skills/`) and Codex (`~/.codex/skills/`) should work without modification.
- Built-in skills shipped with my-claw:
  - `skill-builder` — Meta-skill teaching the agent how to create high-quality skills with progressive disclosure and multi-file references.
