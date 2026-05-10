# System Prompt Research -- Hermes Agent vs OpenClaw

## Comparison

### General Architecture

| | Hermes Agent | OpenClaw |
|---|---|---|---
| Language | Python | TypeScript |
| Construction | `_build_system_prompt()` in run_agent.py | `buildAgentSystemPrompt()` in system-prompt.ts |
| Cache | Built once per session, invalidated on compression | Two zones (stable/dynamic) separated by a cache marker |
| Layers | 10 ordered layers, `"\n\n".join()` | 2 zones (~20 stable sections + ~10 dynamic sections) |
| Main file | `agent/prompt_builder.py` | `src/agents/system-prompt.ts` |

### Personality Files

| File | Hermes | OpenClaw | Role |
|---|---|---|---|
| SOUL.md | `~/.hermes/SOUL.md` | `workspace/SOUL.md` | Personality, tone, identity |
| AGENTS.md | cwd (project context) | `workspace/AGENTS.md` | Agent behavior rules |
| IDENTITY.md | no | `workspace/IDENTITY.md` | Name, avatar, emoji, type |
| USER.md | via memory tool | `workspace/USER.md` | User profile |
| MEMORY.md | via memory tool | `workspace/MEMORY.md` | Long-term memory |
| TOOLS.md | no | `workspace/TOOLS.md` | Notes on local tools |
| HEARTBEAT.md | no | `workspace/HEARTBEAT.md` | Periodic tasks |
| BOOTSTRAP.md | no | `workspace/BOOTSTRAP.md` | First launch, deleted after |

### System Prompt Layers

#### Hermes Agent (10 layers, in order)

| # | Layer | Source | Dynamic? |
|---|---|---|---|
| 1 | Agent identity | SOUL.md or DEFAULT_AGENT_IDENTITY | No (cache) |
| 1.5 | Help guidance | Constant HERMES_AGENT_HELP_GUIDANCE | No |
| 2 | Per-tool guidance | Conditional constants (memory, skills, kanban) | No |
| 2.5 | Nous subscription | build_nous_subscription_prompt() | No |
| 3 | Model enforcement | GPT/Gemini/Codex specific guidance | No |
| 4 | Custom system message | Caller parameter (gateway/CLI) | No |
| 5 | Persistent memory | MEMORY.md + USER.md (frozen snapshots) | No |
| 6 | Skills index | Skills XML with LRU cache + disk | No |
| 7 | Context files | AGENTS.md / CLAUDE.md / .cursorrules (1 only, priority) | No |
| 8 | Timestamp + session | Date, session ID, model, provider | No |
| 9 | Environment hints | WSL detection | No |
| 10 | Platform hints | Formatting by channel (telegram, discord, matrix...) | No |

**Runtime injections (outside cache)**:
- Ephemeral system prompt (env var / config / /personality)
- Prefill messages
- Session context (gateway: platform, user, channel topic)
- Memory nudge / skill review (in the user message, not the system prompt)

#### OpenClaw (2 zones, ~30 sections)

**Stable zone (cacheable)**:

| Section | Content |
|---|---|
| Identity | "You are a personal assistant running inside OpenClaw." |
| Tooling | Tool list with descriptions |
| Interaction style | Configurable overlay (ex: GPT-5 friendly) |
| Tool call style | Tool usage guidance |
| Execution bias | Execution approach |
| Security | Anti-manipulation, no auto-replication |
| CLI reference | Gateway commands |
| Skills | XML blocks with descriptions |
| Memory | Memory tool guidance |
| Self-update | Update management |
| Model aliases | Configured mappings |
| Workspace | Working dir, sandbox info |
| Docs | Documentation URLs |
| Authorized senders | Owner identity |
| Date/time | User timezone |
| Output directives | MEDIA tags, reply tags |
| Project files | AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md |
| Silent replies | NO_REPLY token |

**Dynamic zone (per turn)**:

| Section | Content |
|---|---|
| Dynamic files | HEARTBEAT.md |
| Webchat canvas | If webchat channel |
| Messaging | Channel guidance + inline buttons |
| TTS | Voice config |
| Group chat context | Extra prompt from caller context |
| Reactions | Per-channel reaction guidance |
| Provider suffix | Provider-specific additions |
| Heartbeats | Heartbeat poll instructions |
| Runtime | agent, host, os, model, channel, capabilities |
| Reasoning level | Current reasoning mode |

### Prompt Security

| | Hermes | OpenClaw |
|---|---|---|
| Injection scan | `_scan_context_content()` -- 10 patterns + invisible unicode | `sanitize-for-prompt.ts` -- sanitize untrusted strings |
| Truncation | 20,000 chars (70% head / 20% tail) | 20,000 chars/file, 150,000 total |
| PII | Optional redaction (gateway sessions) | Owner identity hashable SHA-256 |

### Configurability

| | Hermes | OpenClaw |
|---|---|---|
| Per-agent | Yes (init params: platform, skip_context, skip_memory) | Yes (config.agents.list[].systemPromptOverride) |
| Per-session | /personality command (predefined personas) | Per-workspace files (SOUL.md, AGENTS.md) |
| Per-channel | PLATFORM_HINTS dict (formatting by platform) | Channel-specific messaging guidance |
| Total override | HERMES_EPHEMERAL_SYSTEM_PROMPT env var | systemPromptOverride in config |
| Sub-agents | `_build_child_system_prompt()` -- task-dedicated prompt | `subagent-system-prompt.ts` -- "minimal" mode |
| Plugins | Pre-LLM hooks in user message (not system prompt) | Hooks `before_prompt_build`, `agent_turn_prepare` in system prompt |

### Sub-agents

| | Hermes | OpenClaw |
|---|---|---|
| Sub-agent prompt | Completely different (task-focused) | "Minimal" mode (reduced sections) |
| Spawn | `delegate_tool.py` -- _build_child_system_prompt() | `subagent-system-prompt.ts` |
| Memory | No memory injected | No memory injected (skip) |
| Workspace context | Optional (workspace path) | Inherited from parent workspace |

## Key takeaways for my-claw

### What we keep from Hermes

1. **SOUL.md** as a single editable personality file for the user
2. **Ordered layers** -- simple to understand and debug
3. **Cache once per session** -- no rebuild every turn
4. **Frozen snapshots for memory** -- avoids invalidating the cache
5. **Anti-injection scan** on every external file loaded
6. **PLATFORM_HINTS** -- formatting guidance per channel (essential for us)
7. **Ephemeral system prompt** -- temporary overlay without touching the cache

### What we keep from OpenClaw

1. **Two zones (stable/dynamic)** -- better for LLM cache
2. **Separate files per role** (SOUL, IDENTITY, USER, TOOLS, MEMORY) -- more modular
3. **BOOTSTRAP.md** -- guided first launch then deleted
4. **Provider contributions** -- adaptations per model family
5. **Prompt mode** (full/minimal/none) -- for sub-agents
6. **Runtime line** -- injected machine metadata (os, model, channel, capabilities)
