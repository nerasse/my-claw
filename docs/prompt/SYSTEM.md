# SYSTEM.md — System Reference

This file documents the system-level rules that my-claw enforces.
It is NOT injected into the AI prompt — it is for your reference only.

## Core Rules (hardcoded, always active)

- Check skills and tools before acting
- Use tools to act — never describe without doing
- Safety first: no independent goals, no self-preservation
- Verify before finalizing: check correctness and grounding
- Mutable facts need live checks (files, git, clocks, versions)
- After manage_skills(create/update/delete), registry auto-refreshes
- Only use the memory tool when the user explicitly asks

## How It Works

The AI receives a minimal hardcoded prompt (~25 lines) with safety and core rules.
Everything else comes from:

1. **Tool descriptions** — Each tool explains when and how to use it
2. **Skills** — Loaded on-demand via `read_skill(name)` when relevant
3. **Workspace files** — Your custom rules and context

## Customization

Override style and personality in `SOUL.md`.
Add workspace rules and conventions in `AGENTS.md`.
Store user context in `USER.md`.
Keep long-term memory in `MEMORY.md`.

## Session Startup

Before doing anything else, the AI reads:
1. `SOUL.md` — who it is
2. `USER.md` — who it is helping
3. `MEMORY.md` — long-term context
4. `AGENTS.md` — workspace rules
