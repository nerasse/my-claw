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
| `providerType` | `"openai"` (default), `"claude-sdk"`, `"codex"`. The frame's own `type` discriminates the message, so the engine field is renamed on the wire. |
| `baseUrl` | openai only, required. |
| `apiKeyEnv` | openai only: the *name* of the env var, never the value. |
| `group` | picker group label (docs/model-discovery.md). |
| `discover` | auto-discover this provider's models. |
| `promptCache` | openai only (docs/prompt-caching.md). |
| `reasoningReplay` | all engines. Hand the model its own reasoning back across tool iterations. Absent means **on**; set it false only for an endpoint that emits reasoning and rejects it on input (docs/reasoning-replay.md). |
| `pricingProvider` | openai only (docs/status-command.md). |
| `fallbackModel` | claude-sdk only. |

Empty optional strings delete the field (the file never carries settings that say nothing);
an absent field leaves the entry untouched. The resulting entry must pass the shape check:
openai needs a `baseUrl`; claude-sdk and codex refuse both `baseUrl` and `apiKeyEnv` -- those
backends own their targets and their token stores (docs/claude-sdk-backend.md, docs/codex-backend.md).

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
| `providers.remove` | key | `agents.config.result` |
| `providers.rename` | from, to | `agents.config.result` (rewrites `llm.models[].provider` and `llm.defaultProvider` in the same write) |
| `providers.env.set` | name, value | `providers.env.result` -- the only frame that carries a secret value; it is never echoed or logged |
| `providers.env.rename` | from, to | `providers.env.result` (repoints every provider that read the old name; a failed config write rolls the .env line back) |
| `providers.env.remove` | name | `providers.env.result` |
| `providers.env.list` | — | `providers.env.result` |

Every provider mutation calls `reloadConfigNow()` then refreshes the model catalog: a provider
that just gained a key (or just appeared) discovers its models now, not at the next 6h cycle.

## Refusals

- `remove` is refused while anything in the file still references the provider: `llm.defaultProvider`
  or a curated `llm.models[].provider`. Discovered models are not in the file and leave with the
  catalog; curated ones are the owner's declaration and are never dropped behind their back.
- `env.rename` onto an existing name is refused (`providers.env.set` is how you point a provider
  at a variable that already holds a value).
- `anthropic` / `chatgpt` may be deleted, but `/claude set-token` and `/codex login` recreate
  their provider on the next auth change (`src/index.ts`, `ensureAuthProvider`): the app says so
  in the delete confirmation.
- Errors ride the `error` frame with scope `providers`, and the refusing log line never carries
  an env value.
