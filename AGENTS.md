# Development Rules

## Language & Runtime

- TypeScript, targeting Bun
- Strict types, no `any` unless absolutely necessary
- Top-level imports only, no dynamic imports

## Code Style

- No emojis in code, commits, or comments
- No comments unless the WHY is non-obvious
- Keep it simple, no premature abstractions
- No backward-compatibility shims

## Architecture Decisions

- All architecture and design decisions are documented in `docs/`
- Never decide on architecture, features, or design without explicit user approval
- When in doubt, ask

## Git

- Never commit unless the user asks
- Never use `git add -A` or `git add .`
- Always add specific files
- Never force push
- Never use `--no-verify`

## Releases

**IMPORTANT: Always wait for explicit user approval before tagging or creating a release.**
- Never bump version, tag, or push a new release without the user saying "go" or explicitly asking for it
- The user controls the release cadence — even if the code is ready and CI is green, wait for the green light
- This rule takes precedence over any automation or script that might suggest tagging

## Project Structure

```
src/
├── core/
│   ├── config.ts          # App configuration + types
│   └── router.ts          # Message routing (router/ moved here)
├── agent/
│   ├── bridge.ts          # LLM agent orchestration
│   ├── iteration-budget.ts # Per-agent iteration budget (consume/refund/remaining)
│   ├── tool-status.ts     # Tool call formatting (verbose/compact with timing)
│   ├── approvals.ts
│   ├── blacklist.ts
│   ├── sub-agents.ts
│   └── prompt/
│       ├── builder.ts
│       ├── loader.ts
│       └── platform-hints.ts
├── channels/
│   ├── types.ts           # UnifiedMessage, ChannelAdapter, shared types
│   ├── model-picker.ts
│   ├── context-visibility.ts
│   ├── telegram/
│   │   ├── adapter.ts     # Grammy boot, handler wiring, lifecycle
│   │   ├── send.ts        # All outgoing send/edit/delete methods
│   │   ├── context.ts     # History, thread roots, reply context
│   │   ├── commands.ts
│   │   ├── errors.ts
│   │   ├── format.ts
│   │   ├── offset-store.ts
│   │   ├── policy.ts
│   │   ├── reactions.ts
│   │   ├── session-handlers.ts
│   │   ├── split.ts
│   │   └── stream.ts
│   └── matrix/
│       ├── adapter.ts     # Timeline ingress, handler wiring, lifecycle
│       ├── send.ts        # All outgoing send/edit/upload methods
│       ├── context.ts     # Room history, thread context, reply context
│       ├── actions.ts
│       ├── approval-store.ts
│       ├── client.ts
│       ├── commands.ts
│       ├── crypto-idb.ts
│       ├── decrypt-bridge.ts
│       ├── errors.ts
│       ├── file-sync-store.ts
│       ├── format.ts
│       ├── helpers.ts
│       ├── history.ts
│       ├── inbound-buffer.ts
│       ├── inbound-dedupe.ts
│       ├── ingress.ts
│       ├── policy.ts
│       ├── polls.ts
│       ├── reactions.ts
│       ├── retry.ts
│       ├── session-handlers.ts
│       ├── storage.ts
│       ├── stream.ts
│       ├── sync-lifecycle.ts
│       ├── sync-store.ts
│       ├── text.ts
│       └── types.ts
├── llm/
│   └── provider.ts        # OpenAI-compatible API client
├── sessions/
│   ├── manager.ts
│   └── store.ts
├── tools/
│   ├── types.ts
│   ├── registry.ts
│   ├── bash.ts
│   ├── read.ts
│   ├── write.ts
│   ├── fetch.ts
│   ├── find.ts
│   ├── grep.ts
│   ├── ls.ts
│   └── memory.ts
├── mcp/                   # Reserved for future MCP integration
├── skills/                # Reserved for future skill system
├── utils/
│   ├── logger.ts
│   └── media.ts
└── index.ts               # Entry point (3 lines: import boot from core, call it)
```

### Splitting rules

- A channel folder (`channels/telegram/`, `channels/matrix/`) contains:
  - `adapter.ts` : Grammy/SDK boot, handler wiring, lifecycle only
  - `send.ts` : All outgoing methods (send, edit, delete, upload)
  - `context.ts` : Room/thread history, reply context, sender resolution
- Any file over **500 lines** is a candidate for extraction. Not automatic, but a signal.
- `core/` avoids dependencies on `channels/`, `agent/`, `tools/` where possible. `router.ts` bridges `channels/` and `agent/` by design.
- `mcp/` and `skills/` stay empty until the feature is activated. No `.gitkeep` clutter.

### Workspace

- The agent operates inside `~/.my-claw/workspace/` (configurable via `config.workspace`).
- The workspace is created on boot if it does not exist.
- Default prompt templates (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`) are copied from `docs/prompt/` into the workspace on first start.
- All filesystem tools (`bash`, `read`, `write`, `ls`, `find`, `grep`) resolve relative paths against the workspace.
- `bash` spawns with `cwd` set to the workspace.

### Imports

- Use `../types.ts` for shared channel types when inside a channel subfolder.
- Use `../../core/config.ts` for config when inside a channel subfolder.
- Use `../../utils/logger.ts` for logging when inside a channel subfolder.

- Specs and architecture docs go in `docs/`
- Specs are built incrementally through discussion with the user
