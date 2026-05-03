# System Prompt Research -- Hermes Agent vs OpenClaw

## Comparatif

### Architecture generale

| | Hermes Agent | OpenClaw |
|---|---|---|
| Langage | Python | TypeScript |
| Construction | `_build_system_prompt()` dans run_agent.py | `buildAgentSystemPrompt()` dans system-prompt.ts |
| Cache | Build une fois par session, invalide a la compression | Deux zones (stable/dynamique) separees par un marqueur cache |
| Layers | 10 couches ordonnees, `"\n\n".join()` | 2 zones (~20 sections stable + ~10 sections dynamiques) |
| Fichier principal | `agent/prompt_builder.py` | `src/agents/system-prompt.ts` |

### Fichiers de personnalite

| Fichier | Hermes | OpenClaw | Role |
|---|---|---|---|
| SOUL.md | `~/.hermes/SOUL.md` | `workspace/SOUL.md` | Personnalite, ton, identite |
| AGENTS.md | cwd (contexte projet) | `workspace/AGENTS.md` | Regles de comportement agent |
| IDENTITY.md | non | `workspace/IDENTITY.md` | Nom, avatar, emoji, type |
| USER.md | via memory tool | `workspace/USER.md` | Profil utilisateur |
| MEMORY.md | via memory tool | `workspace/MEMORY.md` | Memoire long terme |
| TOOLS.md | non | `workspace/TOOLS.md` | Notes sur les outils locaux |
| HEARTBEAT.md | non | `workspace/HEARTBEAT.md` | Taches periodiques |
| BOOTSTRAP.md | non | `workspace/BOOTSTRAP.md` | Premier lancement, supprime apres |

### Couches du system prompt

#### Hermes Agent (10 couches, dans l'ordre)

| # | Couche | Source | Dynamique ? |
|---|---|---|---|
| 1 | Identite agent | SOUL.md ou DEFAULT_AGENT_IDENTITY | Non (cache) |
| 1.5 | Help guidance | Constante HERMES_AGENT_HELP_GUIDANCE | Non |
| 2 | Guidance par tool | Constantes conditionnelles (memory, skills, kanban) | Non |
| 2.5 | Nous subscription | build_nous_subscription_prompt() | Non |
| 3 | Enforcement modele | Guidance specifique GPT/Gemini/Codex | Non |
| 4 | System message custom | Parametre caller (gateway/CLI) | Non |
| 5 | Memoire persistante | MEMORY.md + USER.md (snapshots figes) | Non |
| 6 | Index skills | Skills XML avec cache LRU + disque | Non |
| 7 | Fichiers contexte | AGENTS.md / CLAUDE.md / .cursorrules (1 seul, priorite) | Non |
| 8 | Timestamp + session | Date, session ID, model, provider | Non |
| 9 | Hints environnement | Detection WSL | Non |
| 10 | Hints plateforme | Formatage par channel (telegram, discord, matrix...) | Non |

**Injections runtime (hors cache)** :
- Ephemeral system prompt (env var / config / /personality)
- Prefill messages
- Session context (gateway : platform, user, channel topic)
- Memory nudge / skill review (dans le user message, pas le system prompt)

#### OpenClaw (2 zones, ~30 sections)

**Zone stable (cacheable)** :

| Section | Contenu |
|---|---|
| Identite | "You are a personal assistant running inside OpenClaw." |
| Tooling | Liste des tools avec descriptions |
| Style interaction | Overlay configurable (ex: GPT-5 friendly) |
| Style tool call | Guidance d'utilisation des tools |
| Execution bias | Approche d'execution |
| Securite | Anti-manipulation, pas d'auto-replication |
| CLI reference | Commandes gateway |
| Skills | XML blocks avec descriptions |
| Memoire | Guidance memory tool |
| Self-update | Gestion updates |
| Model aliases | Mappings configures |
| Workspace | Working dir, sandbox info |
| Docs | URLs documentation |
| Authorized senders | Owner identity |
| Date/heure | Timezone utilisateur |
| Output directives | Tags MEDIA, reply tags |
| Fichiers projet | AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md |
| Silent replies | Token NO_REPLY |

**Zone dynamique (par tour)** :

| Section | Contenu |
|---|---|
| Fichiers dynamiques | HEARTBEAT.md |
| Webchat canvas | Si channel webchat |
| Messaging | Guidance channel + boutons inline |
| TTS | Config voix |
| Group chat context | Extra prompt du contexte appelant |
| Reactions | Guidance reactions par channel |
| Provider suffix | Additions provider-specifiques |
| Heartbeats | Instructions heartbeat poll |
| Runtime | agent, host, os, model, channel, capabilities |
| Reasoning level | Mode reasoning actuel |

### Securite des prompts

| | Hermes | OpenClaw |
|---|---|---|
| Scan injection | `_scan_context_content()` -- 10 patterns + unicode invisible | `sanitize-for-prompt.ts` -- sanitize strings non fiables |
| Troncature | 20,000 chars (70% head / 20% tail) | 20,000 chars/fichier, 150,000 total |
| PII | Redaction optionnelle (gateway sessions) | Owner identity hashable SHA-256 |

### Configurabilite

| | Hermes | OpenClaw |
|---|---|---|
| Per-agent | Oui (params init : platform, skip_context, skip_memory) | Oui (config.agents.list[].systemPromptOverride) |
| Per-session | /personality command (predefined personas) | Per-workspace files (SOUL.md, AGENTS.md) |
| Per-channel | PLATFORM_HINTS dict (formatage par plateforme) | Channel-specific messaging guidance |
| Override total | HERMES_EPHEMERAL_SYSTEM_PROMPT env var | systemPromptOverride dans config |
| Sous-agents | `_build_child_system_prompt()` -- prompt dedie a la tache | `subagent-system-prompt.ts` -- mode "minimal" |
| Plugins | Hooks pre-LLM dans user message (pas system prompt) | Hooks `before_prompt_build`, `agent_turn_prepare` dans system prompt |

### Sous-agents

| | Hermes | OpenClaw |
|---|---|---|
| Prompt sous-agent | Completement different (focus tache) | Mode "minimal" (sections reduites) |
| Spawn | `delegate_tool.py` -- _build_child_system_prompt() | `subagent-system-prompt.ts` |
| Memoire | Pas de memoire injectee | Pas de memoire injectee (skip) |
| Contexte workspace | Optionnel (workspace path) | Herite du workspace parent |

## Points cles pour my-claw

### Ce qu'on retient de Hermes

1. **SOUL.md** comme fichier unique de personnalite editable par l'utilisateur
2. **Couches ordonnees** -- simple a comprendre et debugger
3. **Cache une fois par session** -- pas de rebuild a chaque tour
4. **Snapshots figes pour la memoire** -- evite d'invalider le cache
5. **Scan anti-injection** sur tout fichier externe charge
6. **PLATFORM_HINTS** -- guidance de formatage par channel (essentiel pour nous)
7. **Ephemeral system prompt** -- overlay temporaire sans toucher au cache

### Ce qu'on retient d'OpenClaw

1. **Deux zones (stable/dynamique)** -- meilleur pour le cache LLM
2. **Fichiers separes par role** (SOUL, IDENTITY, USER, TOOLS, MEMORY) -- plus modulaire
3. **BOOTSTRAP.md** -- premier lancement guide puis supprime
4. **Provider contributions** -- adaptations par famille de modele
5. **Prompt mode** (full/minimal/none) -- pour les sous-agents
6. **Runtime line** -- metadata machine injectee (os, model, channel, capabilities)
