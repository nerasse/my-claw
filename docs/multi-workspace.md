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
  files the user authors there, and everything missing falls back to the default workspace by
  default. That fallback is configurable per file through `config.workspacePrompts`
  (docs/workspace-prompt-inheritance.md): a workspace can read a missing file from another
  named workspace, from the shipped template, or from nothing at all.
- `workspaces` is hot-reloadable (`HOT_OBJECT_SECTIONS`). Adding a key re-scans the skill
  layers without a restart. `config.workspace` stays reboot-bound as before.

## Sessions are bound to a workspace

A session is created with a workspace, and keeps it by default. A conversation's workspace
can be changed afterwards — from the app (the per-conversation menu) or by the orchestrator
through the `workspaces` tool — and the switch applies from the next run onward: the history
already produced stays whatever workspace produced it, and only the turns that follow run in
the new one.

- `SessionData.workspace?: string` holds the workspace key (the default workspace when
  absent). Stored with the session; a switch rewrites the field and persists immediately.
- Old sessions without the field resolve to the default workspace. No migration.
- The app picks a workspace for a new conversation before its first message; the server
  creates the session eagerly on `session.workspace.set`, so the choice survives until the
  first `chat.send`.
- Changing a cron job's workspace does not migrate its session: cron runs are ephemeral
  anyway (see below).

### Where the workspace comes from

Resolved once, when the session is created, in this order:

1. An explicit request — the app's workspace picker for a new conversation, a cron job's
   `workspace` key.
2. The agent's configured workspace — `agents.<type>.workspace`.
3. The default workspace.

A config change therefore moves **new** sessions only; a per-conversation switch is the
explicit, stored exception described above.

## Per-agent workspaces

`AgentConfig` already carries per-agent scoping (`llm`, `context`, `skills`, `mcp`);
`workspace` is the same shape:

```json
"agents": {
  "research": { "workspace": "sofa" },
  "cron": { "workspace": "smartlink" }
}
```

Any run of that agent type — including a sub-agent spawned as that type — is created in that
workspace, with its prompt files, its skills and its cwd. An unknown key fails loudly rather
than falling back to the default: boot reports it like an unknown scope entry, and a run that
resolves it throws instead of silently working in the wrong directory.

### Config may escape the parent workspace, a tool argument may not

`spawn`'s `workspaceDir` argument stays confined to the calling run's workspace: it is written
by the agent, and letting it point anywhere would make the boundary decorative. A workspace
configured under `agents.<type>` is written by the owner, so it *is* allowed to sit outside the
parent's workspace — that is the whole point of pinning an agent to a project. The confinement
check therefore runs against the sub-agent's own resolved workspace, not the parent's.

## Per-file prompt resolution with fallback

Prompt files are resolved per file, through one ladder shared by the runtime and the
instructions page (`resolvePromptFile`, `src/agent/prompt/loader.ts`): the workspace's own
file, then the configured source, then the last known good, then the shipped template. A
secondary workspace therefore only needs the files it actually overrides (typically
`AGENTS.md`), and still gets the owner's persona and core directives.

The configured source comes from `config.workspacePrompts`, keyed by workspace and by prompt
file name. Absent policy means "default", which is what every workspace did before the section
existed. The source is one hop only: only the source workspace's *own* file is read, never its
own inheritance, so cycles are impossible by construction. `"builtin"` reads the shipped
template as the source, `"none"` ends the ladder with an empty layer, and a per-file `off`
drops the layer even when the workspace owns the file (CORE.md's hardcoded fallback included).
See docs/workspace-prompt-inheritance.md.

The loader options are the resolved workspace dirs plus the run's workspace key and the two
config sections; the mtime cache is keyed on absolute paths, so multiple workspaces coexist in
the cache without extra work.

## Skills are workspace-aware

Skills come from three tiers (built-in, custom, workspace). With multiple workspaces, the
*workspace* tier becomes one layer per workspace key.

- `Skill.workspace?: string` records which workspace a `workspace`-source skill belongs to.
- Resolution per workspace: built-in < custom < the skills of *that* workspace. The same
  name in workspace A and workspace B no longer collides globally.
- `registry.list(scope, workspace?)` returns built-in + custom + the skills of that
  workspace, **resolved**: one entry per name, the workspace layer shadowing the global one
  exactly like `get()`. Listing both would put the same name twice in the prompt with two
  different descriptions, for a `read_skill` that can only return the workspace one.
  `retrieval` (suggestions) is fed by that list, so it inherits the resolution.
- `registry.listAll()` is the opposite and stays unresolved: it is the browse catalog of the
  app's skills page, which has to show the shadowed copies to be editable.
- The watcher monitors every workspace skills directory; reload remains a full re-scan of
  all layers.

## Sub-agents inherit the parent run's workspace

`spawn.ts` validates its `workspaceDir` argument against the calling run's workspace (the
`__workspaceDir` already injected into tool args), not against the process environment, and
the spawned sub-agent runs with the parent's workspace.

The browser agent too (`delegate_browser_task`), and it now reads that workspace's AGENTS.md and
skills: a browser task started from a `career` conversation or job knows the rules of an
application without the brief repeating them. See `docs/browser.md`, "What the browser agent is
told".

## Cron runs are kept per run, and per job

Each cron run creates a fresh session `cron/<jobId>/<runTs>` seeded with the job's model,
workspace key and a title (`<job name> · <run time>`). The session **survives** the run: the
app lists a job's runs (`jobs.runs`) and can reopen one as a chat, read it and answer on it.
The per-job retention keeps the 25 most recent runs and prunes the rest; the global session
retention still applies on top.

- `CronJob.workspace?: string` references a **key** from `config.workspaces`, never a path.
  Moving a project = one line in the config, no job edit.
- An unknown key pauses the job with a `pausedReason`; it never runs silently in the default
  workspace.
- Per-run durability lives in the job record (`lastStatus`, `lastError`, `lastRunAt`, and the
  last run's start, duration, model and cost), the output store, and the run session itself. See
  `docs/cron.md`.
- Jobs run side by side, so two jobs of one workspace can overlap. Each run is told which other job
  of its workspace is running, and to re-read a file before changing it with a targeted edit. A job
  never overlaps itself. See `docs/cron.md`.

## What stays global

These remain in the default workspace or in `~/.my-claw` and are deliberately **not**
split per workspace:

- Memory: the SQLite database lives in `~/.my-claw/memory.db`; its `MEMORY.md` view is
  written to the default workspace.
- Analytics (`analytics.db`), conversations (`conversations.db`), session attachments
  (`~/.my-claw/files/`).
