# Subscription accounts: ChatGPT and Claude from the app

A ChatGPT plan (Codex backend, docs/codex-backend.md) or a Claude plan (docs/anthropic-backend.md)
is signed in from the app: Settings → Providers → Subscriptions. `/codex` and `/claude` still
work; both paths share the token stores and the provider bootstrap (`onAuthChanged` in
`src/index.ts`: the provider is added to the config if missing, the auth re-sampled, discovery
re-run, the model list pushed).

## Frames

| client | effect |
|---|---|
| `accounts.get` | state, to the asker |
| `accounts.login {provider}` | starts a sign-in; a second tap while one is live returns the same one |
| `accounts.cancel {provider}` | drops it (ChatGPT: stops the polling) |
| `accounts.code {code}` | Claude: the code its page shows after approval |
| `accounts.token {token}` | Claude: a long-lived `claude setup-token` token, refused unless `sk-ant-oat…` |
| `accounts.logout {provider}` | removes the stored credential |

`accounts.result` carries, per account, `connected`, ChatGPT's `email` and `plan` (read from the
access token's claims, no request), Claude's `source` (`oauth`, `token`, or `env` when the token
is `CLAUDE_CODE_OAUTH_TOKEN` in the server's environment, which sign-out cannot remove), and
`login` (`url`, ChatGPT's `code`, `expiresAt`) while a sign-in is in flight. Changes answer every
window of the owner.

## The two flows

- **ChatGPT**: device code. The page shows the code and opens `auth.openai.com/codex/device`; the
  server polls in the background and pushes `accounts.result` (with `error` if it was denied or
  expired) to every device when it ends. The code lives in memory: a restart mid-sign-in costs a
  new one. Device-code sign-in must be allowed in ChatGPT → Settings → Security.
- **Claude**: PKCE with a pasted code. The page opens `platform.claude.com/oauth/authorize`, the
  owner approves and pastes back what the page shows (`code#state`, the full URL, or the bare
  code). The verifier stays in memory, 10 minutes.

Secrets travel only client → server, are never logged, and a refusal names the failure without
echoing the frame.
