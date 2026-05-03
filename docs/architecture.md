# Architecture - my-claw

## Decisions

### Channels

- Telegram : bot classique (Bot API) -- prioritaire
- Matrix : bot classique -- prioritaire
- Discord : bot classique (bot token) -- mis de cote jusqu'a nouvel ordre

### Scope & permissions

- Full access sur la VM (filesystem, shell, tout)
- Systeme de liste noire pour les actions sensibles :
  - Les commandes/tools inscrits dans la liste noire necessitent un accept explicite (bouton interactif accept/deny dans le channel)
  - Si pas d'accept -> denied automatiquement (pas execute)
  - Tout ce qui n'est PAS dans la liste noire passe sans confirmation
  - Liste noire vide par defaut (tout passe), remplissable au fur et a mesure
  - Prevu pour : envoi de mail, skills sensibles, etc.

### Sessions & isolation

- Une session par DM (par user autorise)
- Une session par group (chaque group Matrix/Telegram a sa propre session isolee)
- Un fichier par session reelle
- Persistance des sessions entre redemarrages
- Stockage des sessions dans `~/.my-claw/sessions/`

### Auth & acces

- L'agent ne repond qu'aux utilisateurs autorises, quoi qu'il arrive
- Messages transferes (forward) par un user autorise sont traites normalement
- Whitelist globale (un user autorise a acces partout)

### Stockage

```
~/.my-claw/
├── config.json              # config globale (providers, modeles, whitelist, blacklist, etc.)
├── agents/                  # configs de sous-agents
│   ├── general.json
│   └── research.json
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

- Config au format JSON (compatible jq)

### Integration pi-mono

- SDK direct en priorite (meme process)
- RPC ou subprocess si besoin selon le contexte (isolation, crash recovery)

### LLM

- API standard : OpenAI-compatible (format universel)
- Tout provider OpenAI-compatible fonctionne (Fireworks, OpenRouter, Ollama, LM Studio, etc.)
- Provider actuel : Fireworks AI (FirePass, Kimi K2.5 Turbo, $7/sem)
- Modele configurable par session/agent
- Auth : API key par provider (env vars)

### Sous-agents

- 2 types de sous-agents predefinis :
  - **general** : memes capacites que l'agent principal (lecture, ecriture, bash, tout)
  - **research** : lecture seule, exploration, execution de commandes sans modification
- Heritage LLM : sous-agent utilise le LLM de l'agent principal par defaut
- Si un sous-agent a une config LLM specifique, il utilise celle-ci a la place
- Limite : 3 sous-agents simultanes max
- Profondeur max : 2 niveaux (main -> sous-agent -> sous-sous-agent, pas plus)
- Config dans `~/.my-claw/agents/`

### Invocation

- DM : repond a tout message d'un user autorise
- Group : repond a tout message d'un user autorise (pas de mention obligatoire)
- Messages forwarded par un user autorise : traites normalement

### System prompt

- A definir dans une session dediee
- Inspiration : Hermes Agent + OpenClaw
- Format : fichiers markdown (style "soul", personnalite, instructions)
- Configurable (pas hardcode)

## Questions ouvertes

- [ ] System prompt (session dediee, inspiration Hermes/OpenClaw/soul md)
