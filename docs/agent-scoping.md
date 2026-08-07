# Agent scoping and introspection commands

Status: **implemented**. Every axis below was decided with the owner; there are no open points left.
Deviations found while building are recorded inline, marked "as built".

Two things ship together because one is useless without the other:

1. **Scoping** — per-agent allowlists for skills and MCP servers, so `general` and `research` can be
   given a narrower world than the orchestrator.
2. **Introspection** — `/skills`, `/agents`, `/mcp`, `/instructions` on every channel, so the scope
   is inspectable from chat instead of by reading config and source.

## Why scoping first

The introspection commands were requested with a per-agent argument (`/skills general`). Today that
argument cannot mean anything:

- One `SkillRegistry` instance is shared by the orchestrator, `general` and `research`
  (`src/index.ts:275,279,284`), and `list()` takes no argument (`src/skills/registry.ts:22`).
- Both backends pass the entire catalog to the prompt without consulting `depth` or `agentKind`
  (`src/agent/bridge.ts:253`, `src/agent/claude-sdk/backend.ts:350`).
- `AgentConfig` holds exactly `maxIterations` and `llm` (`src/core/config.ts:262-265`).
- MCP has a single hardcoded rule: `research` gets none (`src/tools/registry.ts:41`).

So `/skills general` and `/skills orchestrator` would print identical lists, and `/mcp general` would
print the global list. Reporting that truthfully was one option; building the scoping the argument
implies was the one chosen.

## Config

```jsonc
"agents": {
  "orchestrator": { "maxIterations": 90, "skills": ["*"], "mcp": ["*"] },
  "general":      { "maxIterations": 50, "skills": ["forgejo", "nextcloud"], "mcp": ["mailcow"] },
  "research":     { "maxIterations": 50, "skills": ["web-browsing"], "mcp": [] }
}
```

Two new optional fields on `AgentConfig`:

```ts
export interface AgentConfig {
  maxIterations?: number;
  llm?: AgentLlmConfig;
  /** Skill names this agent may see and read. Absent inherits the orchestrator's. */
  skills?: string[];
  /** MCP server names whose tools this agent receives. Absent inherits the orchestrator's. */
  mcp?: string[];
}
```

Entries are **exact names**, plus the single wildcard entry `"*"`. No prefix globs: a renamed skill
would silently enter or leave the scope, and the failure would be invisible.

### Resolution

| `agents.<type>.<field>` | Result |
| --- | --- |
| absent | inherit `agents.orchestrator.<field>` |
| absent, and orchestrator's absent too | **everything** (today's behaviour, so no config means no change) |
| `["*"]` | everything |
| `[]` | **nothing** -- an empty array is a decision, never "unset" |
| `["a", "b"]` | exactly `a` and `b`; unknown names are reported, not silently dropped |

`[]` and an absent field must therefore never be conflated: `skills: []` means this agent gets no
skills at all, while omitting the key means "same as the orchestrator". A resolver that treated a
falsy array as absent would silently grant everything to an agent meant to have nothing, so the
implementation branches on presence (`in` / `!== undefined`), not on length.

One resolver per axis, next to the existing `resolveMaxIterations` in `src/core/config.ts`:

```ts
export function resolveAgentSkills(config: MyClawConfig, type: AgentScopeType): string[] | "all";
export function resolveAgentMcp(config: MyClawConfig, type: AgentScopeType): string[] | "all";
```

`"all"` is a distinct return value rather than a sentinel array, so a caller cannot confuse
"everything" with "a list that happens to contain `*`".

### The two agent vocabularies

The tool axis is `main | general | research | cron` (`src/tools/registry.ts:3`); the config axis is
`orchestrator | general | research | cron`. `main` and `orchestrator` are the same agent under two
names; every other name is shared by both axes.

The resolvers take the **config** vocabulary and the callers map into it:

| Tool axis | Config axis used for scope |
| --- | --- |
| `main` | `orchestrator` |
| `general` | `general` |
| `research` | `research` |
| `cron` | `cron`, falling back to `orchestrator` when the key is absent |

`agents.cron` was refused for a long time (see Rejected below) on the grounds that it would name
something present on only one axis. That argument was backwards: `cron` exists on the tool axis, so
adding it to the config axis brings the two closer. The key is optional and an absent one still
inherits the orchestrator, so nothing that predates it moved. `maxIterations` is the exception: cron
already reads `cron.maxIterations`, and an `agents.cron.maxIterations` is ignored.

### The orchestrator is scoped too

Decided: one rule for every agent. `agents.orchestrator.skills` restricts the main agent, it is not
merely a value the sub-agents inherit. The same field would otherwise mean two different things
depending on which agent read it.

Accepted consequence: a list that is too narrow cuts the main agent off from its own skills until the
file is fixed. Two existing mechanisms already cover that -- `skills` is a hot section, so a fix
lands on the next message with no restart, and the boot alert below reports names that match nothing.

### `research` and MCP: a documented exception to the inheritance rule

Today `research` receives **zero** MCP tools, hardcoded, and it is documented as deliberate
(`docs/hot-reload-extensions.md:65-66`). Approved: config now has the last word, so
`agents.research.mcp` can grant servers.

The inheritance rule cannot apply unchanged here. If `agents.research.mcp` were absent and inherited
`orchestrator.mcp: ["*"]`, upgrading would silently hand every MCP server to the research agent —
a regression disguised as a default. Therefore:

> **`research.mcp` absent resolves to `[]`, not to the orchestrator's list.** Only an explicit
> `agents.research.mcp` grants servers to the research agent.

This is the only place the inheritance rule is overridden, and it exists so that installing this
version changes nothing until the owner asks for it. Note it is an override of *inheritance* only:
an explicit `agents.research.mcp: []` still means none, like everywhere else.

Consequence to document, not hide: `research`'s built-in tools are a read-only allowlist of 8
(`READ_ONLY_TOOLS`), but an MCP server's tools are arbitrary and may write. Granting MCP to
`research` therefore **ends the "the research agent is read-only" guarantee**. Both
`docs/hot-reload-extensions.md` and the `research` description in `docs/config.md` must say so, and
`/mcp research` must print the warning when the list is non-empty.

## Enforcement

Approved: the scope binds **visibility and execution**. An agent must not be able to reach what it
is not shown, otherwise the prompt catalog and the tools disagree and the agent notices.

Five points, all of which must use the same resolvers:

| # | Point | File | Effect |
| --- | --- | --- | --- |
| 1 | Prompt layer 5 (`# Available skills`) | `bridge.ts:253`, `backend.ts:350` | catalog filtered to the scope |
| 2 | Prompt layer 9 (suggested skills) | same call sites | `selectRelevantSkills` receives the filtered list, never suggests out-of-scope |
| 3 | `list_skills` tool | `src/tools/skills.ts:30` | lists the caller's scope only |
| 4 | `read_skill` tool | `src/tools/skills.ts:51` | refuses an out-of-scope name with an explicit message |
| 5 | MCP tools | `src/tools/registry.ts:39` | `dynamic` filtered by the `mcp__<server>__` prefix |

### How a tool learns who called it

Both backends already enrich every tool call with the same run context:

```
src/agent/bridge.ts:821           __depth, __message, __workspaceDir, __signal
src/agent/claude-sdk/tools.ts:73  __depth, __message, __workspaceDir, __signal
```

Add `__agentType` (tool-axis value) to both. That is the whole mechanism for points 3 and 4: no
per-run tool rebuilding, no registry/skills coupling, and it follows a convention already in place.

Point 5 needs no new plumbing: `getForAgent(agentType, disabled)` already receives the agent type,
and gains the resolved server list the way `disabled` is already passed in.

### Known hole, pre-existing, out of scope

`bridge.ts:787` executes `this.toolRegistry.get(name)`, which bypasses `getForAgent` entirely. A
sub-agent that hallucinates a tool name it was never offered still executes it. Points 3-5 are
enforced inside the tools and inside `getForAgent`, so MCP scoping is bypassable by a hallucinated
`mcp__server__tool` call. Fixing the lookup is a separate change and is **not** part of this spec;
it is recorded here so the gap is not mistaken for a scoping bug.

## Commands

Four commands, one shared implementation each, following the `config-commands.ts` /
`auth-commands.ts` pattern: the body knows nothing about channels and returns
`string | OutgoingMessage`.

New file `src/channels/introspect-commands.ts` exporting:

```ts
export async function handleSkillsCommand(p: IntrospectParams): Promise<string>;
export async function handleAgentsCommand(p: IntrospectParams): Promise<string>;
export async function handleMcpCommand(p: IntrospectParams): Promise<string>;
export async function handleInstructionsCommand(p: IntrospectParams): Promise<OutgoingMessage | string>;
```

### Agent argument

Accepted values: `orchestrator` (alias `main`), `general`, `research`, `cron`, and a live sub-agent
id (`subagent/<name>-<hex>`). A live sub-agent resolves through its `meta.type` to that type's
scope, since scope is per type, not per instance. No argument means the orchestrator.

An unknown name lists the valid ones instead of falling back silently.

### `/skills [agent]`

```
Skills for orchestrator (5 of 5)

- forgejo: Forgejo via fj and REST API ... (custom)
- mailcow: ... (workspace)
...

Scope: * (all)          <- or: forgejo, nextcloud
Write access: yes       <- manage_skills is main-only
```

When the scope is a list, out-of-scope skills are **not** printed; the count line carries the
difference (`3 of 5`). A configured name that matches no skill is reported explicitly:

```
Configured but not found: nextcloud
```

### `/agents`

Three sections, because three different things are called "agent" in this codebase and conflating
them is how the current `list_agents` tool ends up looking complete while hiding the browser agent.

```
Configured types
- orchestrator | 90 iterations | model: <resolved> | tools: main | skills: * | mcp: *
- general      | 50 iterations | model: <resolved> | tools: general | skills: 2 | mcp: 1
- research      | 50 iterations | model: <resolved> | tools: research (8 read-only) | skills: * | mcp: none

Live sub-agents
- subagent/deploy-a1b2 | deploy | general | 14 messages | idle
(none)

Special
- browser: prompt in agents/browser.md, private runner and tool registry, reached through
  delegate_browser_task rather than spawn, no skills, no MCP, invisible to list_agents
```

The command reads the agent registry, so a file dropped in `agents/` shows up with no restart and
no release (docs/file-agents.md). Roles and agents are listed apart because the two reserved roles
exist without a file and cannot be spawned.

The browser line is still static text. Its prompt is a file now, but everything else about it --
its own loop, its private tool registry, the single serialised Chromium behind it -- is not agent
configuration and stays out of the generic path.

### `/mcp [agent]`

Requires per-server state that does not exist today. `McpManager` exposes only `sync`, `getTools`,
`serverNames`, `stop`; `serverNames()` has **zero callers**; and a server that fails to connect is
logged and dropped (`src/mcp/manager.ts:65-68`), so listing live servers would hide exactly the ones
that are broken.

Approved: add per-server state to the manager.

```ts
export interface McpServerStatus {
  name: string;
  transport: "stdio" | "sse" | "http";
  state: "connected" | "disabled" | "failed";
  toolCount: number;
  lastError?: string;
  lastAttemptAt?: string;
}
export function status(): McpServerStatus[];   // on McpManager
```

As built: `lastAttemptAt` is optional, because a server declared `enabled: false` is never attempted
and inventing a timestamp for it would be a lie. `disabled` also outranks `failed`: a broken server
switched off afterwards is not a problem worth reporting.

Built from `config.mcp` (the declared set) rather than from the live connections, so a declared
server always appears. `failed` keeps `lastError` from the caught connect error.

```
MCP servers for general (1 of 3 in scope)

- mailcow  | stdio | connected | 12 tools        [in scope]
- forgejo  | http  | connected | 8 tools         [out of scope]
- weather  | stdio | failed    | spawn ENOENT    [out of scope]

Scope: mailcow
```

For `research` with a non-empty scope, append the warning that the read-only guarantee no longer
holds.

### `/instructions [agent]`

The composed system prompt. Measured against the current workspace:

| Agent | Tools | Prompt size | Telegram messages at 4000 |
| --- | --- | --- | --- |
| `research` | 8 | 11537 B | 3 |
| `general` | 25 | 12742 B | 4 |
| `main` | 45 | 14162 B | 4 |

Approved output: a short text summary plus the full prompt as a `.md` attachment. `OutgoingMessage`
already carries `attachments`, and `type: "file"` reaches `sendDocument` on Telegram
(`src/channels/telegram/send.ts:358`) and `MsgType.File` on Matrix (`src/channels/matrix/send.ts:195`)
with no adapter change.

```
Instructions for general — 12742 B, 10 layers, model <resolved>, backend home

Layers: CORE.md 1428 | SOUL.md 1701 | AGENTS.md 5466 | USER.md 1705 |
        skills 2/5 651 | tools 25 1205 | platform hint 312 | runtime 98

Not reproducible in a static dump:
- suggested skills (layer 9) depend on the message text
- nested AGENTS.md are injected into tool results during a run, not into the prompt
```

Fidelity, approved: show what is actually sent, not the raw builder output. So the dump also applies
`transform:system:prompt` and appends `OWNER_STEERING_NOTE` when the agent's resolved backend is
`claude-sdk` (`src/agent/claude-sdk/backend.ts:366`). The header states the backend so the reader
knows why the note is there.

`platform` is the channel the command came from, so the platform hint layer matches reality -- except
for `cron`, which has no channel. Decided: dump it **without** the hint layer and say so in the
header, because that is what a cron run actually receives. Borrowing the invoking channel's hint would
make the dump lie on exactly the layer the reader is checking.

```
Instructions for cron -- 12430 B, 9 layers, model <resolved>, backend home
Platform hint layer: absent (cron runs have no channel)
```

#### Attachment cleanup, required

`cleanupGeneratedTempFiles` recognises only the `tts-` and `browser-` prefixes
(`src/utils/media.ts:26-28`), and it is called from the **message** paths
(`src/index.ts:377,508`), never from the command paths. A `/instructions` attachment would leak a
temp file on every call. Two small changes:

1. add a `prompt-` prefix to the recognised set;
2. call `cleanupGeneratedTempFiles(response.attachments)` after the command response is sent, in
   both adapters' command paths.

## Wiring checklist

Adding a command touches more places than it looks. Per command:

| # | File | Change |
| --- | --- | --- |
| 1 | `src/channels/introspect-commands.ts` | new, the four bodies |
| 2 | `src/channels/meta-commands.ts:1` | add to `META_COMMAND_PATTERN`, or the command and its reply are fed back to the LLM as context |
| 3 | `src/channels/telegram/commands.ts` | add to `COMMANDS` (drives `/help` + the native menu) |
| 4 | `src/channels/matrix/commands.ts` | add to `MATRIX_COMMANDS` |
| 5 | `src/channels/telegram/adapter.ts:395-412` | one `bot.hears` line each |
| 6 | `src/channels/telegram/adapter.ts:646` | add to the defensive fallback array |
| 7 | both `session-handlers.ts` switches | one `case` each |
| 8 | both `*SessionHandlerDeps` + `src/index.ts` | inject `skillRegistry` (already there), `mcpManager`, `subAgentRunner`, `subAgentRegistry`, `toolRegistry` |
| 9 | `src/channels/matrix/adapter.ts` | nothing: the parser is generic |

All four names are `\w+`, so they are unaffected by the `parseMatrixCommand` bug below.

### Pre-existing bug found on the way

`src/channels/matrix/commands.ts:40` parses `/^\/(\w+)(?:\s+([\s\S]*))?$/`. `\w` excludes `-`, so
`/reload-skills` never matches, is never treated as a command, and falls through to the LLM —
despite being advertised in `MATRIX_COMMANDS:8`, matched by `META_COMMAND_PATTERN`, and having a
`case` at `src/channels/matrix/session-handlers.ts:453`. Unrelated to this feature; fix separately.

## Accepted limitations

- Scope is per agent **type**, not per live sub-agent instance. Two `general` sub-agents cannot have
  different skills. Per-instance scope would need it in `SubAgentMeta` and in the spawn tool.
- The browser sub-agent is outside the scoping system entirely: its registry is private and its
  prompt never includes a skill catalog. `/agents` says so rather than pretending otherwise.
- MCP scoping is bypassable by a hallucinated tool name via the `registry.get` hole above.
- `/instructions` cannot reproduce layer 9 or nested `AGENTS.md`; the header says so.
- Skill scoping does not stop `read` from opening a `SKILL.md` by path. It scopes the skill system,
  not the filesystem.

## Rejected alternatives

- **Prefix globs in the scope lists** — a renamed skill silently changes scope.
- **Allowlist plus denylist** — doubles the rules to read before you can answer "what does this
  agent see".
- **Per-run rebuilt skill tools** to carry the scope — `__agentType` in the existing enrichment is
  smaller and follows a convention already used by four other fields.
- **`/instructions` split across messages** — 3 to 4 messages per call, and the splitter can cut
  inside a code fence.
- **Reporting the truth without building scoping** — considered and offered; rejected because the
  per-agent argument was the point of the request.
- **Deriving per-server MCP tool counts from the `mcp__<server>__` prefix instead of adding manager
  state** — cheaper, but cannot explain why a declared server is missing.
- ~~**A fourth `agents.cron` config key**~~ — originally rejected because "the tool axis and config
  axis already disagree on names; adding a key present in only one of them makes it worse". Reversed
  when per-agent models arrived: a scheduled job could not be pinned to a cheap model without moving
  the owner's own default, and `cron` was already a name on the tool axis. See `docs/agent-model.md`.

## Tests

- `resolveAgentSkills` / `resolveAgentMcp`: absent inherits orchestrator; absent everywhere is all;
  `[]` is none **and is never read as absent**; `["*"]` is all; `research.mcp` absent is `[]` but an
  explicit `[]` elsewhere is still none; `cron` maps to orchestrator; the orchestrator's own list
  restricts the orchestrator.
- Boot validation: an unknown skill name and an unknown server name are both reported, a boot is
  never refused, and a fully valid config produces no alert. The checks iterate the agent sections
  the owner actually wrote, not the reserved roles, so a typo under a file-defined agent is caught;
  a config predating file agents still validates clean.
- Prompt: layer 5 and layer 9 restricted to the scope; an out-of-scope skill never appears.
- `list_skills` scoped by `__agentType`; `read_skill` refuses out-of-scope with a clear message.
- `getForAgent`: MCP filtered per agent; `research` with an explicit list gets exactly it; built-in
  tools unaffected by the MCP scope; an agent name the chain does not know falls back to the
  sub-agent set rather than the orchestrator's, so a typo cannot hand out `spawn` or `memory`.
- File agents (docs/file-agents.md): a file's `tools:` only ever narrows the baseline; `research`
  keeps the read-only baseline even with no file on disk; the config entry outranks the file.
- `McpManager.status()`: declared-but-disabled, connected with tool count, failed with `lastError`.
- Each command: no argument is the orchestrator; a valid type; a live sub-agent id; an unknown name
  lists the valid ones; a configured-but-missing skill is reported.
- `/instructions` returns an attachment, the summary sizes match the layer sizes, and the
  `claude-sdk` case includes the steering note.
- The temp file is removed after the command response is sent.

## Boot alert for unknown scope names

Decided: a name in a scope list that matches no installed skill and no declared MCP server is
reported to the owner at boot, not only when a command is typed. A typo silently narrows an agent's
world, and the failure mode is an agent that quietly stops using a skill.

It reuses the channel that the config-fallback alert already uses (`src/index.ts:596-611`): the first
whitelist entry on Telegram, best-effort. The same caveat applies and is already documented there --
whitelist ids are Telegram user ids and a Matrix send needs a room, so this reaches Telegram only.

Checked once per boot, right after the skills are loaded. Validated against the **declared** MCP
servers (`Object.keys(config.mcp)`), not the connected ones: a server that failed to connect is still
a real name, and reporting it as a typo would send the owner looking in the wrong place. That also
means the check does not have to wait for `McpManager.sync`. Also logged at `warn` regardless of
whether the chat send succeeds.

```
Attention : des noms de scope ne correspondent a rien.
- agents.general.skills: "nextclod" (aucune skill de ce nom)
- agents.research.mcp: "mailcow2" (aucun serveur declare)
Ces agents tournent avec un scope reduit. `skills` et `agents` sont des sections hot : corrige puis sauvegarde.
```

Validation is a report, never a refusal: an unknown name must not block a boot, or a renamed skill
would take the process down. This mirrors the config structure guard, which alerts and continues.
