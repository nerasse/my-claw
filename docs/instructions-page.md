# Instructions page

The app edits the markdown files that build the system prompt. This document states what is
reachable, what is not, and why each guard exists.

The app surfaces it per workspace: Settings > Workspaces > one workspace holds that directory's
four files and its nested `AGENTS.md`, next to the key and path themselves. There is no page that
stacks every workspace's files, and no `Instructions` entry on the settings index -- the files are
a property of a workspace, and the two used to be separate pages that never named each other.
The agent page links straight to the workspace the agent is pinned to.

## What the prompt is actually made of

`buildSystemPrompt` (`src/agent/prompt/builder.ts`) reads exactly four files, in this order:

| Layer | File | Notes |
|---|---|---|
| 0 | `CORE.md` | Falls back to a hardcoded constant when the file is missing, so the layer is never empty |
| 1 | `SOUL.md` | Persona |
| 2 | `AGENTS.md` | Workspace root only |
| 3 | `USER.md` | |

Everything else in a workspace is out of scope for this page:

- `MEMORY.md` is **generated** from `memory.db` and rewritten after every memory write
  (`src/memory/index.ts:36`). Its own header says hand-edits are additive on next boot and
  deletions are ignored. Offering it in an editor would promise an edit the server undoes.
- `SYSTEM.md` and `TOOLS.md` sit in the workspace but are read by no line of `src/`. Listing
  them as instructions would be a lie the page tells on every visit.
- `SKILL.md` files already have their own page.

Nested `AGENTS.md` are included, and editable. They are not part of the system prompt: they are
appended to tool results during a run, for the directories the tools touch
(`src/agent/prompt/nested-agents.ts`). Hiding them would leave a source of instructions invisible,
and they are instructions the owner writes like the others, so the page edits them through the
same guarded write (sha, snapshot, journal). Creation is refused: which directories carry
instructions at all is not a decision this screen can present. What a *conversation* actually read
is a different question, answered per thread in docs/session-instructions.md.

## Inheritance is the point, not a detail

Resolution goes through one ladder shared with the runtime (`resolvePromptFile`,
`src/agent/prompt/loader.ts`): the workspace's own file, then the configured source, then the
shipped template. The configured source is `config.workspacePrompts`
(docs/workspace-prompt-inheritance.md), editable **from this page** through the `...` button on
each row: the layer screen shows the whole ladder with the winning step marked, offers
`default` / a named workspace / the shipped template / `nothing` as the source, and a per-file
`off` that drops the layer even when the workspace owns the file. A named workspace only needs
the files it overrides. On this machine `sofa` has none of the four, so by default it runs
entirely on the default workspace's instructions.

The page therefore never shows "missing". It shows, per workspace and per file, either:

- **own** -- the file exists in this workspace and is what the agent reads;
- **inherited** -- the file is absent here, and the agent reads the configured source's copy;
- **fallback** -- no workspace owns the file anywhere, and the shipped template applies;
- **off** -- the workspace's policy drops this layer entirely, even if the file exists.

An inherited entry displays the content that actually applies, read-only, with the workspace it
comes from.

### Creating an override

"Create for this workspace" writes the file **pre-filled with the content that already applied**
(the inherited copy; the `docs/prompt/` template only when even that is missing, which happens
only if the owner deleted it from the default workspace).

This is deliberate: creating the file changes nothing about what the agent reads. It only turns
a resolution into a fact the user can now edit. A blank file would silently strip a layer, and a
generic template would silently replace it -- both are edits disguised as a creation.

## Concurrent writes

`AGENTS.md` is a file **the agent also writes**: the shipped template invites it to, and the
`write` tool reaches the whole workspace. Two devices can also have the editor open at once.

So a write carries the sha of the content the editor loaded, and the server refuses when the file
on disk no longer matches. Last-writer-wins would discard whatever the agent appended while the
editor sat open, with nothing on screen to suggest anything was lost. The sha is
`contentSha` (sha256, 12 hex chars) from `src/core/config-store.ts:64`, the same one the snapshot
store uses.

Creating a file sends no sha; the server refuses if the file turns out to exist. That is the same
guard for the same reason.

## Snapshots

Every write snapshots the previous content first, through `snapshot()` from `config-store.ts` --
the mechanism already protecting these four files in the default workspace
(`config-store.ts:363`) and already restorable from the app with `/config rollback`.

`artifactId` (`config-store.ts:31`) flattens absolute paths outside `MY_CLAW_DIR`, so a file in a
named workspace such as `/home/neras/dev/SOFA/AGENTS.md` snapshots correctly without any change
to the store. Note that `protectedPaths()` still only covers the default workspace: a named
workspace's files are snapshotted when written through this page, not swept by the boot pass.

## Path resolution

A device names a file with `workspace` (a key of `config.workspaces`, or `default`) and `file`
(one of the four names). Nothing else is accepted:

- `file` must be one of `CORE.md`, `SOUL.md`, `AGENTS.md`, `USER.md` -- an exact-match list, not
  a pattern, so no path fragment can travel;
- `workspace` must be `default` or an existing key of `config.workspaces`; an unknown key is
  refused rather than falling back, so a typo cannot silently edit the default workspace;
- the resolved path is checked to sit inside the workspace root, the second barrier
  `GET /skills` already uses (`src/channels/my-claw-app/skills.ts:44`).

Nested `AGENTS.md` are addressed by their index in the last `instructions.list.result`, never by
a client-supplied path.

## Scanning for nested AGENTS.md

The lazy collector used during a run has no enumeration to reuse, so the page scans. The scan is
bounded, because a workspace is an arbitrary directory the owner chose:

- depth 3 below the workspace root;
- skips `.git`, `node_modules` and every dotted directory;
- stops at 50 entries **per workspace**;
- the workspace root's own `AGENTS.md` is excluded, since it is layer 2 and already listed;
- each workspace's list is sorted by path, so the order is one a reader can follow rather than
  the filesystem's.

Without the exclusions, a workspace pointing at a Node repo would walk `node_modules`.

The cap was a single budget for the whole scan, spent in workspace order: one crowded workspace
emptied the next one's list, and nothing said so. It is per workspace now, and the ones it cut are
named in `nestedTruncated` so the page can say the list is incomplete instead of implying the
directory holds nothing more.

## Size limit

A write above 256 KB is refused. The four files together are ~10 KB in practice; the limit exists
so a device cannot push an arbitrary payload into the prompt path.

## Wire protocol

See `docs/my-claw-app-channel.md` for the frames. Errors use the `instructions` scope.

## What this page does not do

- No file creation outside the four names, and no deletion. Removing an override is not offered:
  it would silently hand three layers back to another workspace, and the rollback path already
  restores a previous content.
- No editing of a nested `AGENTS.md`. They are discovered by scanning arbitrary directories,
  which is a fine thing to read and a poor thing to write to from a phone.
- No per-agent instructions **here**. Per-agent layer selection exists, but it lives in the
  agent's own file: a `agents/<name>.md` frontmatter can declare `instructions: CORE, USER`
  (docs/file-agents.md), which intersects with the workspace policy -- a layer reaches the
  prompt only if the workspace has it on *and* the agent asks for it. This page manages the
  workspace side; the agent file editor shows a red line when a checked layer is off at the
  workspace level, so the two mechanisms never stay a mystery.
