# Subscription accounts: ChatGPT and Claude plans are providers

A ChatGPT plan (Codex backend, docs/codex-backend.md) or a Claude plan (docs/anthropic-backend.md)
is a provider like any other, listed with the keyed ones on Settings → Models. "Subscription or
API key, it is a provider" (owner, 2026-10-04). The `+` of the providers offers, in order: ChatGPT
plan, Claude plan, Claude API key, Custom.

## One provider, one sign-in

```
config.llm.providers                       ~/.my-claw/accounts/   (0600 files)
  chatgpt         { type: codex, group: "ChatGPT perso" }   ──►  chatgpt.json
  chatgpt-boulot  { type: codex, group: "ChatGPT boulot" }  ──►  chatgpt-boulot.json
  anthropic       { type: anthropic, group: "Claude" }      ──►  anthropic.json
  claude-api      { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }   (a key: no account)
```

- **Which providers hold a sign-in** (`accountKindOf`): `codex` always; `anthropic` when it
  declares neither `apiKeyEnv` nor `baseUrl` (a keyed or relayed Anthropic is judged by its key).
- **Id, kind, name**: the provider key is the id (models are `claude-2/claude-opus-5-5`, the
  sign-in is `accounts/claude-2.json`); the type is the kind; `group` is the owner's name,
  renamed at will. A new account's key is the kind's short id -- `claude`, `chatgpt`, numbered
  when taken (`claude-2`) -- and never follows the name: the key is what every reference carries,
  the name is free to change (`accountKeyFor`).
- **Identity**: each sign-in reads who it is (`/api/oauth/profile` with the subscription token,
  the JWT claims for ChatGPT) and stores the email beside the credential, so the Accounts page
  shows the account rather than just "Connected" -- the PKCE flow alone cannot say which account
  was approved. A sign-in whose email is already connected on another provider is **refused**
  ("already connected on provider X"): approving the page in a browser signed in to the other
  account is otherwise invisible, and nothing downstream could tell. A profile call that fails
  (offline) never blocks a sign-in; the identity is retried on the next visit to the page.
- **Runnable** (`run-model.ts`): a plan's models are offered while *that* provider is signed in
  (`AvailabilityWorld.signedIn(provider)`), sampled on boot, on every config reload, after
  discovery and after each sign-in change. Signing a second account out hides only its models.
- Removing a provider deletes its sign-in; renaming its key moves the file.
- Tokens refresh per provider (one in-flight refresh per key). A tag route can name models of two
  accounts: an exhausted quota on the first moves to the second (docs/provider-failures.md).

## Before: one sign-in per server, and `.env`

Until 0.7.86 there was one ChatGPT file (`~/.my-claw/codex/auth.json`) and one Claude source: its
file (`~/.my-claw/claude/auth.json`) or `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, read as a fallback, so
the app could not sign it out. `adoptLegacyAccounts` (boot, every `.env` change, every config reload, so a plan declared later adopts what was left for it) gives each to
the **first provider of its kind** that has no sign-in yet, then removes it from where it was: the
Claude line of `.env` is dropped (snapshotted first, like every `.env` write), even when the account
already had a sign-in, so there is one source per account and Sign out is a sign out. The env token
is not read anywhere else any more.

No two providers read alike (2026-10-05): `upsertProvider` refuses a name (its `group`, else its
key) another provider already reads as, case aside, whenever the name changes, so a config that
already holds a duplicate can still edit its other fields. The names the server picks itself
(`accountFor`, the CLI) go through `freeProviderName` and are numbered (`Claude 2`).

No sign-in is ever left on a provider that does not exist, or it would never be offered. On a fresh
install the Claude token of `.env` finds no plan: it declares one (`PLAN_PROVIDER`, key `claude`,
numbered if taken), as `/claude` would, then is adopted by it. The CLI does the same once a sign-in
is stored (`myclaw claude set-token`, `myclaw codex login`), and the running server hears the files
of `~/.my-claw/accounts/` change (`watchAccounts`), so a sign-in made from a terminal reaches the
picker without a restart.

## Frames

| client | effect |
|---|---|
| `accounts.get` | state, to the asker |
| `accounts.add {kind, name}` | declares a new plan provider; the answer names it in `added` |
| `accounts.rename {provider, name}` | sets its `group` |
| `accounts.login {provider}` | starts a sign-in; a second tap while one is live returns the same one |
| `accounts.cancel {provider}` | drops it (ChatGPT: stops the polling) |
| `accounts.code {provider, code}` | Claude: the code its page shows after approval |
| `accounts.token {provider, token}` | Claude: a long-lived `claude setup-token` token, refused unless `sk-ant-oat…` |
| `accounts.logout {provider}` | removes that provider's sign-in |

`accounts.result` carries `accounts`: per plan provider, `provider`, `kind`, `name`, `connected`,
ChatGPT's `email` and `plan` (read from the access token's claims, no request), Claude's `email`
(from the stored profile) and `source` (`oauth` or `token`), and `login` (`url`, ChatGPT's `code`,
`expiresAt`) while a sign-in is in flight. It also carries `codex` and `claude`, the first account of each kind in the shape an app older than 0.6.129 reads: without them that page throws on the missing field during the window
between the server's update and the APK's. Changes answer every window of the owner. The providers
list (`agents.config.result`) marks a plan with `account: "codex" | "claude"`, and its `keyPresent`
says whether it is signed in.

## The two flows

- **ChatGPT**: device code. The page shows the code and opens `auth.openai.com/codex/device`; the
  server polls in the background and pushes `accounts.result` (with `error` if it was denied or
  expired) to every device when it ends. The code lives in memory: a restart mid-sign-in costs a
  new one. Device-code sign-in must be allowed in ChatGPT → Settings → Security. A second account
  is approved in a browser signed in to *that* ChatGPT account (a private window, or sign out of
  the first one there): the page says so. The email that lands is checked against the other
  connected accounts, and a duplicate is refused before the credential is written.
- **Claude**: PKCE with a pasted code. The page opens `platform.claude.com/oauth/authorize`, the
  owner approves and pastes back what the page shows (`code#state`, the full URL, or the bare
  code). One Claude sign-in at a time: the verifier, in memory for 10 minutes, belongs to the
  provider it was started for, and a code pasted on another account's page is refused. Once the
tokens are exchanged, the account's identity is read and a duplicate refused; a pasted long-lived
token is read the same way.

`/codex` and `/claude` act on the first account of their kind (declared if there is none); the CLI
takes `--provider <key>`. Secrets travel only client → server, are never logged, and a refusal
names the failure without echoing the frame.
