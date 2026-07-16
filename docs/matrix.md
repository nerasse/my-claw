# Matrix Channel

## Overview

Matrix adapter built on `matrix-js-sdk` with full E2EE support, room/Thread scoping, and granular access control.

## File Structure

```
src/channels/matrix/
├── adapter.ts          # Main adapter: timeline ingress, message routing, commands
├── client.ts           # Matrix SDK runtime: crypto bootstrap, sync lifecycle
├── policy.ts           # DM/room detection, allowlists, autoJoin filtering
├── ingress.ts          # Timeline event normalization and room history prep
├── context.ts          # Room/thread history, reply context, room history text
├── send.ts             # All outbound: send, edit, upload, stream finalization
├── format.ts           # Mention resolution, text formatting, reply fallback strip
├── stream.ts           # Streaming previews via `m.replace`
├── commands.ts         # `/new`, `/model`, `/status`, `/stop`, `/clear`, `/help`, `/archive`, `/reload-skills`
├── session-handlers.ts # Model menus, approval prompts, status replies
├── actions.ts            # Reaction/text-reply action resolution
├── approval-store.ts     # Persisted approval prompts across restarts
├── history.ts            # Room history tracker
├── inbound-buffer.ts     # Fragmented burst coalescing
├── inbound-dedupe.ts     # Event claim/commit/release with persistence
├── sync-lifecycle.ts      # Cold-start backlog drop, clean-shutdown marker
├── file-sync-store.ts     # File-backed sync token store
├── polls.ts              # Poll event normalization to text
├── errors.ts             # Error classification and reporting
├── storage.ts            # Matrix account storage paths
├── crypto-idb.ts         # IndexedDB crypto snapshot persistence
├── decrypt-bridge.ts      # Encrypted event decryption retry bridge
├── helpers.ts            # ID normalization, member state helpers
├── text.ts               # Text chunking
└── types.ts              # Matrix-specific types
```

## Configuration

```json
{
  "channels": {
    "matrix": {
      "enabled": true,
      "homeserver": "https://matrix.kssimi.fr",
      "accessToken": "",
      "userId": "@claw:kssimi.fr",
      "deviceId": "xxx",
      "password": "",
      "encryption": true,
      "autoJoin": "allowlist",
      "dm": {
        "enabled": true,
        "policy": "allowlist",
        "allowFrom": ["@neras:kssimi.fr"],
        "sessionScope": "per-room"
      },
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["@neras:kssimi.fr"],
      "allowBots": false,
      "groups": {
        "*": {
          "enabled": true,
          "autoReply": true
        }
      },
      "contextVisibility": "allowlist_quote",
      "historyLimit": 10,
      "replyToMode": "first",
      "streaming": {
        "enabled": true,
        "mode": "partial",
        "minChars": 30,
        "throttleMs": 1000
      }
    }
  }
}
```

## Security Model

### Authentication
- Access token + device ID for SDK auth
- Optional password for initial login (token preferred)

### Auto-Join (who can invite)
```
autoJoin: "off" | "always" | "allowlist"
```

With `allowlist`, the bot verifies the **inviter identity** against:
- `dm.allowFrom`
- `groupAllowFrom`
- `groups.*.users`

Only allowlisted users can invite the bot. Unknown invitations are silently rejected.

### DM Policy
```
dm.policy: "open" | "allowlist" | "disabled"
```
- `allowlist` (default): only `dm.allowFrom` users can DM
- `open`: any user (requires `allowFrom: ["*"]`)
- `disabled`: all DMs ignored

### Room/Group Policy
```
groupPolicy: "open" | "allowlist" | "disabled"
```
- `allowlist` (default): room must be configured in `groups` and sender in `groupAllowFrom` or per-room `users`
- `open`: any room, mention-gating only
- `disabled`: all room messages ignored

### Mention Gating
- `autoReply: true` → no mention required for allowlisted users
- `autoReply: false` / `requireMention: true` → `@botname` or reply-to-bot required
- Commands addressed to bot (`/cmd@botname`) always pass

### Bot-to-Bot
```
allowBots: false | true | "mentions"
```
- `false` (default): all bot messages ignored
- `mentions`: bot messages allowed only if bot is @mentioned in group
- `true`: all bot messages allowed
- `botUserIds`: whitelist specific bot MXIDs

### Context Visibility
```
contextVisibility: "all" | "allowlist" | "allowlist_quote"
```
- `all`: agent sees all messages in room context
- `allowlist`: agent only sees messages from allowlisted senders
- `allowlist_quote`: same as `allowlist`, but reply quotes from non-allowlisted senders are still shown

### Meta-Command Filtering
Commands (`/help`, `/status`, `/stop`, `/model`, `/compact`, `/reload-skills`, `/clear`, `/archive`, `/commands`, `/models`) and their responses are **not injected** into the LLM's `[Recent Room Context]`. This prevents meta-commands from polluting the conversation context. Only `/new` is preserved as a session boundary marker.

## DM Detection

DMs are detected by **protocol-level signals only**:
1. `room.getDMInviter()` returns a value (room is in `m.direct` account data)
2. No fallback to member count. A 2-member room without `m.direct` is treated as a normal group room.

This prevents session sharing across private admin/monitoring channels.

## Encryption

- Enable: `channels.matrix.encryption: true`
- Requires real `userId` and `deviceId` matching the access token
- Rust-crypto bootstrap via `@matrix-org/matrix-sdk-crypto-wasm`
- Local crypto snapshot persisted under `~/.my-claw/matrix/accounts/...`
- Can seed initial snapshot from OpenClaw migration
- Encrypted media: download + decrypt when crypto ready, upload encrypted for encrypted rooms

## Session Scoping

| Context | Session ID |
|---------|-----------|
| DM (per-user) | `matrix/dm/<userId>` |
| DM (per-room) | `matrix/dm-room/<roomId>` |
| Room | `matrix/room/<roomId>` |
| Thread | `matrix/thread/<roomId>/<threadId>` |

## Commands

All commands are text-based (Matrix has no native command UI):

| Command | Action |
|---------|--------|
| `/new` | Reset current session (preserved in context as boundary) |
| `/model` | Show model selection menu |
| `/models` | List available models |
| `/compact` | Compact session context (summarize middle, keep head+tail) |
| `/reload-skills` | Rescan skills from disk and refresh registry |
| `/status` | Show current model, stats, and live run tree |
| `/stop` | Stop the running agent and all its sub-agents |
| `/clear` | Clear session history |
| `/archive` | Delete archived sessions |
| `/help` / `/commands` | Show command list |

## Delivery

- **Reply modes**: `off`, `first`, `all`, `batched`
- **Threading**: Full `m.thread` relation support
- **Streaming**: Preview via `m.replace`, final edit or fallback redact
- **Reactions**: `m.reaction` for status and menu selection
- **Menu steps are new messages**: each navigation step of the `/model` menu is sent as a
  fresh message with its own seeded numbered reactions. Matrix does not let a user re-react
  with an emoji they already used, and an edited message keeps the old reaction count — so
  editing menus in place broke re-selection and left submenus with too few reactions. The
  superseded menu collapses to a one-line breadcrumb and its bot reactions are redacted.
- **Model -> effort chaining**: the active effort is shown on the menu header line next to
  the model (not as a button); selecting a model chains straight into the reasoning-effort
  choice (with a `Keep current` entry) so switching both is one flow; `/effort` remains the
  quick standalone path. Terminal steps (set/keep effort, model selected without effort
  enabled) edit the menu message in place and drop its reactions.
- **Read receipts**: `m.read` sent on processed events
- **Typing**: Supported by protocol, not yet wired in adapter
- **Text chunking**: `textChunkLimit` + `chunkMode: length | newline`
- **Media**: Plain + encrypted download/upload with timeout guards
- **Polls**: Normalized to text for routing and history

## Reliability

- **Persisted sync store**: Survives restarts, enables replay recovery
- **Clean-shutdown marker**: Only trusts replay after graceful stop
- **Cold-start backlog drop**: Drops pre-startup events if sync untrusted
- **Inbound dedupe**: `claim -> commit` with TTL pruning and cross-process claim files
- **Retry logic**: `withMatrixRetry()` on all delivery paths, honors `retry_after_ms`
- **Fragment coalescing**: Merges rapid split turns, attachment bursts, and media captions

## Logs

- App: `~/.my-claw/logs/matrix-YYYY-MM-DD(.N).log`
- SDK: `~/.my-claw/logs/matrix-sdk-YYYY-MM-DD(.N).log`

## Validation

```bash
bun run check
bun test tests/matrix-*.test.ts
```
