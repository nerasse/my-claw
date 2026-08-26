# Le prompt ne se réécrit pas

Décision arrêtée : **une sortie d'outil est bornée une fois, à sa production, et
plus jamais retouchée.** Le seul mécanisme de débordement est la compaction.

Ce document remplace la stratégie d'élagage côté prompt (`pruneOldToolResults`),
qui disparaît avec tout ce qui en dépendait.

## Ce qu'on faisait, et pourquoi c'était faux

À chaque construction de prompt, les vieux résultats d'outils étaient remplacés
par un extrait tête/queue plus un marqueur nommant un fichier. Le résultat était
juste ; le moment était faux.

Réécrire un bloc ancien invalide tout le cache en aval. La justification écrite
dans `bridge.ts` en tirait la bonne conclusion pour Anthropic et s'arrêtait là :

```
promptSidePruned = backend !== "anthropic" && contextPruningEnabled(config)
```

Or **le cache par préfixe n'est propre à personne**. Vérifié sur les
documentations officielles : OpenAI (Responses, breakpoints tous les 1024
tokens), Anthropic (`cache_control`), DeepSeek, Gemini, Grok, Qwen, GLM. Tous
par préfixe, tous invalident l'aval quand on réécrit au milieu. Le test sur le
nom du backend n'encodait pas « qui a un cache de préfixe » mais « où on l'avait
mesuré ».

Mesuré sur 14 jours de trafic réel, ratio cache-read sur tokens de prompt :

| Modèle | Appels | cache-read | Élagué |
|---|---|---|---|
| claude-opus-5 | 11 167 | 95,6 % | non |
| claude-opus-4-5 | 1 863 | 97,4 % | non |
| deepseek-v4-flash-vision | 3 459 | 93,3 % | oui |
| glm-5.2 | 888 | 91,5 % | oui |
| **gpt-5.6-luna** | **4 402** | **28,5 %** | oui |
| gemini-3.7-flash | 529 | 56,8 % | oui |

Le tableau n'est pas univoque : deepseek et glm tiennent 90 % tout en étant
élagués, probablement grâce à une détection adaptative de préfixes communs. Mais
gpt-5.6-luna à 28,5 % sur 4 402 appels chiffre ce que l'élagage coûte quand le
provider n'a pas ce rattrapage.

## Le second coût : deux formes de prompt

Le vrai prix n'était pas le cache, c'était l'existence de **deux formes** du même
historique. Une taille facturée n'est comparable qu'à une estimation prise de la
même façon, d'où toute une machinerie pour empêcher les deux de se mélanger :
`promptSidePruned`, le drapeau `pruned` sur `MeasuredPrompt`, `measurementFor`,
et les deux chemins de `toChat` dans `status-command.ts` et `index.ts`.

Symptôme observé, sur une vraie conversation : un fil à **20,8 %** d'un cap de
512k sur moteur élagueur affiche **131 %** au basculement vers Anthropic, et
déclenche une compaction dans la seconde. Les deux lectures sont honnêtes pour
leur moteur. C'est le fait qu'il y en ait deux qui ne l'est pas.

Une seule forme, et tout ce bloc disparaît.

## Ce qu'on fait

1. **Borner à la production.** Au-delà du seuil, l'entrée `tool` garde un extrait
   et l'intégral part dans `sessions/<id>/tool-output/<callId>`. Déjà en place
   (`sessions/tool-output.ts`), c'est le point d'entrée unique.
2. **Ne jamais retoucher.** Ce que le modèle a vu au tour N est exactement ce
   qu'il reverra au tour N+10. Le préfixe est stable, le cache tient.
3. **Rendre le fichier navigable.** Le marqueur nomme un vrai chemin et le modèle
   y va avec ses outils : `grep`, `sed`, `tail`, ce qu'il veut.
4. **Compacter quand ça déborde.** C'est le seul mécanisme, il existe déjà.

Sur le point 3, on s'écarte de codex : leur `HeadTailBuffer` jette le milieu pour
de bon. Ici le milieu est conservé et consultable. Rien n'est perdu.

**Pas d'outil dédié.** Un `tool_output(callId, grep?, offset?, limit?)` a été
envisagé et écarté : il fige dans une signature les seuls usages anticipés, là où
un chemin de fichier donne `rg`, `awk`, `jq`, `wc -l` et le reste. La flexibilité
d'un fichier est le produit ; une API par-dessus est une soustraction.

## Le sandbox, sans quoi le marqueur ment

`resolveWorkspacePath` (`tools/workspace.ts:24`) refuse tout chemin hors
workspace. Le spill vit sous `MY_CLAW_DIR`, donc **`read` et `search` refusent le
fichier que le prompt leur désigne** ; seul `bash` y accède, par accident de
conception plutôt que par intention. Une instruction qui échoue selon l'outil
choisi est pire que pas d'instruction.

Donc : élargissement **en lecture seule** au répertoire `tool-output/` de la
session courante, pour `read` et `search`. `write` et `apply_patch` restent
interdits — le magasin est un journal, il ne se modifie pas. Le spill garde son
cycle de vie actuel : il meurt avec la session, et le GC ne balaie que les
orphelins.

## Deux magasins deviennent un

Il en existe deux aujourd'hui, pour le même travail :

| | `agent/context-pruning.ts` | `sessions/tool-output.ts` |
|---|---|---|
| Emplacement | `MY_CLAW_DIR/tool-output/`, global | `sessions/<id>/tool-output/`, par session |
| Clé | hash du contenu | `callId` |
| Durée de vie | TTL 7 jours + balayage au boot | celle de l'entrée qui le nomme |

Le second est le bon : un fichier meurt avec la conversation qui le référence, ce
qui rend le TTL sans objet — un balayage par date peut effacer ce qu'une session
vivante désigne encore. Le premier part en entier, `SPILL_RETENTION_MS` et
`sweepSpilledToolOutput` compris.

## Ce qui disparaît

- `pruneOldToolResults`, `promptSidePruned`, `pruneMarker`, `spillPath`,
  `spillToolOutput`, `SPILL_RETENTION_MS`, `sweepSpilledToolOutput` — soit
  `agent/context-pruning.ts` en entier
- `MeasuredPrompt.pruned` et `measurementFor` (`llm/context-window.ts`)
- les deux `toChat` conditionnels de `status-command.ts` et `index.ts`
- l'appel de balayage dans `index.ts:265`
- la configuration `contextPruning`

## Le seuil devient la seule digue

`SPILL_THRESHOLD = 50_000` caractères, soit ~12,5k tokens par sortie. Sans
l'élagage qui repassait derrière, ce nombre pèse directement sur la fréquence de
compaction : la conversation mesurée plus haut portait 162 entrées d'outils pour
657k tokens projetés.

Repères : codex borne à 10 000 tokens (`DEFAULT_MAX_OUTPUT_TOKENS`), opencode à
2 000 lignes ou 50 KB. Baisser le seuil rapproche des deux et espace les
compactions, au prix d'un extrait plus court — que le modèle peut de toute façon
relire. **À décider avec des mesures, pas d'avance**, et c'est un réglage, pas
une décision d'architecture : le seuil peut bouger sans que rien d'autre ne
change, ce qui est précisément la propriété que cette refonte achète.

## Vérification

L'effet se lit sans instrumentation nouvelle : `api_calls` porte déjà
`model`, `timestamp`, `prompt_tokens` et `cache_read_tokens`. Le ratio par modèle
avant et après la bascule répond à la question. Une colonne `pruned` avait été
envisagée pour comparer les deux régimes ; elle n'a plus d'objet, puisqu'il n'y
en aura plus qu'un.

Le témoin de la bascule est `tests/sessions/prompt-conformance.test.ts` : ses
attentes sont écrites en littéraux et ne dépendent pas du chemin qu'elles
vérifient. Un prompt qui change de forme le fait rougir, ce qui est exactement le
service demandé ici.
