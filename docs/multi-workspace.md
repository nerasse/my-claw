# Multi-Workspace

A workspace is a directory the agent treats as its working area: the filesystem tools are
rooted there, the prompt files (SOUL.md, AGENTS.md, USER.md, CORE.md) are read from it, and
the workspace skills live in its `skills/` subdirectory.

Historically there is exactly one workspace, `config.workspace` (default
`~/.my-claw/workspace`), resolved at boot and reboot-bound. Multi-workspace adds a *list* of
named workspaces so that cron jobs can run inside a specific project directory, each with its
own prompt files, skills and cwd, without restarting the server.

## Configuration

```json
{
  "workspace": "/home/neras/dev/my-claw-workspace",
  "workspaces": {
    "sofa": "/home/neras/dev/SOFA",
    "smartlink": "/home/neras/dev/smartlink"
  }
}
```

Rules:

- `workspaces` is a map of `name -> absolute path`. Relative paths are rejected at boot.
- The key `default` is reserved and rejected: the default workspace is `config.workspace`.
- Each entry is `mkdir -p`'d at boot. No template seeding: secondary workspaces only get the
  files the user authors there, and everything missing falls back to the default workspace.
- `workspaces` is hot-reloadable (`HOT_OBJECT_SECTIONS`). Adding a key re-scans the skill
  layers without a restart. `config.workspace` stays reboot-bound as before.

## Sessions are bound to a workspace

A session is created with a workspace and never changes it. There is no `workspaceOverride`
knob: the workspace is a property of the conversation, like its platform, not a setting.
This keeps the SDK session resume, the prompt cache prefix and the announced skill set
coherent for the whole lifetime of the session.

- `SessionData.workspace?: string` holds the workspace key (the default workspace when
  absent). Stored with the session, never mutated after creation.
- Old sessions without the field resolve to the default workspace. No migration.
- Changing a cron job's workspace does not migrate its session: cron runs are ephemeral
  anyway (see below).

## Per-file prompt resolution with fallback

Prompt files are resolved per file: the file is read from the session's workspace when it
exists, otherwise from the default workspace. A secondary workspace therefore only needs the
files it actually overrides (typically `AGENTS.md`), and still gets the owner's persona and
core directives.

`loadPromptFile`, `loadAllPromptFiles` and `loadCorePrompt` take an explicit
`workspaceDir`/`defaultWorkspaceDir`. The mtime cache is already keyed on absolute paths, so
multiple workspaces coexist in the cache without extra work.

## Skills are workspace-aware

Skills come from three tiers (built-in, custom, workspace). With multiple workspaces, the
*workspace* tier becomes one layer per workspace key.

- `Skill.workspace?: string` records which workspace a `workspace`-source skill belongs to.
- Resolution per workspace: built-in < custom < the skills of *that* workspace. The same
  name in workspace A and workspace B no longer collides globally.
- `registry.list(scope, workspace?)` returns built-in + custom + the skills of that
  workspace; `retrieval` (suggestions) filters on the same workspace.
- The watcher monitors every workspace skills directory; reload remains a full re-scan of
  all layers.

## Sub-agents inherit the parent run's workspace

`spawn.ts` validates its `workspaceDir` argument against the calling run's workspace (the
`__workspaceDir` already injected into tool args), not against the process environment, and
the spawned sub-agent runs with the parent's workspace.

## Cron runs are ephemeral and per-run

Each cron run creates a fresh session `cron/<jobId>/<runId>` seeded with the job's model and
workspace key, and deletes it after the run (success or failure). A job's run never inherits
the history of the previous one.

- `CronJob.workspace?: string` references a **key** from `config.workspaces`, never a path.
  Moving a project = one line in the config, no job edit.
- An unknown key pauses the job with a `pausedReason`; it never runs silently in the default
  workspace.
- Per-run durability lives in the job record (`lastStatus`, `lastError`, `lastRunAt`) and the
  output store; nothing depends on session continuity. See `docs/cron.md`.

## What stays global

These remain in the default workspace or in `~/.my-claw` and are deliberately **not**
split per workspace:

- Memory: the SQLite database lives in `~/.my-claw/memory.db`; its `MEMORY.md` view is
  written to the default workspace.
- Analytics (`analytics.db`), conversations (`conversations.db`), session attachments
  (`~/.my-claw/files/`).
