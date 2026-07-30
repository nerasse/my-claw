# Per-agent model from chat

`/model <agent>` sets which model an agent uses by default, and writes it to `config.json`.

```
/model                     current model of this chat + menu       (unchanged)
/model opus                this chat only, nothing persisted       (unchanged)
/model research            menu, the pick is written to config
/model research opus        written to config directly
/model "cron" opus          quotes accepted
/model subagent/digger-c3d4 resolves to its type (research)
```

Accepted agents: `orchestrator` (alias `main`), `general`, `research`, `cron`, or a live
`subagent/<name>-<hex>` id. DM only, like every other command that writes config.

## What the two forms mean

`/model <model>` was, and stays, an override for the current conversation: it lives on the session
(`session.modelOverride`) and dies with it. `/model <agent>` is a persisted default in
`config.json`. They share one command because the question they answer is the same one, and they are
told apart by whether the first word is an agent name.

The precedence is the one that keeps a chat predictable:

```
session /model  >  agents.<agent>.llm.defaultModel  >  llm.defaultModel
```

A config edit never takes a conversation out from under the owner. It also means `/model opus`
followed by `/model orchestrator mimo` leaves the current chat on `opus` -- which is correct, and
which the reply says out loud.

## The bug this uncovered

`agents.orchestrator.llm` was **dead config**. It was documented in `docs/architecture.md`, present
in the live `config.json`, and read by nobody: the only consumer was `SubAgentRunner`, whose agent
type is never `orchestrator`, and `/agents` passed `undefined` for it. Writing the key from a
command would have reported success and changed nothing.

So the command required wiring it for real, in the three places a run's model is decided:

| Site | Was | Now |
| --- | --- | --- |
| `src/agent/dispatcher.ts` | `resolveLlmConfigForMessage(config.llm, ...)` | agent-aware |
| `src/agent/bridge.ts` | same | agent-aware |
| `src/agent/claude-sdk/backend.ts` | same | agent-aware |

The dispatcher matters as much as the other two: it chooses the *engine*. Resolving without the
agent's config there would send a run whose configured model is `claude-sdk` into the home
OpenAI-compatible loop, which then quietly ran a different model than the one configured.

`agents.orchestrator.llm` was also the one agent key excluded from the legacy `{"model": ...}`
migration -- consistent with it being dead, and a trap once it was not. All four keys migrate now.

## `agents.cron`

Cron gained a config entry it never had. Before, a scheduled job could only be pinned per job
(`model` on the job) or not at all, so making every job use a cheap model meant moving the owner's
own default. `agents.cron.llm` fills that gap.

- Absent, it inherits `orchestrator`, so nothing that predates the key moved.
- `agents.cron.skills` / `.mcp` work through the same resolvers as every other agent.
- `agents.cron.maxIterations` is **ignored**: cron already reads `cron.maxIterations`.

`docs/agent-scoping.md` had explicitly rejected this fourth key. That reversal is recorded there.

## Writing config.json

`src/core/config-edit.ts`, one function: `setAgentModel(agent, modelId, provider)`.

- **Re-reads the file from disk.** The in-memory config is not the file: boot merges ~28
  provider-discovered models into `llm.models` and injects secrets from `.env` over it. Serialising
  the live object would persist a cache and leak credentials into a file the owner reads.
- **Refuses a file it cannot parse** rather than overwriting whatever the owner was editing.
- **Writes `defaultProvider` alongside `defaultModel`.** Most models exist only in the runtime
  catalogue. After a restart with discovery down, `findModel()` would not resolve the id and the
  request would go to whatever `llm.defaultProvider` happens to be -- an Anthropic id sent to a
  local endpoint. Recording the provider makes the pin survive a cold, offline start.
- **Snapshots first**, through the same store as `/config rollback`, so `/config diff config` shows
  the write and `/config rollback` undoes it for free.
- Atomic write, then `reloadConfigNow()` so the confirmation describes the running config rather
  than the intended one. `agents` is a hot section, so no restart.

## The menu

The agent target rides inside `callback_data` as a one-letter suffix (`@o`, `@g`, `@r`, `@c`),
appended to the existing actions rather than duplicating the menu: Telegram caps `callback_data` at
64 bytes and the model ref already spends 12. `parseCallbackAction` strips it first, so every branch
below parses the shapes it always did, and an unknown letter degrades to "no target" -- falling back
to the session is recoverable, writing config for the wrong agent is not.

Both channels get it from one place: Matrix renders the same buttons as a numbered list, so its
numeric replies and reactions work with no extra machinery.

The effort entry is dropped from an agent menu. Effort is a per-session choice, and offering it there
would suggest the config edit pins it too.

## Rejected

- **A separate `/agent-model` command** — two commands for one question, and `/agents` already
  taught the owner the vocabulary.
- **`/model agent <name> <model>`** — unambiguous but verbose, and the ambiguity it avoids does not
  exist: no model id in a 31-model catalogue collides with an agent name, and interception only
  happens on an *exact* match, so the fuzzy multi-word form (`/model claude opus 5`) is untouched.
- **Per-instance models for live sub-agents** — a sub-agent instance is a session that will be gone
  tomorrow; config has no place to put it. An instance name resolves to its type, exactly as
  `/skills` and `/mcp` already treat one.
- **A confirmation step before writing** — the write is snapshotted and `/config rollback` undoes
  it, which is a better guarantee than a prompt the owner would click through.
- **Validating the model against the provider's API before writing** — the model is already checked
  against the live catalogue by `find()`; a network call would make a config edit fail when the
  provider is merely unreachable.

## Tests

- `tests/channels/agent-model-commands.test.ts` — target resolution, quotes, fall-through for
  non-agents, DM gate, unknown model, and the write itself: provider recorded, rest of the file
  untouched, runtime catalogue never persisted, unparsable file not overwritten, and the result
  re-read through the real `parseConfig`.
- `tests/agent/agent-model-resolution.test.ts` — the model **actually sent to the provider** for
  each precedence case, orchestrator and cron, plus the legacy migration.
- `tests/e2e/agent-model-command.test.ts` — through the real channel handlers: the menu's buttons
  carry the target, a click writes config and leaves the session alone, both channels agree, and a
  group chat writes nothing.
- `tests/agent/dispatcher.test.ts` — the engine follows the agent's configured model.

Nine mutations were run against these: dropping the agent from the bridge, from the dispatcher, and
confusing cron with main; letting `general`/`research` inherit the orchestrator; dropping cron from
the legacy migration; not writing the provider; stripping the target from `callback_data`; removing
the DM gate; and overwriting an unparsable config. All nine fail a test.
