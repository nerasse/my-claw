# Providers: CRUD from the app and the env key

A provider lives in two files: its entry in `config.llm.providers` (config.json) and, when it
has one, its API key in `~/.my-claw/.env`. The app edits both through the `providers.*` frames.

## The config entry

```
llm: {
  providers: {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      discover: true,
      promptCache: true
    }
  }
}
```

Fields the app can write (`providers.upsert`, one payload for create and edit):

| field | meaning |
|---|---|
| `providerType` | `"openai"` (default), `"anthropic"`, `"codex"`. The frame's own `type` discriminates the message, so the engine field is renamed on the wire. |
| `baseUrl` | openai (required) and anthropic (optional, defaults to api.anthropic.com). |
| `apiKeyEnv` | openai and anthropic: the *name* of the env var, never the value. On anthropic, absent means the Claude subscription (docs/anthropic-backend.md). |
| `group` | picker group label (docs/model-discovery.md). |
| `disabled` | switched off: discovery skips it, the picker hides its models, tags route past its candidates and session pins fall through the chain. The sign-in stays -- disabling is not a sign-out. Refused when the provider carries the global default (see below). |
| `discover` | auto-discover this provider's models. |
| `promptCache` | openai only (docs/prompt-caching.md). |
| `reasoningReplay` | all engines. Hand the model its own reasoning back across tool iterations. Absent means **on**; set it false only for an endpoint that emits reasoning and rejects it on input (docs/reasoning-replay.md). |
| `pricingProvider` | openai only (docs/status-command.md). |
| `fallbackModel` | claude-sdk only. |

Empty optional strings delete the field (the file never carries settings that say nothing);
an absent field leaves the entry untouched. The resulting entry must pass the shape check:
openai needs a `baseUrl`; codex refuses both `baseUrl` and `apiKeyEnv`, because it is the one
backend that owns its target and its token store (docs/codex-backend.md). anthropic takes both and
defaults both, which is what lets one transport serve the Claude subscription and an
Anthropic-compatible backend (docs/anthropic-backend.md).

The key itself is validated like the MCP names (`/^[a-z0-9][a-z0-9_-]*$/`) and `tags` is
reserved: the `tags` row of the providers listing is synthetic, it has no config entry.

## The env key

`providers.env.*` frames read and write `~/.my-claw/.env` through `src/core/env-edit.ts`,
line by line: parse-and-reserialise would flatten the comments and the order the installers
left there. Rules:

- the file is secrets: mode is forced to `0600` (the atomic writer defaults to `0644`);
- snapshots (`backups/`, cleartext, `0600` in a `0700` directory) are taken before every
  write, like every protected file -- this is deliberate;
- only names ever cross the wire. `providers.env.result` carries `names` (the .env lines) and
  `present` (the .env ones plus shell/systemd env), so the app can tell "already set, reuse"
  from "ask for a value" without ever seeing a value;
- a rename moves the line in place (value and trailing comment preserved), refuses a target
  that already has a line, and patches `process.env` by hand: the loader (`loadEnv`) never
  deletes, so an old name would otherwise live on in the process.

## Frames

| frame | payload | answer |
|---|---|---|
| `providers.upsert` | key + fields above | `agents.config.result` |
| `providers.remove` | key, `withModels?` | `agents.config.result` |
| `providers.rename` | from, to | `agents.config.result` (rewrites `llm.models[].provider` and `llm.defaultProvider` in the same write) |
| `providers.env.set` | name, value | `providers.env.result` -- the only frame that carries a secret value; it is never echoed or logged |
| `providers.env.rename` | from, to | `providers.env.result` (repoints every provider that read the old name; a failed config write rolls the .env line back) |
| `providers.env.remove` | name | `providers.env.result` |
| `providers.env.list` | — | `providers.env.result` |

Every provider mutation calls `reloadConfigNow()` then refreshes the model catalog: a provider
that just gained a key (or just appeared) discovers its models now, not at the next 6h cycle.
A hand-edited `"disabled": true` in config.json lands the same way: the config watcher reloads,
the catalog re-projects, and the picker reflects it without a restart.

## Renaming a key

The key is an address, not a name: it prefixes every model reference (`claude-2/claude-opus-5-5`),
it names the sign-in file, and it sits in tags, agent pins, cron jobs, session overrides and agent
files. `providers.rename` therefore rewrites **every place the key is written**, in one operation
(`renameProviderEverywhere`, `src/core/provider-rename.ts`):

- `config.json`, one atomic write: the entry, `defaultProvider`, a qualified `defaultModel`,
  every declared model's `provider` and qualified `id`, every provider's `fallbackModel`, the
  tags' routes (and legacy `model`), every agent's `llm` pin, `visionFallback`;
- each session's stored `modelOverride` (`sessions/**/meta.json`);
- each cron job's `model` (`cron/jobs.json`);
- each agent file's `model:` frontmatter (every editable tier);
- the sign-in file (`accounts/<old>.json` -> `accounts/<new>.json`); a file already sitting on the
  target refuses the rename before anything moves.

Only a reference that *names* the provider travels (`<key>/...`): a bare id resolves by provider
order, which a rename does not change. `providers.rename.preview` answers the same walk read-only
(the app shows its counts before asking to confirm). New accounts get short keys by convention
(`claude`, `claude-2` -- `accountKeyFor`), so renames stay rare; the operation exists because a
key that has to change must not leave a tag silently falling back to the global default.

## Disabling a provider

`disabled: true` is the off switch that deletes nothing: `{ "key": "...", "disabled": true }`
on one `providers.upsert` frame, no other field required. Re-enabling removes the field (off is
the default state; the file carries settings, not affirmations).

What it changes, everywhere:

- **discovery** does not query it at all, and its silence is not evidence about its models
  (`ModelCatalog.enabled()` ignores it);
- **availability** answers `disabled` before any key or sign-in question, so the picker hides its
  models and the management view lists them with the reason;
- **routing** needs nothing new: a tag route skips the candidate, and a session pinned on one of
  its models is skipped to the next step of the chain -- routing past an unavailable provider is
  the chain's job;
- **the sign-in stays**: disabling is not a sign-out, and re-enabling brings the models straight
  back.

**Refusal**: the provider that carries the global default (its `defaultProvider`, or the model
`defaultModel` names -- qualified, or declared bare under it) cannot be disabled. Every run that
inherits the default would have nothing left below it. Pick another default first; the refusal
says so.

## Refusals

- `remove` is refused while anything in the file still references the provider: `llm.defaultProvider`,
  a curated `llm.models[].provider`, or a **tag route** whose candidate names it
  (`tags.X.route[].model`, or the legacy single-model `tags.X.model`).
- The tag case is the one that used to pass unseen, and it is the quietest: a route that loses its
  model does not fail, it falls back to the global default, so the tag goes on claiming to mean
  what it says (2026-09-12, the owner's `Cheap` route into `opencode_go`).
- **`withModels: true` accepts the cascade** instead of being refused: the provider leaves, the
  curated models declared under it go with it, and **every reference that named one of its models
  is repointed at the default model** (owner, 2026-10-19: "on remplace par le modèle par défaut"):
  - a tag route candidate becomes the default's concrete model (a route cannot carry a tag
    reference itself); if that collides with a candidate already in the route, the duplicate is
    dropped;
  - a legacy single-model tag takes `defaultModel` as it is, tag references included;
  - an agent's `llm.defaultModel` pin moves to the default; its `llm.defaultProvider` is cleared;
  - `llm.visionFallback` is **dropped** rather than repointed -- a vision slot needs a model that
    sees, and pointing it at one that may not would silently disable the reroute anyway;
  - when the default itself cannot leave the removed provider, the old behaviour stands: the
    candidate is dropped and an emptied tag or route goes with it.
  - Session pins, cron jobs and agent files are not rewritten: their stale reference is healed by
    the resolver at the next run, which lands on the default -- the same place this cascade points
    at.
  The plain refusal stays for a caller that did not ask for it -- dropping an owner's declarations is
  never something a provider removal does on its own.
- Why the cascade exists at all: the refusal alone was a dead end. The app offers the delete, the
  server always says no, and the only way out was hand-editing `config.json` -- measured on
  `commandcode` (2026-09-09), which left a `llm.models` entry pointing at a provider that no longer
  existed. Exactly the state the refusal is there to prevent, reached by obeying it.
- `env.rename` onto an existing name is refused (`providers.env.set` is how you point a provider
  at a variable that already holds a value).
- `anthropic` / `chatgpt` may be deleted, but `/claude set-token` and `/codex login` recreate
  their provider on the next auth change (`src/index.ts`, `ensureAuthProvider`): the app says so
  in the delete confirmation.
- Errors ride the `error` frame with scope `providers`, and the refusing log line never carries
  an env value. **The cause travels with the frame** (`detail`), not only into the log: the message
  names the operation that failed, which is not something a screen can act on.
- A refused removal is rendered by the list the app lands on, not by the editor that asked for it:
  the answer arrives after that screen is gone. `providersEnvStore` holds it, and `ProvidersScreen`
  is what draws it.
- A config file edited outside the app (by hand, or by another tool) pushes a fresh
  `agents.config.result` to every connected socket. Without it the devices keep rendering the list
  they were last handed, and a hand edit looks like it did not take.
