# Per-file prompt inheritance

Status: spec, not implemented.

Today a workspace that does not own a prompt file reads the default workspace's copy. That rule is
hardcoded, identical for the four files, and identical for every workspace. This spec makes it a
per-file setting, editable from the app.

## The bug this starts from

The inheritance rule is implemented **twice**, and the two copies disagree.

`loadPromptFile` (`src/agent/prompt/loader.ts:80-86`) returns `""` when neither the workspace nor
the default one has the file, and `builder.ts:107` drops empty layers. The agent reads nothing.
`readInstruction` (`src/channels/my-claw-app/instructions.ts:119-131`) falls back to the shipped
`docs/prompt/<file>` template and reports `origin: "fallback"`. The page shows the template as if
it applied.

So for SOUL.md, AGENTS.md and USER.md in the `fallback` state, the instructions page displays text
the agent never sees. Only CORE.md is honest, because `loadCorePrompt` really does fall back to the
hardcoded constant (`loader.ts:117`).

It stays narrow in practice — `seedWorkspaceTemplates` (`src/core/config.ts:948`) fills the default
workspace at boot, so `fallback` only happens when the owner deletes a file — but it is the reason
phase 0 below is not optional. Making two divergent resolvers configurable produces two divergent
configurable resolvers.

## Decisions

| Question | Decision |
|---|---|
| Copy at creation, or inheritance? | **Inheritance only.** A copy is four files to maintain per workspace, and an edit to the source stops propagating the moment it lands. |
| Granularity | **Per file.** No workspace-level default: a second level would be a third source of truth to resolve, and "where does this `off` come from" becomes unanswerable. |
| A per-file off switch | **Yes**, with a hard UI requirement (below). |
| Is `builtin` a real runtime layer? | **Yes.** It is what closes the divergence above, so the page stops lying. |

Seeding the default workspace at boot stays as it is: it is how a fresh install gets editable files.

## Config model

`config.workspaces` is `Record<string, string>` (`src/core/config.ts:488-494`). The policy goes in a
sister section rather than enriching that value.

```ts
/** Where a workspace reads a prompt file it does not own. */
export type PromptSource = string; // "default" | "builtin" | "none" | a config.workspaces key

export interface PromptFilePolicy {
  /** Absent means "default", which is what every workspace did before this existed. */
  inherit?: PromptSource;
  /** Drops the layer even when this workspace owns the file. */
  off?: boolean;
}

/** Keyed by prompt file name. */
export type WorkspacePromptPolicy = Partial<Record<PromptFileName, PromptFilePolicy>>;

// MyClawConfig
workspacePrompts?: Record<string, WorkspacePromptPolicy>;
```

A union value (`Record<string, string | WorkspaceEntry>`) was rejected for three reasons, in
increasing order of weight: it breaks `validateWorkspaces` (`config.ts:1141`, `typeof dir !== "string"`
throws); it forces ~12 call sites that read the value as a path to go through a helper
(`config.ts:801,1161`, `index.ts:383,409,499,532,1305,1414,1499,1537`, both channel
`session-handlers.ts`, `my-claw-app/commands.ts:191`); and it **cannot express the default
workspace at all**, because `default` is a reserved key in `workspaces` (`config.ts:1139`). The
default workspace needs a policy like any other.

The cost of the sister section is a key with no matching workspace. That is reported at boot, never
fatal, on the `findUnknownAgentWorkspaces` pattern (`config.ts:809`).

### Keyword collision

`builtin` and `none` satisfy `WORKSPACE_KEY_RE` (`src/core/config-edit.ts:538`), so they could
already be workspace keys in a config on disk. Reserving them would stop a previously valid config
from booting.

Resolution order, non-breaking: a key **declared** in `config.workspaces` wins over the keyword.
`config-edit.ts` refuses to *create* a workspace whose key shadows a keyword, and the boot report
names an existing one. This matches the tolerant style already in place (`resolveWorkspaceKey`
never throws, `config.ts:1116`).

### Validation and hot reload

- `workspacePrompts` joins `HOT_OBJECT_SECTIONS` (`config.ts:1021`), or it is never applied live.
- Parse-time validation next to `validateWorkspaces` (`config.ts:1073`): unknown file names, unknown
  keys inside the policy, wrong types.
- Read-time getter `resolvePromptPolicy(config, workspaceKey, file)` normalising to a full value,
  on the `resolveContextPruning` pattern (`config.ts:620`).
- `config-commands.ts:154` `SECTIONS` picks it up automatically through `HOT_OBJECT_SECTIONS`.

## The resolution ladder

Per file, in order. The first step with content wins.

1. `<workspaceDir>/<NAME>.md` — the workspace's own file. Skipped entirely when `off`.
2. The configured source: `default` → the default workspace's own file · `builtin` → `docs/prompt/<NAME>.md`
   · `none` → stop here with `""` · a key → **that workspace's own file only**.
3. `docs/prompt/<NAME>.md` — last resort, unless step 2 already was the template.
4. `""`. For CORE.md only, `CORE_PROMPT` (`src/agent/prompt/core-prompts.ts:1`).

Plus the existing mtime cache as a last-good-value guard (`loader.ts:86`).

**One hop, deliberately.** If A inherits from B, step 2 reads the file B owns, never B's own
inheritance. Cycles are impossible by construction instead of detected, and the rule fits in one
sentence in the UI. Chains were not asked for.

`off: true` and `inherit: "none"` are both legal together and redundant; the UI says so rather than
locking a control the owner needs the moment they switch back on.

## Phase 0: one resolver

Before any feature.

- Extract the ladder into a single function consumed by both `loader.ts` and
  `channels/my-claw-app/instructions.ts`. This is the whole point; the rest follows from it.
- `loadPromptFile` moves from three positional arguments to an object, so a policy can travel.
- One canonical file list. There are four today, out of sync: `PROMPT_TEMPLATES` 6 entries
  (`config.ts:946`), `PROMPT_FILES` 3 (`loader.ts:8`), `PROMPT_LAYERS` 4 (`src/agents/types.ts:15`),
  `INSTRUCTION_FILES` 4 (`instructions.ts:14`). A new `src/agent/prompt/files.ts` owns the four
  prompt files and their layer names; config, loader and channel import it. `PROMPT_TEMPLATES` stays
  separate and keeps its comment saying why it holds two files no prompt reads (`SYSTEM.md`,
  `MEMORY.md`).
- Three parallel implementations must join the shared resolver: `src/agent/subagents/browser.ts:110-135`
  (a second prompt builder that redoes the layer filtering), `src/channels/introspect-commands.ts:246`
  (`/instructions` passes neither `workspaceDir` nor `defaultWorkspaceDir`, so its dump has never
  reflected a secondary workspace), and the literal duplicate `workspaceFor()` in
  `src/agent/bridge.ts:163-176` and `src/agent/claude-sdk/backend.ts:213-226`.
- Tests for the holes this uncovers: `seedWorkspaceTemplates` has none, and
  `PromptContext.instructions` is never exercised in `buildSystemPrompt` (only in the frontmatter
  parser, `tests/agents/loader.test.ts:110`).

## Interaction with per-agent layers

An agent file already drops layers through `instructions:` in its frontmatter
(`src/agents/loader.ts:52-69`, parsed into `PromptLayerName[]`). With `off` there are two mechanisms
that silence a layer, and they compose as an **intersection**: a layer reaches the prompt only if
the workspace has it on and the agent asks for it.

That is unavoidable — both settings are legitimate — but it is undiagnosable unless both sides say
so. Two obligations, both in the app:

- The layer screen lists the agents whose frontmatter already excludes this layer.
- `AgentFileScreen`'s layer chips say when a checked layer is off at the workspace level. Without
  it, the owner checks `SOUL`, saves, and nothing changes.

This needs `instructions.list.result` to carry an optional `agentLayers?: Array<{ agent, layers }>`.
Deriving it in the app would cost one request per agent: `AgentInfo` does not carry `instructions`,
only the per-file `agents.file.result` does.

## Wire protocol

Following the channel's rule that a mutation answers with the fresh listing, not an optimistic echo.

- `instructions.list.result` (`src/channels/my-claw-app/types.ts:883`) gains, per entry, the
  effective `inherit` and `off`, plus the optional `agentLayers`. **The absence of `inherit` on an
  entry is how the app detects an older server** — a timeout would not work, since the page itself
  answers and `markUnsupported` refuses to downgrade a `ready` status.
- New `instructions.layer.set { workspace, file, inherit?, off? }`, answering `instructions.list.result`.
- New method on `MyClawAppInstructionsController` (`adapter.ts:274`); handler on the five-step
  pattern of `handleInstructionsSet` (`adapter.ts:1893`): missing controller → `refuse`, field
  validation → `refuse` with the fields in data, `try`, fresh listing, `catch` → `refuse`.
- `setWorkspacePromptPolicy` in `config-edit.ts`: `readConfigFile` → mutate → `snapshot(pre-write)`
  → `writeFileAtomically` → `journal`. Never serialise the live config (`config-edit.ts:8-15`).

App side, a frame must be declared three times in `src/core/protocol.ts` — interface, `ServerFrame`
union, and the `FRAME_TYPES` set — or it is dropped silently.

## App surface

Full UX in the QA checklist at the end of this document. The load-bearing choices:

**A dedicated screen**, `InstructionLayerScreen`, reached from a 40×40 `⋯` button on the file row of
`InstructionsScreen`, on the `ScopeEditorScreen` / `NumberEditorScreen` precedent: one setting, one
screen, one Save. Not inline on the row — five sources, a dangerous boolean and the ladder do not
fit in a `font.small` subtitle. Not in `InstructionEditorScreen` — `off` has to be discoverable
without opening a file, and when `inherit` is `none` the editor's text describes nothing the agent
reads.

**The ladder is the feature.** The screen shows the four steps with the winning one marked, because
`inherit` × `off` × frontmatter is 5×2×2 combinations that nobody resolves from memory. It is
rendered as a single accessibility focus stop with a composed label; twelve fragments are unreadable
in TalkBack.

**The `off` badge on the list row is non-negotiable.** The failure mode of this feature is a 4 KB
file on disk that is never read. If that state is only visible inside a secondary screen, the
feature is a trap. Red badge on the row, permanently.

**Never optimistic.** A chip that reads `Skipped` while the server refused creates a false belief
about what the agent reads. `saving` needs a 4 s timeout on the `markUnsupported` precedent
(`AppShell.tsx:1439`), because `connection.send()` can resolve `true` and still die in the in-memory
outbox.

**`off` on CORE.md is warned about, not blocked**: the server accepts it, and a greyed control that
does not say why is worse. The commit button reads `Skip this layer` and a red line names the safety
directives. The repo shows rather than forbids (`JobsEditorScreen.tsx:438-440`).

**Applying to all four files is a UI convenience only**, emitting four separate mutations, not
persisted anywhere. Four frames rather than a transaction so a partial failure stays legible file by
file. The count comes from `instructions.files`, never hardcoded.

Navigation: one entry path (the list), `settingsPage` gains `'instruction-layer'`, and a branch goes
into the global `BackHandler` **before** the `'instructions'` one (`AppShell.tsx:1139`), with the new
target state added to the dependency array (`AppShell.tsx:1193-1225`). Hardware back does exactly
what `‹` does. The refresh effect at `AppShell.tsx:1439` must cover both pages: a screen showing the
resolution ladder cannot run on a ten-minute-old list when the agent writes `AGENTS.md` too.

## Phasing

| Phase | Content | User-visible |
|---|---|---|
| 0 | One resolver, object argument, canonical file list, `/instructions` fix, tests for existing holes | no |
| 1 | `workspacePrompts`, validation, hot reload, boot report, configurable source (one hop) | no |
| 2 | `builtin` as a real runtime layer, `off` | no |
| 3 | Frames, store, `InstructionLayerScreen`, row badges, `AgentFileScreen` note | yes |
| 4 | Docs: this file, `multi-workspace.md`, `instructions-page.md`, `my-claw-app-channel.md` | — |

Each phase ships alone and leaves the system coherent.

## Debt this touches

- **`protectedPaths` only covers the default workspace** (`src/core/config-store.ts:358-364`). A named
  workspace's four files are snapshotted only when written through the page (`instructions.ts:218`).
  Richer inheritance makes more of them load-bearing, so this gap widens.
- `docs/instructions-page.md:117-127` is already stale: it says there is no such thing as per-agent
  instructions, which `PromptContext.instructions` and `agentPrompt` contradict, and its
  `config.ts:367` reference has drifted to `config.ts:404`.
- `docs/multi-workspace.md:28-31` documents "no template seeding, everything missing falls back to
  the default workspace" as a choice. Phase 1 makes it the *default* choice rather than the only one.

## Rejected

**Copy at creation.** Four files to maintain per workspace, and the source's edits stop propagating.
The instructions page already covers the real need: "create for this workspace" pre-fills with the
content that already applied (`instructions.ts:97-104`), which turns a resolution into a file
without changing what the agent reads.

**A workspace-level default alongside the per-file setting.** A third source of truth to resolve,
a third line in the ladder, and `off` stops being attributable.

**Unrolling the inheritance chain in the app.** Showing `sofa → lab → default` when the server stops
at `lab` is an elegant lie. Step 2 marked unreachable with "the server follows one hop only" is
uglier and true.

**Auto-repairing a cycle or a removed source.** The repo never rewrites the owner's choice; it paints
it red and lets the server refuse (`ScopeEditorScreen.tsx:19-21`, `WorkspacePickerScreen.tsx:65-82`).

**An unsaved-changes dialog on back.** No screen in the app has one, and hardware back traverses
fifteen levels without ever posing one. A `not applied yet` note under Save covers it.

**Reusing `WorkspacePickerScreen` for the source list.** It knows `default | key`, not `builtin` or
`none`, and it commits on tap with no Save. Extending it with two pseudo-entries and a deferred mode
would break both current callers to save sixty lines.

## Tests

Beyond the phase 0 holes:

- The ladder, step by step, including `off` beating an existing own file and `none` short-circuiting
  `builtin`.
- One hop only: A inherits from B, B owns nothing, result is the template — not B's inheritance.
- A source pointing at a removed workspace, and at itself.
- Page and runtime agree: the same `(workspace, file)` resolves to the same content through
  `readInstruction` and through `buildSystemPrompt`. This is the regression test for the divergence
  this spec starts from.
- Intersection with per-agent `instructions:`, both directions.
- `workspacePrompts` hot reload applies to the next run with no restart.
- Existing strings that must not move: `in this workspace · N KB` and `inherited from default` are
  asserted verbatim by `my-claw-app/src/app/__tests__/Instructions.test.tsx:111,119`, and no row may
  contain the word `missing` (`:120`).

## QA checklist

Manual, phase 3. Every line is a state this feature can reach.

**List row**
- An `own` row reads exactly `in this workspace · N KB`, no badge.
- A row inherited from the default reads `inherited from default`, verbatim.
- No row contains the word `missing`.
- An `off` file carries a red badge and names its path on disk.
- A server with no `inherit` on the entries renders no `⋯` at all, plus a version note.
- `⋯` never opens the editor; the row body never opens the layer screen.

**Layer screen**
- `‹` and hardware back do the same thing: draft dropped, back to the list.
- A modified draft shows `not applied yet` under Save.
- `Skipped` selected makes the header button read `Skip this layer`.
- `Skipped` on CORE.md shows the red safety-directives line.
- `none` chosen marks steps 3 and 4 unreachable.
- `builtin` chosen renders the shipped template once in the ladder, not twice.
- The current workspace is absent from the source list; on `default`, so is `the default workspace`.
- A source that lacks the file marks step 2 broken with `one hop only`.
- A → B → A shows `points back at`.
- A source removed from another device shows the red `no longer valid` card with `drop`.

**Sending**
- While saving: header `...`, chips and list inert.
- After `instructions.list.result`: ladder redrawn, screen **not** closed.
- Server silent for 4 s: chips re-enabled, `not applied: the server never answered`.
- An `error` frame of scope `instructions` clears `saving` and shows the message.
- The four-file convenience sends exactly four frames, one per `instructions.files` name.
- A partial failure across the four leaves the list showing which landed.

**Frontmatter intersection**
- An agent with `instructions: CORE, USER` appears under the agents-that-cut section.
- A layer cut on both sides shows one sentence naming both mechanisms.
- `AgentFileScreen`: checking a layer that is off at the workspace level shows the explanatory note.
