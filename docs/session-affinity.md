# Session affinity

## Le problème

Une passerelle qui vend un modèle ouvert ne le sert pas elle-même : elle répartit le trafic sur
plusieurs fournisseurs du même modèle. Le cache de préfixe, lui, vit sur **un** backend. Deux
requêtes d'une même conversation envoyées à deux backends paient donc deux fois le même préfixe,
et la passerelle ne peut pas le savoir sans qu'on le lui dise.

OpenCode Go a arrêté de deviner. Sans en-tête de session, la requête est refusée :

```
HTTP 400 — Error from provider (Console Go): Request is missing x-opencode-session and cannot be
routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it
```

Mesuré sur `https://opencode.ai/zen/go/v1/chat/completions` : 400 sans l'en-tête, 200 avec, à clé
et corps identiques. Ce qui est demandé (`https://opencode.ai/docs/go/`, « Where can I use it? ») :

1. du trafic d'agent de code,
2. un **user agent** propre au client, pas celui d'une bibliothèque HTTP,
3. un **identifiant de session stable par conversation** dans `x-opencode-session`.

## Ce qu'on envoie

Un seul endroit, `src/llm/session-headers.ts`, appelé par les deux constructeurs d'en-têtes du
transport OpenAI-compatible (`chatCompletion`, `chatCompletionStream`).

| Cible | En-têtes |
|---|---|
| `opencode.ai` et ses sous-domaines | `x-opencode-session`, `x-opencode-client: my-claw`, `User-Agent: my-claw/<version>` |
| tout le reste | `x-session-affinity`, `X-Session-Id`, `User-Agent: my-claw/<version>` |

La paire du bas est ce que le client de référence envoie à tout fournisseur non-opencode
(`packages/opencode/src/session/llm/request.ts`) : l'en-tête qu'un proxy lit n'est pas normalisé,
donc les deux orthographes partent ensemble. Rien d'autre ne les lit aujourd'hui, et un fournisseur
qui ne les connaît pas les ignore.

`config.headers` est appliqué **après** : un provider de la config garde le dernier mot sur
n'importe lequel de ces en-têtes.

Les deux transports par abonnement (`anthropic.ts`, `codex.ts`) ne sont pas concernés : leur
user-agent est celui du CLI qu'ils imitent, et leur fournisseur reconnaît déjà leur en-tête de
session natif.

## La valeur

Un digest SHA-256 tronqué à 32 caractères de l'identifiant de session, pas l'identifiant lui-même.
Le routage et le cache ont besoin qu'il soit **stable**, pas lisible, et l'identifiant porte
l'appareil et le fil de discussion du propriétaire.

Il vient de `ResolvedLlmConfig.cacheKey`, qui existait déjà pour `prompt_cache_key` (OpenAI) et que
« le caller qui possède la conversation » remplit. Un sous-agent a sa propre session, donc sa propre
valeur : c'est ce qu'on veut, ses requêtes n'ont pas le préfixe de son parent.

Deux appels de service n'appartenaient à aucune conversation et repartaient donc en 400 :

- **le résumeur de compaction** (`src/sessions/compaction.ts`) : c'est pourtant la conversation
  elle-même, son prompt est le préfixe de celle-ci → `cacheKey ?? session.id` ;
- **la consolidation mémoire** (`src/index.ts`) : de l'entretien qui n'appartient à personne, mais
  assez stable pour être sa propre session → `my-claw:memory-consolidation`.

Un appel sans clé du tout n'envoie que le user-agent : il annonce qui appelle et ne revendique pas
une session qu'il n'a pas.

## Pas fait

`x-parent-session-id`, que le client de référence envoie depuis peu pour un sous-agent. Le
transport ne connaît pas la session parente ; il faudrait la porter sur le contexte de run. À faire
si la passerelle commence à s'en servir.
