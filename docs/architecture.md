# Architecture - my-claw

## Decisions

### Channels

- Telegram: classic bot (Bot API) -- priority
- Matrix: classic bot -- priority
- Discord: classic bot (bot token) -- on hold until further notice

### Scope & permissions

- Full access on the VM (filesystem, shell, network, everything)
- Blacklist system for sensitive actions:
  - Commands/tools on the blacklist require explicit accept (interactive accept/deny button in the channel)
  - No accept -> automatically denied (not executed)
  - Everything NOT on the blacklist runs without confirmation
  - Blacklist empty by default (everything passes), populated over time
  - Planned for: email sending, sensitive skills, etc.

### Sessions & isolation

- One session per DM (per authorized user)
- One session per group (each Matrix/Telegram group has its own isolated session)
- One file per actual session
- Sessions persist across restarts
- Sessions stored in `~/.my-claw/sessions/`

### Auth & access

- Agent only responds to authorized users, no exceptions
- Forwarded messages from an authorized user are processed normally
- Global whitelist (an authorized user has access everywhere)

### Storage

```
~/.my-claw/
├── config.json              # global config (providers, models, whitelist, blacklist, etc.)
├── agents/                  # sub-agent configs
│   ├── general.json
│   └── research.json
├── prompt/                  # system prompt files
│   ├── SOUL.md
│   ├── AGENTS.md
│   ├── USER.md
│   └── MEMORY.md
├── sessions/
│   ├── telegram/
│   │   ├── dm/
│   │   │   └── <user_id>.json
│   │   └── group/
│   │       └── <group_id>.json
│   └── matrix/
│       ├── dm/
│       │   └── <user_id>.json
│       └── room/
│           └── <room_id>.json
└── logs/
```

- Config format: JSON (jq-compatible)

### pi-mono integration

- SDK direct import as primary method (same process)
- RPC or subprocess when needed (isolation, crash recovery)

### LLM

- Standard API: OpenAI-compatible (universal format)
- Any OpenAI-compatible provider works (Fireworks, OpenRouter, Ollama, LM Studio, etc.)
- Current provider: Fireworks AI (FirePass, Kimi K2.5 Turbo, $7/week)
- Model configurable per session/agent
- Auth: API key per provider (env vars)

### Sub-agents

- 2 predefined sub-agent types:
  - **general**: same capabilities as the main agent (read, write, bash, everything)
  - **research**: read-only, exploration, command execution without modifications
- LLM inheritance: sub-agent uses main agent's LLM by default
- If a sub-agent has a specific LLM config, it uses that instead
- Limit: 3 simultaneous sub-agents max
- Max depth: 2 levels (main -> sub-agent -> sub-sub-agent, no deeper)
- Config in `~/.my-claw/agents/`

### Invocation

- DM: responds to every message from an authorized user
- Group: responds to every message from an authorized user (no mention required)
- Forwarded messages from an authorized user: processed normally

### System prompt

- Layered architecture (ordered layers, joined with newlines)
- Inspired by Hermes Agent + OpenClaw
- Format: markdown files (SOUL.md, AGENTS.md, USER.md, MEMORY.md)
- Configurable (not hardcoded)

#### Prompt build order

| # | Layer | Source |
|---|---|---|
| 1 | Identity | SOUL.md |
| 2 | Directives | AGENTS.md |
| 3 | User context | USER.md |
| 4 | Memory | MEMORY.md (frozen snapshot) |
| 5 | Tools | Available tool list |
| 6 | Platform hints | Telegram vs Matrix formatting guidance |
| 7 | Runtime | Date, model, channel, session ID |
