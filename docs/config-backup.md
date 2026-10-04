# Config backup and rollback

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

## Why

Config had no safety net of any kind: no backup, no history, no rollback, no schema validation
(a grep for `backup|rollback|revert|lastGood` over `src/` returned nothing). Three asymmetries
made that expensive:

1. **The hot path is fail-safe, the cold path is fatal.** The watcher catches a bad parse, logs a
   warning and keeps the running config (`config-watcher.ts:280-283`). But `loadConfig` has no
   fallback: `parseConfig` throws (`config.ts:617-622`) and the process dies. The unit is
   `Restart=always` / `RestartSec=5` with no `StartLimitBurst`
   (`packaging/templates/my-claw.service:16-17`), so a broken `config.json` is an **infinite crash
   loop** with the agent unreachable and SSH the only way back in. `bash` has no path jail
   (`tools/bash.ts:56-60`) and approval is opt-in (`agent/approvals.ts:32-33`), so the agent can
   put itself in that state.
2. **Losses are silent.** A prompt file that fails to read has its cached good content deleted and
   returns `""` (`prompt/loader.ts:38-41`) with no log line anywhere in the file: a truncated
   `SOUL.md` silently removes a prompt layer. A `SKILL.md` with broken frontmatter returns `null`
   (`skills/loader.ts:45`) and the skill vanishes from the registry. An unreadable `tools.d/` sets
   `this.tools = []` (`tools/plugins.ts:53-55`) and every plugin tool disappears.
3. **Nothing is recoverable.** There is no way to see what `AGENTS.md` looked like yesterday, or to
   undo an edit the agent made to its own instructions.

Prior art reused here: `utils/atomic-write.ts` (unique tmp + `fsync` + `rename`), the
`.prev` + config backup/restore discipline of `packaging/update.sh:264,290`, and `ModelCatalog`'s
per-provider retention of the last good value (`llm/catalog.ts:288-295`) -- the only
last-known-good pattern that already existed.

## Scope

Protected artifacts (owner-authored, small, irreplaceable):

| id | path | mode | validated |
|---|---|---|---|
| `config` | `$MY_CLAW_DIR/config.json` | 0644 | JSON + structural schema |
| `env` | `$MY_CLAW_DIR/.env` | 0600 | none (KEY=VALUE, malformed lines already skipped) |
| `prompt-<NAME>` | `<workspace>/{CORE,SOUL,AGENTS,USER}.md` | 0644 | none (raw markdown) |
| `skill-<tier>-<name>` | `$MY_CLAW_DIR/skills/*/SKILL.md`, `<workspace>/skills/*/SKILL.md` | 0644 | frontmatter parse |
| `plugin-<file>` | `$MY_CLAW_DIR/tools.d/*` | 0644 | zod `PluginMetaSchema` |
| `cron` | `$MY_CLAW_DIR/cron/jobs.json` | 0644 | JSON |

Deliberately excluded, with the reason:

- `claude/auth.json`, `codex/auth.json` -- a re-login regenerates them; backing up tokens only
  multiplies copies of secrets.
- `model-catalog.json` -- a cache of remote discovery, rebuilt by one refresh.
- `sessions/`, `memory.db`, `analytics.db` -- data, not config; large and constantly written.
- Matrix/Telegram state (`bot-storage.json`, offsets, dedupe, E2E snapshot) -- protocol state.
  Restoring an old copy would desynchronise the channel, which is worse than losing it.
- `skills/.builtin/**` -- resynced from the repo at boot by hash (`skills/sync.ts:86-129`).
- `MEMORY.md` -- regenerated from `memory.db` on every write (`memory/export.ts:51`).

## Store

```
$MY_CLAW_DIR/backups/                  0700
  journal.jsonl                        0600
  <artifactId>/
    20260727-183300123-a1b2c3d4e5f6    mode inherited from the source
    confirmed                          one line: the ref that proved it runs
    rejected/
      20260727-184102481-9f8e7d6c5b4a  the content that was refused
```

There is deliberately **no index file**. The snapshot name already carries the timestamp and the
first 12 hex of the content sha256, and the timestamp prefix sorts lexicographically, so `readdir`
plus a sort *is* the history. An index would have been a second write to keep in sync with the
directory, a second thing to purge, and a second thing to repair when torn.

- **Artifact id is the path**, relative to `$MY_CLAW_DIR` (or to the workspace for prompt files),
  with separators replaced. No id scheme, no registry of artifact kinds, no lookup table: any file is
  snapshottable by its path, and protecting one more file is one entry in a list of prefixes.
- Every write goes through `writeFileAtomically`; the snapshot inherits the source file's mode, so
  `env` snapshots are 0600 inside a 0700 directory.
- **Dedup by sha**: if the newest snapshot already has the same content hash, nothing is written.
  This is what keeps the health-gated promote silent when nothing changed.

### `confirmed` is a one-line file, not an index entry

Written through the same atomic tmp+rename as everything else, portable, and readable with `cat`. A
symlink would only have looked nicer in `ls -l`. Only the health gate below moves it.

`confirmProtected` snapshots before confirming. Dedup makes that free when the content is already
stored, and it removes the ordering dependency on the boot pass: otherwise a skipped or failed boot
snapshot would leave the gate with nothing to confirm and silently disarm the fallback.

This is the distinction the store exists for: snapshots taken before an overwrite capture whatever
happened to be on disk, which is not the same claim as "this content ran". They stay restorable by
hand and stay ineligible for the automatic fallback. Dedup makes it cheap -- when the on-disk
content is already the confirmed one, a pre-write snapshot collapses into nothing.

### Journal

`journal.jsonl` at the store root, append-only, one line per event across all artifacts:
`{ ts, event, artifact, sha, origin, changed?, rebootRequired?, actor?, error?, note? }`. Rotated by
size like `utils/logger.ts:78-96`.

`changed` / `rebootRequired` are the watcher's own diff output, already computed for
`config:reloaded` and otherwise thrown away. `actor` records session and channel when the origin is
a tool, so a self-inflicted edit is attributable.

Its reason to exist is debugging, not restoring: the directory answers "which versions of this file
do I have", the journal answers "what happened at 18:33, and what caused it". Append-only means it
never contends with anything and a torn last line costs one event, not the file.

## When a snapshot is taken

Three moments, deliberately chosen.

**Promote behind a health gate.** Loading successfully is not the same as working: a config can
parse, validate, boot, and still leave the owner with no way to reach the agent. Promoting on parse
alone would eventually record such a config as the thing to fall back *to* -- the safety net becomes
the trap. Healthy means, 60 s after a completed boot:

- the process is still alive, **and**
- at least one channel is up, if the config enables one at all. A config that enables no channel is
  healthy on uptime alone, or a deliberately channel-less setup would revert itself forever.

This mirrors `packaging/update.sh`, which already waits for the service to become healthy before
keeping a new version. Hot-reloads go through the same gate.

Channels are tracked live from `channel:started` / `channel:stopped` / `channel:error` rather than
sampled once, so a recreate that fails mid-life counts as down too.

Consequence to accept: after a fresh install there is no fallback for the first 60 s of the first
boot. There is no earlier moment at which a config has proven anything.

**Snapshot before an in-process overwrite.** `ensureAuthProvider` (`index.ts:157`),
`skills` create/update (`tools/skills.ts`), and the `write` tool
(`tools/write.ts:28`) when its resolved target is a registered artifact. `tool:file:write`
(`hooks/types.ts:155`) already exists as the hook point for the last one. These are `confirmed:
false` by construction.

**Archive the rejections.** When a parse or validation fails, the refused content is written under
`rejected/` with the error message. Today the only trace is a log line, and for a hot-reload
rejection the operator fixes the file straight away, so the failed attempt disappears with no
examinable artifact. This is what makes "why didn't my edit apply?" answerable after the fact.

## The A/B loop: reverting a config that is valid but wrong

A wrong token parses perfectly. Such a config boots, kills the channel, and locks the owner out of
the very chat commands that would fix it. Nothing about it is detectable at parse time.

The loop cannot be passive. A boot counter alone never fires here: the process does not crash, it
sits there alive with a dead channel, so there is never a second boot to count. **The health gate
itself has to act.**

At the end of the health window, when the verdict is unhealthy:

| Condition | Action | Why |
|---|---|---|
| No confirmed version, or the confirmed one is this one | warn | Nothing better to land on; restarting would trade a broken channel for no agent |
| This exact content was healthy before | warn | It worked once, so the fault is the environment. Reverting would discard the owner's later edits for a fault the config did not cause |
| No `INVOCATION_ID` in the environment | warn | No supervisor, so exiting leaves the machine with nothing |
| Otherwise, strike 1 | restart | One retry absorbs a transient failure, such as the network being down while the channel connects |
| Otherwise, strike 2 | quarantine, then restart | Two consecutive failures on the same content is a config problem |

Strikes are keyed on the content hash and reset the moment the file changes, because an edit is a
new attempt rather than a repeat of the same failure. Restart means a clean `shutdown()`:
`Restart=always` brings the process back on a clean exit too, so there is no need to fake a failure
code.

Recovery costs two health windows, roughly two and a half minutes, and ends with the channel back up
on the last config that actually worked.

### Quarantine is a verdict on a content, not on a file

The boot path and the watcher both refuse a content whose hash is quarantined -- the watcher too,
because the content parses, so nothing else would stop a stray save from undoing the revert that
just restored the channel.

**Any edit lifts it.** The marker is keyed on the hash, so changing one character makes it a new
attempt. That is the escape hatch when the owner is sure their config is right, and it is why there
is no `/config unquarantine` command to learn. The notification says so.

The file is never rewritten, here as everywhere else in this design: the agent runs the confirmed
content from memory and leaves the owner's file exactly as they wrote it.

### Telling the owner

Reverting is pointless if nobody knows. On a fallback boot the reason, the restored ref and the way
to lift the quarantine are sent to the first whitelisted id once a channel is up. Best-effort and
Telegram-only: whitelist entries are user ids, and a Matrix send needs a room id.

## Boot fallback

`loadConfig` gains a recovery path. On parse or validation failure:

1. Load the newest snapshot of `config` that parses and validates.
2. Boot on it. Log at `error`, emit `config:fallback`, and record a startup notice that the first
   channel to come up delivers to the owner.
3. **Leave the broken file exactly as it is.** The agent never rewrites a file the owner may be
   editing. Every restart re-runs the fallback until the file is fixed, and each one re-notifies.
4. With no usable snapshot, keep today's behaviour -- throw -- but say so in the message, so the
   operator knows the store was empty rather than ignored.

This is the phase that removes the crash loop, and it is worth shipping alone.

## Validation gate

A structural guard in `config.ts`, **not a schema**. It is derived from the section lists the
watcher already declares (`config-watcher.ts:34-38`): a hot object section, when present, must be a
plain object; `whitelist` / `blacklist`, when present, must be arrays. That is all.

- Every section stays **optional**. Deleting one from `config.json` stays legal and keeps its
  current meaning -- `applyObjectSection` empties the live section (`config-watcher.ts:121-122`),
  which matches what a restart would produce: no override, defaults apply. Treating a missing
  section as "no change" would have made the live state diverge from a reboot, which is the bug it
  was supposed to prevent.
- The only class this exists to catch is `"llm": "oops"`, which lands in `rec[key] = src`
  (`config-watcher.ts:126`) and both stores the garbage *and* breaks the object identity the whole
  hot-reload design depends on (`config-watcher.ts:85-88`).

A full zod schema of the config was rejected: fifteen sections of field-by-field types is a large
surface that has to be updated with every new config field, and its failure mode is to reject a
legitimate config. The guard derives from a list that already exists and cannot drift from it.

A validation failure takes the exact same route as bad JSON: `parseConfig` throws, the watcher keeps
the live config, and boot falls back to a snapshot.

Writing the guard surfaced a latent crash: `applySecretOverrides` dereferences
`config.channels.telegram`, so a `config.json` with no `channels` key at all died with an opaque
"undefined is not an object". The type declares the key as required, which is exactly why nothing ever
checked it. `parseConfig` now defaults it to `{}` alongside `whitelist` / `blacklist`.

Independently: wrap `applyHotReload` (`config-watcher.ts:285`) in try/catch. It currently sits
*between* the two guarded blocks, so a throw inside it becomes an unhandled rejection and
`index.ts:551` calls `process.exit(1)`.

## Last known good in memory

The watchers keep their previous good value instead of degrading to empty:

- **Prompt loader** -- on read failure, keep the cached content instead of `cache.delete` + `""`,
  and log a `warn`. Logged once per path per failure streak: the loader runs on every message, so
  an unconditional log would flood. This changes one edge of `loadCorePrompt`: a `CORE.md` deleted
  *after* being read now keeps serving its last content rather than dropping to the hardcoded
  `CORE_PROMPT`, which is closer to the owner's intent. A `CORE.md` that was never readable still
  falls back to the constant.
- **Skills** -- keep the last parseable version of a skill that stops parsing, and log its
  retention. Today `setAll` (`skills/registry.ts:12-14`) discards it wholesale.
- **Plugins** -- keep the last good tool set when `readdir` fails, instead of `this.tools = []`.
  Per-file zod rejection already behaves correctly and is left alone.

Retention is in-memory only and never masks the problem: each case logs, so a degraded state is
visible rather than silent.

## Atomicity gaps to close

Non-atomic writes to files that a watcher then reads, which is how a truncated file gets loaded:
`SKILL.md` (`tools/skills.ts:172,220`), `manifest.json` (`skills/sync.ts:83`),
`pending-actions.json` (`matrix/adapter.ts:1112`), `pending-approvals.json`
(`matrix/session-handlers.ts:221`), and the `write` tool (`tools/write.ts:28`). All move to
`writeFileAtomically`. `skills` update additionally re-parses its own output before
reporting success, so a skill can no longer delete itself by corrupting its frontmatter.

## Commands and hooks

Three, shaped like `channels/auth-commands.ts`:

- `/config history [artifact]` -- artifacts and their snapshots; without an argument, every artifact
- `/config diff <artifact> [ref]` -- against the current file
- `/config rollback <artifact> <ref> [section]` -- snapshots the current content as `pre-rollback`
  first, so a rollback is itself undoable, then restores atomically

`/config list` was folded into `history` with no argument, and a manual `/config snapshot` was
dropped: dedup makes it a no-op whenever the current content is already stored, which is the common
case.

The same three are reachable as `my-claw config ...` from a terminal, which is not a convenience:
the chat commands need a live channel, and a config that kills the only channel would otherwise leave
no way in. The CLI reads the workspace path straight out of the raw file rather than through
`loadConfig`, which would refuse to run on the very file being rolled back.

### Restore drives the reload itself

A restore does **not** write the file and wait for the watcher to notice. Two reasons, both
measured: a dotfile recreated after the watcher attached emits no event at all, so restoring a
deleted `.env` would apply nothing and say nothing until the next restart; and a write that lands
inside the 300 ms debounce window is indistinguishable from an editor's second save.

So the restore calls the reload path directly and returns the watcher's own `changed` /
`rebootRequired` report. That matters for correctness, not just ergonomics: rolling back a
Matrix identity field is reboot-only (`docs/config-hot-reload.md`), and the command has to say so
rather than let the operator believe it is live.

### Section-scoped rollback

`config.json` holds a dozen independent sections, so whole-file rollback would also revert
everything else changed since. With a section argument, only that subtree is taken from the snapshot
and merged into the current file, which is then written atomically. Without it, the whole file is
restored. The section path is validated against the top-level hot-reload list
(`config-watcher.ts:34-36`) so a typo cannot silently no-op.

`env` is DM-only and its values are redacted in `diff` output -- key names and change markers only.
A backup store is useless if it cannot restore secrets, but that is no reason to print them into a
channel.

One new hook in `hooks/types.ts`: `config:fallback`, the only event that needs to reach the owner.
`config:snapshot`, `config:restored` and `config:validationFailed` were dropped -- the journal already
records them and nothing would listen. They can be added the day something does.

`snapshot()` never rejects. The prompt loader and the skills loader call it fire-and-forget on a
reload, so a store failure has to degrade to "no snapshot, one log line" rather than become an
unhandled rejection that `index.ts` turns into an exit. Both of those callers also gate on
`isTracked()`, so history is kept for files the boot pass registered instead of for whatever the
current working directory happens to hold.

## Retention

20 generations or 90 days per artifact, whichever is hit first, aligned with the existing log
(`utils/logger.ts:287`) and session (`sessions/store.ts:206`) retention. Rejections keep 10
generations only -- they are a debugging aid, not a recovery path. Purge runs at boot and after each
snapshot.

**The snapshot the `confirmed` symlink points at is never purged**, whatever its age. Otherwise a
config untouched for three months would silently lose the very copy the boot fallback depends on.
Purging by position alone could leave only pre-write entries and quietly disarm the fallback.

## Accepted limitations

- `backups/` lives under `$MY_CLAW_DIR`, so the agent's own `bash` can delete it. Putting it out of
  reach would require a root-owned directory and a privileged helper; not worth it single-tenant.
  `bash` is deliberately not jailed against config paths either -- that would break legitimate
  self-administration, and snapshots make an accident recoverable.
- `.env` snapshots hold secrets in cleartext (0600, in a 0700 dir). The secret now exists in up to
  20 copies instead of one. That is the price of being able to restore it at all.
- The A/B loop only detects one symptom: no channel came up. A config that is valid and wrong in any
  other way (a bad model id, a mistaken allowlist) still boots, stays healthy by this definition, and
  gets confirmed. Snapshots make it reversible; nothing makes it detectable.
- No fallback exists during the first 60 s of the very first boot, by construction of the health
  gate.
- A config that has been healthy once is never auto-reverted, so a token revoked long after it was
  confirmed leaves the channel down until someone acts. This is deliberate: the alternative is
  reverting good configs during network outages.

## Rejected alternatives

Recorded so they are not re-proposed.

- **A redacted dump of the *effective* config** (env overlay applied, workspace resolved, discovered
  models merged) as a diagnostic artifact. It answers "why is the agent using this model" better
  than the raw file does, but it means maintaining a second serialisation plus a redactor that has
  to stay correct as secret-bearing fields are added. A leak there would be worse than the
  debugging convenience is worth. The journal covers the "what changed and when" half.
- **Unifying the four change-detection mechanisms** behind one "watched artifact" abstraction. The
  duplication is real (three separate `DEBOUNCE_MS = 300`, four different error policies), but the
  semantics genuinely differ: a directory watch for config, a two-level tier tree for skills (Bun's
  recursive `fs.watch` only fires top-level events on Linux, see `skills/watcher.ts:21-25`), a flat
  directory for plugins, and a per-read mtime check for prompts. The abstraction would need so many
  options that it would hide nothing. The four watchers stay separate; only the snapshot store is
  shared.
- **A git repo under `~/.my-claw`** for free history and diff. Cheaper in code, but adds a runtime
  binary dependency, and a secret committed to history cannot be removed, which makes per-artifact
  retention impossible.
- **Jailing `bash` against config paths.** Closes the main way the agent can corrupt its own
  config, at the cost of breaking legitimate self-administration. Snapshots plus validation make the
  accident recoverable instead, which is the better trade for a single-tenant deployment.

## Tests

- boot with a truncated `config.json` -> starts on the newest snapshot, logs `error`, emits
  `config:fallback`, broken file untouched on disk
- boot with a truncated `config.json` and an empty store -> actionable error, no stack
- structural guard: a missing section passes and still empties the live section; a wrong-typed
  section is rejected and the live config is untouched
- health gate: a config that boots then exits before 60 s is never confirmed, and the previous
  confirmed snapshot stays the fallback
- boot fallback ignores a pre-write snapshot even when it is the newest on disk
- a rejected reload is archived under `rejected/` with its error, and the live config is untouched
- journal: one line per event, and a torn last line does not make the store unreadable
- restore applies without any `fs.watch` event, including recreating a deleted `.env`
- restore of a reboot-only field reports `rebootRequired` instead of claiming it is live
- section-scoped rollback restores only that section and preserves later edits to the others
- snapshot dedup: writing identical content twice produces one snapshot
- retention: purge keeps the snapshot `confirmed` points at past 90 days, even with newer entries
- A/B: a config enabling no channel is healthy on uptime alone; one enabling a channel is not
- A/B: first unhealthy verdict retries, the second quarantines; strikes reset when the file changes
- A/B: no revert with nothing better to land on, none for content that was healthy once, none
  without a supervisor -- and none of those three paths burns a strike
- quarantine: the boot path and the watcher both refuse the hash; any edit lifts it; a quarantine
  with no confirmed alternative is dropped rather than blocking the boot
- `env` snapshot and restore preserve mode 0600
- rollback roundtrip, including the `pre-rollback` snapshot of the overwritten state
- prompt loader keeps the last good content on read failure and logs once, not per message
- skills keep the last parseable version when frontmatter breaks
