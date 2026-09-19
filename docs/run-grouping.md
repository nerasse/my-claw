# Run grouping — le chat replie le travail d'un run fini

## Le problème

Un prompt lance un run : reasoning, tool calls, phases intermédiaires, injections, et
plusieurs **messages** — l'agent écrit souvent, pas seulement pour conclure. Pendant le
run, tout est visible en direct. Une fois le run terminé, le travail intermédiaire
encombre la conversation : le lecteur veut lire **tous les messages**, et déplier le
travail entre deux d'entre eux s'il a besoin de savoir ce qui s'est passé là.

Décision owner (2026-09-17) : « je veux pouvoir tous les voir, mais ce qu'il y a entre
sauf compact se regroupe ». Avant elle, seul le dernier message — la « réponse élue » —
sortait du pli : sur un run mesuré de 180 items à 10 messages, un seul était visible.

L'app sait quand un run commence et finit en live (`chat.run.start` / `chat.run.end`),
mais rien ne persistait cette frontière : une conversation rouverte ou re-synchronisée
ne pouvait pas reconstruire les runs. Le serveur ne gardait que des `runId` par *tour*
d'API, jamais par run complet.

## La solution : deux marqueurs dans le log

Deux entrées immuables, `prompt: false` (jamais envoyées au modèle, jamais rendues
comme bulles) :

```ts
interface RunStartEntry { type: "run_start"; prompt: false; }
interface RunEndEntry   { type: "run_end"; prompt: false; reason: "done" | "aborted" | "error"; }
```

Le `RunRecorder` les écrit autour de chaque run :

- `run_start` juste après le tour déclencheur (`user`), dans `bridge.run()` -- le point
  unique par lequel passent tous les runs (orchestrateur, sous-agents, cron) ;
- `run_end` à la fin normale (`done`), sur abort (`aborted`) et sur erreur (`error`). Les
  trois ferment le run là où il s'est arrêté : une erreur ne rembobine plus
  (`session-log.md` §2.6), donc le travail du run reste sur la branche et la `failure` que
  le canal dépose ensuite se place après le `run_end`, hors du run replié.

La chaîne d'un run est donc : `user` (déclencheur) → `run_start` → work → `run_end` →
tour suivant. Une injection (message de pilotage, réponse à une question) est écrite
**entre** les deux marqueurs : structurellement dans le run, affichée à part.

## Le fold serveur (`runFold`)

`displayOf` reçoit un pli du log complet : pour chaque entrée entre un `run_start` et
son `run_end`, le champ `run: { id, status, startTs, endTs? }`. L'`id` est celui que le fil a
annoncé en direct : `run_start` porte `runId`, l'id de corrélation du contexte de run
(`run-context.ts`), le même que `chat.run.start` / `chat.run.end` mettent sur le fil. Avant la
0.6.3 un run avait trois noms côté serveur : cet id de corrélation sur le fil, l'id de l'entrée
`run_start` sur les pages, et le `runId` par *tour* d'API des phases et des outils. L'app devait
renommer un run synthétique vers celui de la page à l'arrivée de celle-ci, et une page arrivée
après la fin laissait des cartes vivantes orphelines. Un run porte maintenant un seul nom en direct
et en historique ; un marqueur d'avant la 0.6.3 (sans `runId`) nomme le run d'après sa propre
entrée. Le `runId` des phases et des outils, lui, reste ce qu'il a toujours été : l'id d'un tour
d'API (`RunRecorder.turnId`), qui regroupe les phases d'un appel en un message assistant dans le
prompt. Un run sans `run_end` à la fin du log reste `running` ; le serveur passe
le booléen `activeRun` (déjà en place) et le client tranche : `activeRun=false` ⇒ le
run est mort (crash) et se replie en `done`.

Un run sans `run_end` qui n'est **pas** le dernier est mort lui aussi : un seul run à la
fois sur une branche, donc le `run_start` suivant prouve que le précédent ne s'est jamais
fermé ici (crash, ou branche coupée par une feuille de log périmée, cf. `session-log.md`
« une seule instance par session »). `runFold` le ferme en `done` à sa dernière entrée,
et le tour `user` qui déclenche le run suivant n'en fait pas partie. Laissé ouvert, l'app
ne scelle que le run de queue : celui-là restait `running` à jamais, à plat, et la
question suivante se lisait comme un pilotage plié dans le vieux travail (observé le
2026-09-06 sur un fil coupé deux fois).

Chaque `MyClawAppHistoryEntry` porte donc son appartenance, ce qui rend la pagination
et les deltas triviaux : une page qui commence au milieu d'un run n'a aucune logique
d'état à reconstituer côté client.

## Côté app

### Store (`chat.ts`)

- `openRuns` par thread : le run en cours. `chat.run.start` ouvre un run *synthétique*
  (`live-N`) parce que le frame arrive avant toute entrée ; les items créés par les
  frames live lui sont attachés.
- Quand une synchro/historique apporte le vrai `run` (`running`), le run synthétique
  est **renommé** vers l'id serveur, pour qu'un même run ne devienne jamais deux groupes.
- `chat.run.end(reason)` scelle tous les items du run (`sealRun`) : c'est ce patch qui
  fait basculer le rendu du mode « à plat » (run en cours) au mode « groupe replié ».
- `activeRun=false` (ou `seedRuns` sans le thread) scelle un run resté `running` :
  la fin avait été perdue (déconnexion, crash).

### Rendu (`runRows.ts` → `buildRows`, `RunGroup.tsx`)

La FlatList porte des **rows**, pas des items bruts :

- un item sans run, ou d'un run `running` : row individuelle (rien n'est groupé
  pendant que le run répond) ;
- un run terminal : ses items non hoistés deviennent un groupe par **segment entre deux
  messages** ;
- **hoistés** (toujours des rows, le groupe se découpe autour) : les messages `user`
  (réponses aux questions, injections), les résultats de commandes, les notices, les
  bornes de compaction, **tout item `text` portant une `error`**, et **tout message de
  l'agent** — une phase avec du texte, ou une phase qui porte des médias (ses propres refs
  `MEDIA:`, ou les images produites par ses outils et épinglées par le `run_end`). Les
  messages `user`, commandes et notices parce que l'agent ne les a pas écrits ; l'`error`
  parce que c'est pourquoi le run s'est arrêté, et un groupe fermé par défaut le cacherait —
  un run mort après `chat.stream.start` mais avant son premier token porte ce message sur la
  phase elle-même (`abortStream`), donc **dans** le run. Une **carte d'outil** en échec n'est
  pas concernée (`isHoisted` filtre sur le `kind` avant tout) : une commande sortie non-zéro
  est du travail, pas un verdict. Une phase qui n'a fait que **réfléchir** n'est pas un
  message : elle reste dans le pli, comme les cartes d'outils ;
- le concept de **réponse élue** n'existe plus : le dernier message est simplement le dernier
  message, à sa place. Trois cas spéciaux tombent avec lui — l'élection par contenu, « seul un
  run `done` élit » (un run stoppé ou mort garde maintenant ses messages visibles, dans
  l'ordre), et la carte recollée après la réponse : l'ordre est naturel, il n'y a plus rien à
  recoller. L'élection avait sa propre histoire de bugs (ordre inversé 2026-09-13, prose
  sortie du mauvais côté 2026-09-14) ; la règle par message les rend impossibles par
  construction ;
- un run qui n'a écrit **aucun message** — que des cartes, ou des phases qui n'ont fait que
  réfléchir — n'a rien à sortir : tout reste dans le groupe, et la bulle d'erreur (`failure`,
  hors run par construction) reste visible ;
- un groupe ne s'affiche que s'il contient au moins un item : deux messages collés ne
  produisent jamais un header vide.

`RunGroup` est un header repliable (chevron, nombre de tool calls, premier outil,
durée, statut coloré en erreur/aborté), fermé par défaut : une session rouverte
commence avec tout replié. Un run a maintenant plusieurs plis : le **statut et la durée
totale du run vivent sur son dernier pli** (décision owner), les autres plis n'affichent
que leur propre contenu. Un pli sans aucun outil s'intitule « réflexion · N s » au lieu
du « run » de repli.

Deux détails de contrôle, tous deux appris à l'usage :

- **une barre en bas aussi**, dès 5 items ouverts. Un run fait facilement trois cents
  cartes : avec le seul contrôle en haut, refermer un groupe oblige à remonter tout ce
  qu'on vient de lire, exactement ce que le pli existe pour éviter. En dessous du seuil
  le corps tient dans un écran, le header reste à portée, une seconde barre serait du
  décor. Les deux barres sont identiques (même libellé, même action), seul le chevron
  indique le sens du contenu ;
- **l'état ouvert vit dans l'écran** (`ChatScreen`, un `Set` de run ids), pas dans le
  composant. La row est remontée sous les doigts du lecteur : un groupe replié dont le
  travail arrive est remplacé par un groupe d'items réels (docs/run-hydration.md), avec
  une autre clé de liste, et un `useState` local refermait le groupe au moment où il se
  remplissait. Le run id est la seule identité qui survit à ce remplacement, ce qui fait
  aussi que les deux moitiés d'un run coupé par une injection s'ouvrent ensemble : c'est
  un seul tour. L'écran n'étant pas remonté au changement de thread, le `Set` est vidé
  sur `threadId` (sinon une row rouverte de mémoire afficherait un squelette que
  personne ne remplit : le fetch part du tap, pas du rendu).

## Migration one-shot (au boot)

Les sessions écrites avant les marqueurs sont réécrites une fois, par
`migrateRunMarkersForSession`, avant que quiconque les ouvre :

- backup de `entries.jsonl` à côté (`entries.jsonl.runmarkers-<stamp>.bak`) ;
- réécriture atomique (fsync + rename) avec renumérotation des `seq` ;
- les marqueurs sont insérés dans le fichier et **chaînés** (parentId) exactement
  comme l'écrivain live le ferait : `run_start` entre le déclencheur et le premier
  travail, `run_end` entre le dernier travail et la suite ;
- idempotent : une session avec un marqueur est ignorée au boot suivant.

La déduction est une heuristique structurelle, la plus proche possible de la vérité :

- un `user` dont le parent est un **tool** est une injection (elles n'arrivent que
  juste après un round d'outils) → reste dans le run ;
- un `user` dont le parent est une **phase** clôt le run (un run ne finit que sur une
  phase) et en ouvre un nouveau ;
- une `failure` clôt son run en `error` ;
- un run final non fermé (crash) est marqué `done` : un groupe « running » éternel
  serait pire qu'une fin approximative ;
- les branches mortes ne sont pas touchées : deviner une frontière sur un run tronqué
  par un rewind risquerait d'ordonner des marqueurs faux, et l'affichage plat qu'elles
  gardent ne casse rien.

## Pourquoi ce design

- **Le log reste la vérité** : les marqueurs sont des entrées comme les autres,
  append-only, branchables, backupées.
- **Le client ne calcule rien** : chaque entrée porte son run ; pas d'état à
  reconstituer à la pagination, pas de fenêtre de déduction sur les deltas.
- **Le live et le replay convergent** : le même run synthétique devient le vrai run
  quand les entrées arrivent, et le même `buildRows` sert les frames, les pages et les
  re-synchronisations.
- **Les préférences existantes ne sont pas détournées** : `expandTools` /
  `expandReasoning` ne forcent pas l'ouverture des groupes ; elles ne s'appliquent
  qu'au contenu d'un groupe déplié (et au run en cours, qui est à plat).

## La suite

Ce document décrit le pli **à l'écran** : le serveur envoie tout le travail d'un run et
l'app le cache. Mesuré, ça fait 1 068 KB envoyés pour 13 lignes affichées.
`docs/run-hydration.md` (spec) prolonge le pli **jusqu'au fil** : un run terminé assez gros
voyage comme un résumé, son contenu n'est demandé qu'à l'ouverture du groupe.