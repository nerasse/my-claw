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

## Project Structure

```
src/
├── core/
│   ├── config.ts          # App configuration + types
│   └── router.ts          # Message routing (router/ moved here)
├── agent/
│   ├── bridge.ts          # LLM agent orchestration
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
- `core/` has no dependencies on `channels/`, `agent/`, `tools/`.
- `mcp/` and `skills/` stay empty until the feature is activated. No `.gitkeep` clutter.

### Imports

- Use `../types.ts` for shared channel types when inside a channel subfolder.
- Use `../../core/config.ts` for config when inside a channel subfolder.
- Use `../../utils/logger.ts` for logging when inside a channel subfolder.

- Specs and architecture docs go in `docs/`
- Specs are built incrementally through discussion with the user
