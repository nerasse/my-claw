# File-defined agents

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

Sub-agents declared by a file in `agents/`, discovered at runtime across three tiers, instead of
the closed `AGENTS` table in `src/core/config.ts`.

Read `docs/agent-scoping.md` first: it describes the scoping this builds on (per-agent skills, MCP
and tool sets). This document only covers what changes.

## Why

`AGENTS` (`src/core/config.ts:328`) claims to be "the one place the config-defaultable agents are
named", so that a new agent is "one entry, not six lists that drift". It is not true today: the set
is re-enumerated in about twenty places, `SUB_AGENT_TYPES` is a hand-written literal next to it, and
`SubAgentMeta.type` (`src/sessions/store.ts:73`) duplicates the union outright.

More importantly `AgentConfig` (`config.ts:367`) has no `prompt` field and `buildSystemPrompt` never
receives the agent type, so **an agent cannot have instructions of its own**. `general` and
`research` differ only by their tool list. The single agent with a real mandate of its own, the
browser sub-agent, had to be written as a parallel implementation to get one.

The goal is that a sub-agent is a file: a prompt, a description, and a narrowed tool set.

## Non-goals

- **No privilege widening.** A file can never grant a tool that the baseline does not already
  carry. See "The ceiling" below; this is the invariant the whole design rests on.
- **No agent-defined MCP servers or providers.** A file selects among what is configured; it does
  not declare infrastructure.
- **Not a replacement for the browser runner.** Only its prompt moves to a file. See "Browser".
- **No orchestrator prompt here.** The main agent's instructions are the workspace prompt files
  (`docs/instructions-page.md`), which the owner already edits.

## File format

One agent is **one file**, `agents/<name>.md`. Skills are directories because they carry
`references/` and `scripts/`; an agent is a prompt plus metadata and gains nothing from a directory.

```markdown
---
description: Reviews a diff and reports risks, without touching the tree
base: research
tools: read, search, ls
skills: code-review
model: anthropic/claude-sonnet-4
instructions: CORE, SOUL, USER
---

You review code. Report findings ordered by severity...
```

The body after the frontmatter is the agent's prompt.

### The name is the filename

`reviewer.md` defines the agent `reviewer`. There is **no `name` field in the frontmatter.**

Skills key the registry on the frontmatter `name` (`src/skills/loader.ts:125`) while `manage_skills`
and the app's `/skills` endpoint address them by directory name, and nothing reconciles the two: a
skill in `foo/` declaring `name: bar` is addressable one way for reading and another way for
writing. Deriving the name from the path removes the divergence by construction.

A name must match `^[a-z0-9]+(-[a-z0-9]+)*$` and be at most 64 characters. Anything else is skipped
with a warning rather than registered under a name no one can type.

### Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One line. This is what the orchestrator reads to decide whether to spawn this agent, so it is the single most load-bearing field in the file. |
| `base` | no | `general` (default) or `research`. The tool baseline this agent narrows from. |
| `tools` | no | Comma-separated tool names. Absent = the whole baseline. Intersected with the baseline, never added to it. |
| `skills` | no | Comma-separated skill names, or `*`. Same semantics as `agents.<key>.skills`. |
| `mcp` | no | Comma-separated MCP server names, or `*`. Same semantics as `agents.<key>.mcp`. |
| `model` | no | A model id from the configured providers. Unknown id = the agent loads, the field is dropped with a warning, and the default applies. |
| `workspace` | no | A workspace key from `config.workspaces`. |
| `maxIterations` | no | Positive integer. |
| `contextCap` | no | Context ceiling for this agent, `0` to lift it. Flat, because the parser has no nesting; it feeds the same resolver as `agents.<key>.context.cap`. |
| `instructions` | no | Which workspace prompt layers to include: any of `CORE`, `SOUL`, `AGENTS`, `USER`, or `none`. Default: all four, which is what every agent gets today. |

A missing `description` means the file does not define an agent, exactly as a missing
`name`/`description` means a text is not a skill.

### The parser stays flat

The skills frontmatter parser (`src/skills/loader.ts:9-41`) is a hand-rolled `key: value` reader
with no YAML dependency, no nesting and no lists. Agents reuse it. Lists are therefore
comma-separated on one line, and `contextCap` is flat rather than `context.cap`.

Adding a YAML library for one nested field would pull a dependency into the boot path to express
something a comma already expresses.

### Everything is optional except the description

A file with only a `description` and a body is a valid agent: it inherits the `general` baseline,
all skills in the orchestrator's scope, the default model, and the full workspace prompt stack. The
minimum viable agent is a prompt with a sentence saying when to use it.

## Tiers and precedence

Three tiers, scanned lowest to highest, mirroring `loadAllSkills` (`src/skills/loader.ts:132`), and
named `agents/` rather than `.agents/` for the same reason skills are named `skills/`.

A leading dot would buy nothing and cost consistency. `~/.my-claw` is already hidden, so dotting a
directory inside it only hides it from a listing of `~/.my-claw` -- next to a visible `skills/`. In a
workspace it is worse: that is the directory the agent itself works in with `ls` and `search`,
alongside a visible `AGENTS.md`, `SOUL.md` and `skills/`. `.builtin` keeps its dot, like the skills
tier, because the parent scan skips dotted entries and that is what keeps it out of the global tier.

| Tier | Directory | `source` |
| --- | --- | --- |
| built-in | `$MY_CLAW_DIR/agents/.builtin/` | `built-in` |
| global | `$MY_CLAW_DIR/agents/` | `custom` |
| workspace | `<workspace>/agents/` | `workspace` |

The built-in tier is synced from the repo's `src/agents/builtin/` at boot by SHA-256 manifest, the
way `src/skills/sync.ts` does it, and is not watched: it is a release artifact, not user content.
It is dot-prefixed so the global scan skips it.

Each entry of `config.workspaces` adds a layer, keyed by workspace like skills, so the same agent
name in two projects never collides globally.

### Override is replacement, not extension

A higher tier **replaces** a lower one wholesale. `~/.my-claw/agents/general.md` does not patch the
built-in `general`: it becomes `general`, with its own fields and its own defaults.

Field-level merging would mean a file's meaning depends on a file it never mentions, and removing a
field would be indistinguishable from never setting it. The reader would have to know three files
to know what one agent does.

The cost is real and accepted: overriding a built-in to change one line means restating the rest.

### The built-ins are files

`general` and `research` ship as `src/agents/builtin/general.md` and `research.md`. They stop being
special cases in the loader and become the first two rows of the same table as everything else,
which is the only way "override a built-in" can mean anything.

They keep the tool baselines they have today: `general` excludes `SUBAGENT_EXCLUDED_TOOLS`,
`research` is the `READ_ONLY_TOOLS` allowlist.

### Reserved names

`orchestrator`, `cron` and `main` are refused, with a warning naming the file.

They are roles, not spawnable agents: `orchestrator` is the agent the owner talks to and its prompt
is the workspace prompt stack; `cron` is a scheduling context; `main` is the tool-axis spelling of
`orchestrator`. A file claiming one of those names cannot be honoured, and silently ignoring it
would leave the author believing it took effect.

### Name collisions inside a tier

Two files cannot collide inside one tier: the name is the filename.

Across tiers the higher one wins, which is the point. Unlike `mergeSkills`, which overwrites
silently, the shadowing is logged at load: `agents/general.md shadows the built-in general`.

## How it fits together

```
  DEFINITION (what an agent is)          INSTANCE (a running agent)
  =============================          ==========================

  src/agents/builtin/*.md                spawn(type: "reviewer")
  general.md research.md browser.md              |
          |  repo -> sha256 sync at boot         v
          v                              subagents/runner.ts
  ~/.my-claw/agents/.builtin/            sessions/subagent/*.json
          |                                      |
          |  tier 1 (shipped, not watched)       |
          v                                      |
  ~/.my-claw/agents/*.md    tier 2 (yours)      |
          |                                      |
          v                                      |
  <workspace>/agents/*.md   tier 3 (project)    |
          |                                      |
          |  higher tier REPLACES lower          |
          v                                      |
   +----------------+                            |
   | AgentRegistry  |<-- watcher, 300ms debounce |
   +----------------+                            |
          |                                      |
          |  + config.json agents.<name>         |
          v                                      v
   +--------------------------------------------------+
   |  resolveAgent()  -- the one place a name          |
   |  becomes behaviour                                |
   |  config entry  >  agent file  >  built-in default |
   +--------------------------------------------------+
          |
          +--> prompt + instructions -> buildSystemPrompt()
          +--> base + tools          -> getForAgent()   (narrow only)
          +--> skills / mcp scopes   -> registries
          +--> model / workspace / maxIterations / contextCap
```

Two registries with names that look alike and must not be confused:

- `src/agents/` holds **definitions**: what an agent *is*. One entry per file.
- `src/subagents/` holds **instances**: a spawned agent's session and lifecycle. One entry per run.

Neither imports the other. `spawn` is where they meet: it reads the definition catalog to validate
the requested name, then hands the name to the runner, which stores it in the session.

### Which catalog a surface reads

| Surface | Method | Why |
| --- | --- | --- |
| `spawn` schema | `list(workspace)` | Only spawnable agents, only this workspace's. Excludes `browser`. |
| `/agents`, app page | `listAll()` | A browse surface answers "what exists", tier included. |
| `resolveAgent` | `get(name, layer)` | One agent, resolved through the workspace's layers. |
| boot validation | `names()` | Every name, to flag a config section addressing none of them. |

## Upgrading an existing install

**Nothing to align by hand.** The first boot after the upgrade does it:

1. `syncBuiltInAgents` writes `general.md`, `research.md` and `browser.md` into
   `~/.my-claw/agents/.builtin/`, creating the directory. Verified on an empty home: the three
   files appear, and a second boot re-syncs nothing because the hashes match.
2. An existing `config.json` keeps working unchanged. `agents.general`, `agents.research`,
   `agents.orchestrator` and `agents.cron` are still read, now as the **override** layer above the
   files. A legacy config with all four produces no warning.
3. `~/.my-claw/agents/` is yours to drop files into. It stays empty until you do.

The one visible behaviour change: `general` and `research` gain a short mandate of their own, which
they never had. Both were previously handed the owner's `SOUL.md` and nothing telling them they were
sub-agents. To go back to the previous behaviour, empty the body of the two files in
`~/.my-claw/agents/` -- an override with an empty body is a valid agent with no prompt.

### What the server tells you at boot

Three checks, all reports and never refusals:

- `agents.<name>` addressing neither a reserved role nor a file -> *"config sections address agents
  that do not exist"*. This is the one that catches a typo in a section name, and it covers
  file-defined agents rather than only the four reserved keys.
- `agents.<name>.skills` / `.mcp` entries matching no installed skill or declared server.
- `agents.<name>.workspace` pointing at a key absent from `config.workspaces`.

## Config still overrides files

`config.agents.<name>` keeps working and now applies to any agent, file-defined ones included. The
precedence for every resolvable field is:

```
config.agents.<name>  >  the agent file  >  the baseline default
```

Config is an **override** layer, not a definition layer: it can retune a model or a scope, it cannot
bring an agent into existence. `agents.foo.llm` with no `foo.md` anywhere is reported at boot by the
same check that already reports scope entries matching nothing (`src/core/config.ts:755`).

This keeps `/model reviewer` and the app's Agents page writing to the same place they write today,
for file agents as for built-in ones.

### Where a spawn's model comes from

`SubAgentRunner` resolves it once, through `resolveRunModel`, and hands the answer to the backend as
its `llmOverride`: the engine (SDK or home loop) is picked from that same answer, so a second chain
computed later could only disagree with the process already chosen. The steps, highest first:

```
spawn's own `model:` argument  >  the model recorded on the instance  >  config.agents.<name>.llm
  >  the agent file's `model:`  >  llm.defaultModel
```

The recorded model is what makes a `mode=session` sub-agent keep answering on the same model across
`send()`. It goes stale like a chat's pick when config moves under it, and self-heals the same way:
the run drops it and resolves the agent's own chain again. An explicit spawn argument is the
caller's, so that one fails loudly instead of being quietly replaced.

A sub-agent never inherits the *conversation's* pick. `/model` in a chat writes that chat's session
and nothing else: `general` and `research` are separate agents whose absent config entry means the
global default, not whatever the owner picked in the thread he happened to spawn from. Only `cron`
inherits the orchestrator, and from its config, never from a session.

Because the backend is handed a resolved override, it never resolves and never announces: the
runner posts the fallback notice itself, into the parent chat.

## The ceiling

**A file can only narrow a tool set. It can never widen one.**

`tools:` is intersected with the baseline named by `base:`. Naming a tool outside the baseline is
not an error that blocks the load, but the tool is dropped and the discrepancy is logged: the file
stays loadable and the agent stays inside its box.

A workspace is frequently a cloned repository. If a file could grant tools, then cloning a
repository carrying `agents/helper.md` with a full tool set and a hostile prompt would be a
privilege escalation dressed as a configuration file. With intersection only, the worst a hostile
file can do is carry a hostile prompt, which is the risk already accepted for workspace `AGENTS.md`
and workspace skills. No new class of exposure.

Two properties reinforce this: only the orchestrator can spawn (`spawn` is in both
`SUBAGENT_EXCLUDED_TOOLS` and `CRON_EXCLUDED_TOOLS`), so a file agent cannot exceed the agent that
spawned it; and workspace-tier bodies pass through `normalizeUntrusted` like every other untrusted
prompt layer.

### `getForAgent` must deny by default first

`src/tools/registry.ts:90-91` ends its `if/else` chain with:

```ts
} else {
  set = [...this.tools.values(), ...dynamic];   // "main"
}
```

An unrecognised agent type receives **the entire registry**, `spawn`, `memory`, `manage_skills` and
`cron` included. Today that is unreachable because the union is closed. The moment a name arrives
from a file, a typo in `base:` becomes a full-privilege agent.

So the chain becomes an explicit resolution where `main` is the only branch granting everything, and
an unknown agent falls back to the `general` baseline. This fix is a prerequisite, and it is worth
making on its own merits regardless of the rest.

## The prompt layer

`PromptContext` gains `agentPrompt?: string` and `instructions?: PromptLayerName[]`.

The agent's own prompt is injected **after the workspace layers (`CORE`, `SOUL`, `AGENTS`, `USER`)
and before the skills catalog**. It is more specific than the persona, so it comes later; the
skills, tools and runtime blocks stay adjacent at the end where the cacheable prefix logic
(`builder.ts:70-81`) expects them.

`instructions:` selects which workspace layers are included at all. This exists because the browser
sub-agent already needs it: `buildBrowserSystemPrompt` (`src/agent/subagents/browser.ts:111`)
deliberately drops `AGENTS.md`. Today that is expressed by a second prompt builder; it becomes one
field.

## Bounds

Skills have no size cap, no count cap and no collision warning. Those gaps are not reproduced here,
because agent metadata is not loaded on demand like a skill body: **every agent's name and
description enters the spawn tool schema on every run of the orchestrator**, so the catalog is a
recurring token cost.

| Bound | Value | Reason |
| --- | --- | --- |
| Agents per tier | 50 | The spawn enum is in every prompt. Beyond the cap, extra files are skipped with a warning rather than quietly inflating each request. |
| File size | 64 KB | A prompt, not a corpus. |
| Description length | 1024 | It rides in the tool schema. |
| Scan depth | 1 | `agents/*.md` only. No recursion. |
| Ignored | non-`.md` files, directories, dotted names | Keeps `.builtin/` out of the global tier. |
| Symlinked files | not followed | Matches the skills scan, and keeps a workspace from reaching outside itself. |

A malformed file keeps its last good version, as skills do (`loader.ts:49-51`): an agent edited into
a broken frontmatter must not vanish from `/agents` without explanation.

## Dynamic surfaces

Every place that enumerates agents today reads the registry instead. This is the "listing is
dynamic everywhere" requirement, and it is most of the work.

| Surface | Today | Becomes |
| --- | --- | --- |
| `spawn` schema | `enum: SUB_AGENT_TYPES` (`spawn.ts:26`) | enum from the registry. Already a getter, so hot-reload works with no change to the mechanism. |
| `spawn` description | `"Types: 'research' (read-only tools) or 'general' (full tools)"` (`spawn.ts:14`) | generated `name: description` list. This is how the orchestrator learns an agent exists. |
| `/agents` | hardcoded key list (`introspect-commands.ts:139`) | registry, with tier and source per agent. |
| `/model <agent>` | `TOOL_TYPE`, `ALIASES`, help text (`agent-model-commands.ts:19-34`) | registry-derived, help text generated. |
| `/model` picker | `TARGET_CODES = {o,g,r,c}` (`model-picker.ts:43`) | stable short ids. Single letters cannot survive arbitrary names, and Telegram callback data is length-bound, so the id is an index into the listing rather than an initial. |
| App `agents.config.result` | `AGENT_KEYS.map` (`index.ts:771`) | registry, each entry carrying `source` and `path`. |
| `SubAgentMeta.type` | `"general" \| "research"` (`store.ts:73`) | `string`. Existing sessions carry `general`/`research`, which stay valid names, so no migration. |

## Browser

The browser sub-agent's prompt lives in `src/agents/builtin/browser.md`, with `instructions: CORE,
SOUL, USER` expressing the `AGENTS.md` omission that used to be a hardcoded list.

It is the one agent in the registry that `spawn` does not offer: its tools live in a private
registry its own runner builds, so spawning it would produce an agent carrying the browser's prompt
and none of its tools. `AgentRegistry.list` (the spawn catalog) leaves it out while `get`,
`listAll` and `names` keep it, which is what lets `/agents`, the app and an override still see it.
That exception is a named set in the registry rather than a frontmatter field: one agent needing it
does not justify a flag every file would carry.

`BROWSER_PROMPT` survives in `src/agent/subagents/browser.ts` as the fallback, the way `CORE_PROMPT`
backs a missing `CORE.md`. The file is repo-synced at boot, but a run between a deleted file and the
next boot must not lose its instructions altogether.

**Nothing else about it moves.** It keeps its private tool registry, its own loop, the sidecar
lifecycle, the global serialisation queue for the single Chromium, the `needs_human` handoff to
noVNC and the `summarizeFindings` salvage call. Those are not agent configuration, and folding them
into the generic runner would trade a working escape hatch for uniformity.

Consequences worth stating: `browser` is still reached through `delegate_browser_task`, not `spawn`;
it still does not appear in `list_agents`; and because it calls `chatCompletion()` directly it still
cannot run on the claude-sdk backend. Editing `browser.md` changes its instructions and nothing else.

Registering the `browser_*` tools in the global registry so an ordinary file agent could request
them is a separate decision, not taken here.

## Delivery

| Lot | Content |
| --- | --- |
| L0 | `getForAgent` deny-by-default. Standalone, shippable alone. |
| L1 | `src/agents/`: types, loader, registry, reload, watcher, sync. `general` and `research` become built-in files. |
| L2 | Prompt layer, spawn enum and description, tool resolution, `SubAgentMeta.type` widening. |
| L3 | `/agents`, `/model <agent>`, the picker. |
| L4 | App channel and Agents page, with `source` and `path` per agent. |
| L5 | Browser prompt to a built-in file. |

L0 landed first and alone: it closed an existing hole and everything after it depended on the
default being safe.

## What the type widening cost

`AgentToolType` is now `string`. The exhaustiveness a closed union gave is replaced by `resolveAgent`
being the only place a name becomes behaviour, plus two guards that make a wrong name harmless
rather than dangerous:

- `getForAgent` grants the full registry to `main` alone; every unrecognised name lands on the
  sub-agent baseline.
- `resolveAgent` keeps a name that is itself a baseline (`research`) on that baseline even with no
  file on disk, so the read-only guarantee does not depend on a sync having run.

`SUB_AGENT_TYPES` and `SubAgentConfigKey` are gone: nothing referenced them once the registry was
the catalog, and leaving them would have left a stale copy of a list that now changes at runtime.

`AGENT_KEYS` survives for the two things that really do mean "the reserved roles": the legacy LLM
config migration and the boot scope validation.

## Open question

Editing an agent file from the phone is deliberately left out of this document. The Instructions
page already solves the same problem (list, editor, `contentSha` guard, snapshot, conflict and
reload) and reusing it for `agents/` is a small step, but it is a feature of its own and belongs in
its own spec.
