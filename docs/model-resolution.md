# Model resolution

Which model a run uses, who may change it, and what every surface is allowed to claim about it.

This document exists because the answer was computed in two incompatible ways: the pickers and
status lines used one chain, the runtime another. A chat pinned to `claude-sonnet-5` ran
`mimo-v2.5-pro` for two days without a single screen saying so.

## The chain, once

One order, for every agent, every channel and every backend:

| # | Source | Where it lives |
|---|---|---|
| 1 | the chat's own pick | `session.modelOverride` |
| 2 | the agent's config pin | `config.agents.<key>.llm.defaultModel` |
| 3 | the agent file's `model:` | `agents/<name>.md` frontmatter |
| 4 | the global default | `config.llm.defaultModel` |

`resolveAgentLlm` (`src/core/config.ts:731`) collapses 2-3, `mergeAgentLlm`
(`src/llm/resolver.ts:194`) slots the result into the `defaultModel` position so `modelId ??
merged.defaultModel` expresses the whole order. Only `cron` inherits the orchestrator's entry; a
sub-agent with no entry of its own means "global default", never "whatever the owner picked for
the chat he is sitting in".

Then, in order:

1. **Tag expansion.** A `tag:<name>` id resolves through `config.tags` to a real model, keeping
   the outermost effort pin. `tag:Default` means *the merged default* -- the agent's pin when it
   has one, not the global default. A cycle is refused loudly.
2. **Provider, then backend.** The chosen model's `provider` decides which backend runs it:
   `claude-sdk` (Claude subscription), `codex` (ChatGPT subscription), or an OpenAI-compatible
   HTTP provider. The engine is picked from the *resolved* model, never from the default.
3. **Vision reroute.** When the message carries an image and the resolved model cannot take one,
   the run switches to `config.llm.visionFallback` -- which may change the backend with it.

Three different things are called a fallback; they never mix:

- `config.llm.visionFallback` -- image reroute, above.
- `providers.<claude-sdk>.fallbackModel` -- handed to the Agent SDK for its own failover.
- "falling back" in the chain above -- the next source down, which is not a failure path.

## One function, and the runtime calls it too

```ts
resolveRunModel(config, { agent, session, message? }): RunModel
```

```ts
interface RunModel {
  /** The id the user picked or inherited, tag reference included. Identity for status and analytics. */
  model: string;
  /** The real id sent to the API when `model` is a tag. */
  apiModel?: string;
  provider: string;
  backend: "claude-sdk" | "codex" | "openai";
  effort?: EffortLevel;
  /** Which step of the chain won: the only way a screen can explain itself. */
  source: "session" | "agent" | "agent-file" | "global";
  /** Set when the vision reroute applied, naming the model that was displaced. */
  reroutedFrom?: string;
  availability: Availability;
}
```

The rule that makes this worth doing: **the dispatcher, the backends and every display call this
same function.** Today the resolution runs twice per message with different inputs -- the
dispatcher (`src/agent/dispatcher.ts:80`) resolves without the agent file's `model:`, the backend
(`src/agent/claude-sdk/backend.ts:348`, `src/agent/bridge.ts:255`) resolves with it -- and the
first of the two picks the engine. Two answers, one of which chooses the process.

Compaction is part of "the runtime": `src/agent/claude-sdk/backend.ts:291` passes
`session.modelOverride` raw (no agent pin, no tag expansion) and `src/sessions/compaction.ts:145`
resolves against the global config alone. Both must go through `resolveRunModel`.

## Writing a pick

```ts
session.modelOverride = pick === resolveRunModel(config, { agent, session: withoutOverride }).model
  ? undefined
  : pick;
```

The override is cleared only when the pick equals **what would run without it**. The old rule
compared against `config.llm.defaultModel`, so picking the global default cleared the override and
handed the chat to the agent's pin -- a model the user never chose and no screen displayed. That
is the bug this document opens with, and it is duplicated verbatim in three places
(`src/index.ts:950`, `src/channels/telegram/session-handlers.ts:202`,
`src/channels/matrix/session-handlers.ts:460`).


A pick is refused, never stored, when the model is unknown or not `ready` -- and since the picker
only offers `ready` models, a refusal here means the state changed between the two, not a UI that
let you choose the impossible.

## What a surface may claim

Any screen that names the model of a chat renders `resolveRunModel(...)`, and says the source
when it is not `session`:

- `claude-sonnet-5` -- the chat's own pick.
- `claude-sonnet-5 · from the orchestrator config` -- source `agent`: the chat inherits a pin
  that lives in `config.agents`, and tapping through must lead to where that pin is edited.
- `claude-sonnet-5 · global default` -- source `global`.

No surface may compute `session.modelOverride ?? config.llm.defaultModel`. That expression is the
bug; it appears seven times today.

## Availability: offered is not runnable

A model can resolve perfectly and fail on every run. Three causes, one computed answer:

```ts
type Availability =
  | { state: "ready" }
  /** Declared in config.llm.models, absent from the provider's live list. */
  | { state: "stale"; provider: string }
  /** The provider needs an env key that is not set. */
  | { state: "no-key"; provider: string; env: string }
  /** claude-sdk / codex: the subscription is not authenticated. */
  | { state: "no-auth"; provider: string };
```

**A model that is not `ready` is not offered.** The picker lists what can run, and nothing else --
no greyed rows, no "removed" badges. The reason is then invisible by construction, which is why
the run notice below is not optional: it becomes the only explanation of a model that vanished.

Availability is derived, never stored in config, and it is derived from **the catalog's last known
good set plus the auth state** -- not from a probe at picker time. The distinction that makes this
safe, and that the code does not draw today:

| The provider... | Then |
|---|---|
| answered, and did not list the model | `stale` -- hide it |
| answered, and listed it | `ready` (subject to key/auth) |
| **did not answer** (down, timeout) | keep its last known models, hide nothing |

A discovery failure is not evidence that a model disappeared. `ModelCatalog` already keeps the
last known set and persists it (`src/llm/catalog.ts:205-217`) precisely so an outage does not
rewrite the menu; availability must inherit that resilience rather than re-introduce a live probe
on the read path.

Two consequences to accept knowingly:

- On the current box the picker goes from **434 models to ~29**: `openrouter`'s 405 disappear for
  want of `OPENROUTER_API_KEY` in `/etc/my-claw/.env`. Adding the key brings them back with no
  code change -- which is the whole point of deriving this rather than curating it.
- If the Claude subscription token expires, all 13 `anthropic` models go `no-auth` -- **including
  `claude-sonnet-5`, which is the global default**. There is nothing below the global default to
  fall back to, so that case is a loud run failure naming the provider and the auth, never another
  silent substitution.

Each state is a real case on the current box, not a hypothetical:

- **stale** -- `config.llm.models` declares `mimo-v2.5-pro` on `litellm`; the gateway dropped it
  and answers `403 litellm.PermissionDeniedError: Model is blocked`. `mergeModels`
  (`src/llm/catalog.ts:30`) keeps config entries ahead of discovery, so a declared model survives
  its own removal forever and stays offered in the picker.
- **no-key** -- `openrouter` discovers 405 models over a public endpoint, and the deployed unit's
  `/etc/my-claw/.env` carries no `OPENROUTER_API_KEY` (nor the `FIREWORKS_API_KEY` /
  `OPENAI_API_KEY` that `resolveApiKey` falls back to). 405 of the 434 offered models cannot run
  there, and nothing says so until a message fails.
- **no-auth** -- the app's provider snapshot sets `keyPresent: provider.apiKeyEnv ? ... : false`
  (`src/index.ts:1084`), so the two subscription providers are permanently reported as having no
  key while `claudeTokenStatus()` and `codexIsLoggedIn()` know the truth.

## An id must carry its provider

`resolveFromMerged` takes `model?.provider ?? merged.defaultProvider` (`src/llm/resolver.ts:103`).
So an id **absent from the merged model list** is sent to the default provider -- and to that
provider's backend. Measured, with the catalog cold:

```
gpt-5.6-sol            -> provider anthropic, backend claude-sdk
xiaomi/mimo-v2.5-pro   -> provider anthropic, backend claude-sdk
```

A ChatGPT id handed to the Claude SDK. The catalog cache
(`~/.my-claw/model-catalog.json`, loaded synchronously in the constructor) usually hides this, so
the window is a first boot, an unreadable cache, or any id the catalog does not carry. A silent
misroute across vendors is not an acceptable failure mode: an unknown id must be **refused**, with
the provider named, exactly like an unknown provider already is.

The self-heal in `src/agent/dispatcher.ts:92` covers only `session.modelOverride`. An agent pin, a
tag target and a cron job's model have no equivalent -- today's incident was an agent pin, and it
failed on every message for two days.

## A dead pin falls back, and says so once per run

Any source of the chain that names an unavailable model is skipped, and resolution continues down
to the global default. The config is never rewritten: the file keeps what its owner wrote.

The fallback is announced **once per agent run**, not once per LLM request -- a run is dozens of
requests, and a warning on each would be noise that trains you to ignore it. Concretely:

- the run's model is resolved once, at `agent:run:start` (`src/hooks/types.ts:45`), which already
  carries the `messageId` that keys the run;
- if resolution had to skip a source, one notice is emitted for that run and one `warn` is logged;
- `agent:turn:start` (per iteration) emits nothing;
- a sub-agent is its own run: its own pin degrading warns once, attributed to that agent, not to
  the orchestrator.

The notice names the four things needed to fix it without reading logs:

> `mimo-v2.5-pro` is not available (litellm no longer lists it) · pinned in
> `config.agents.orchestrator.llm.defaultModel` · running `claude-sonnet-5` (global default)

Delivery: `OutgoingMessage.notice` on telegram and matrix (`src/channels/types.ts:60`, already used
for out-of-band statements). The app has no equivalent, so `chat.message` gains `notice?: boolean`
and the app renders it as a statement of the system rather than a reply from the agent -- a warning
that looks like the assistant talking is a warning that gets read as content.

## Verification

The refactor is done when:

1. `grep -rn 'modelOverride ?? .*defaultModel' src/` returns nothing.
2. One test asserts the incident: global default `A`, agent pin `B`, user picks `A` in the chat ->
   the run uses `A`, and the picker says `A`. It must fail on today's code.
3. One test per backend (`claude-sdk`, `codex`, openai) asserting that the engine follows the
   resolved model and not the default provider.
4. One test asserting an unknown id is refused instead of being routed to `defaultProvider`.
5. One test per availability state; one asserting a non-`ready` model is absent from the picker;
   one asserting a provider that **failed to answer** keeps its models listed.
6. One test asserting the fallback notice is emitted once for a run of several iterations, and
   that `agent:turn:start` adds none.
7. One test asserting an unavailable **global default** fails the run loudly instead of
   substituting anything.
8. `/status`, `/model`, the app's model row and the agent page all read the same function: one
   test renders each and compares against `resolveRunModel`.
