# Run hydration — un run replié ne voyage pas

*Spec. Non implémentée : elle prolonge `docs/run-grouping.md` (le pli à l'écran) par le
pli sur le fil.*

## Le problème, mesuré

Depuis `run-grouping`, un run terminé s'affiche replié : une ligne d'en-tête. Le serveur,
lui, continue d'envoyer tout son contenu. Mesures sur une session réelle de 12 034 entrées
(thread `fbe927c6`, 343 runs) :

| | envoyé | affiché |
|---|---|---|
| fenêtre d'ouverture | **1 068 KB**, 477 items | 13 lignes (3 en-têtes de run + 10 bulles) |
| un cran de scroll | 771 KB, 318 items | ~10 lignes |

Décomposition des 1 068 KB : sortie tool 352 KB, args 189 KB, run meta répétée sur chaque
item 61 KB, ids et timestamps 31 KB… et **18 KB de prose lisible** (1,6 %). La même page,
si un run replié n'envoyait que son en-tête : **21 KB**, soit **50× moins**.

Ce n'est donc pas un problème de compression. Clipper la sortie tool de 4000 à 300
caractères ne fait gagner que 26 % (les grosses sorties sont rares) et abîme l'aperçu. Le
levier est de **ne pas envoyer ce qui n'est pas affiché**.

## La solution : le résumé prend la place du travail

Un run **terminé et assez gros** voyage comme une entrée de résumé, posée à l'endroit exact
où son travail se trouvait dans le flux. Le contenu n'est demandé qu'à l'ouverture du
groupe, exactement comme `chat.tool.full` hydrate déjà une sortie clippée.

```ts
interface MyClawAppRunSummaryEntry {
  /** `run-<id de la première entrée repliée>` : l'id de ligne que le client détient. */
  id: string;
  role: "run";
  ts: string;               // le ts de cette première entrée : la ligne se trie où le travail était
  run: MyClawAppRunMeta;    // { id, status, startTs, endTs } -- la forme que l'app rend déjà
  /** Ce que l'en-tête affiche, et rien de plus -- RunGroup.tsx. */
  toolCount: number;
  firstTool?: string;
  /** Lignes repliées (pas entrées) : squelette de chargement à la bonne taille. */
  itemCount: number;
  /** Dernière entrée couverte : borne exacte pour l'hydratation. */
  lastId: string;
}
```

**Ce qu'on replie est un segment, pas un run.** Clé sur la première entrée couverte et non sur
le runId, pour trois raisons trouvées à l'implémentation :

1. Une injection de l'owner en plein run coupe le groupe en deux (règle `isHoisted` de
   `runRows.ts`) : deux en-têtes pour un même run, que `run-<runId>` ne saurait distinguer.
2. Une frontière de page coupe aussi. La première version exigeait le run entier dans la
   fenêtre pour éviter d'émettre deux fois le même id ; mesuré sur la vraie session, ça ne
   repliait **rien** sur les pages profondes, qui sont les lourdes (607 lignes envoyées là où
   l'app en dessinait 46). Clé sur la première entrée → ids distincts par construction, la
   restriction ne protégeait de rien.
3. Un résumé est alors un `beforeId` valide comme n'importe quelle ligne : `carriesDisplayId`
   résout `run-<X>` vers l'entrée X.

Côté app (lot 3) : deux résumés adjacents du même run se fusionnent en un seul groupe.

Ce que le résumé **ne remplace pas** et qui continue de voyager en clair : les bulles
hoistées (tours de l'owner, commandes, notices, bornes de compaction) et la réponse finale
du run. C'est déjà la règle de `buildRows`, et c'est ce qui garde la conversation lisible
une fois tout replié : question, réponse, et un en-tête entre les deux.

Ce point n'est pas cosmétique : une première implémentation repliait tout le run, réponse
comprise. Résultat mesuré sur la vraie session : une conversation rouverte n'était plus
qu'une suite de questions avec des en-têtes repliés et **rien dessous**. La règle de hoisting
est donc portée telle quelle côté serveur (`isHoisted` dans `display.ts`, mêmes noms qu'en
face), et un test de parité sur la session réelle vérifie que rien de ce que l'app dessine
hors groupe n'est avalé par un pli.

## Le seuil : les petits runs voyagent entiers

Distribution des 343 runs de la session mesurée :

| taille | runs | part des octets |
|---|---|---|
| 1-3 items | 215 (63 %) | 3,2 % |
| 4-8 items | 17 | 1,5 % |
| 9-30 items | 40 | 9,5 % |
| 31-100 items | 51 | 27,7 % |
| 101+ items | 20 (6 %) | **58,1 %** |

La médiane est à **1 item**. Replier un run de deux bulles économise quelques centaines
d'octets et coûte un aller-retour au premier clic : perdant. Le seuil est donc
`RUN_FOLD_MIN_ITEMS = 8` — en dessous, le run voyage entier. Ça laisse 68 % des runs
intacts pour 4,7 % des octets, et replie les 111 runs qui portent 95,3 % du poids.

## Qui décide du pli : le serveur

Aujourd'hui la règle de hoisting vit dans l'app (`runRows.ts`). Elle doit passer côté
serveur, parce que le serveur doit savoir quoi ne pas envoyer, et deux copies d'une même
règle divergent. La leçon est fraîche : la pagination par id a échoué en 0.4.83 parce que
le serveur croyait connaître les ids que l'app détient (`t-<callId>`, `cmd-<sourceId>`) et
se trompait. Une seule source de vérité, côté serveur ; l'app rend ce qu'elle reçoit.

`buildRows` s'en trouve simplifié : plus de découpe en segments, un résumé *est* une ligne
de groupe. Le chemin « run en cours » reste inchangé (rien n'est replié pendant le run).

## Wire

Demande (à l'ouverture d'un groupe replié), bornée par les deux ids que la ligne porte :

```json
{ "type": "session.run.items", "threadId": "projet", "fromId": "01a0...", "untilId": "01a0..." }
```

Réponse :

```json
{ "type": "chat.run.items", "threadId": "projet", "fromId": "01a0...",
  "messages": [ /* les items repliés, mêmes formes que chat.history */ ],
  "found": true }
```

La plage, et pas le runId : un run coupé par une frontière de page se replie en une ligne par
page, et répondre « tout le run » ferait spliquer chez le client des items qu'il détient déjà.

`found: false` quand la plage n'est plus sur la branche courante (compaction, fork) : le
groupe affiche « contenu indisponible » et reste replié, il ne se vide pas en silence.

Pas de pagination sur cette réponse : un run est borné par construction, et le plus gros
mesuré ici pèse 361 items. Le clip de sortie tool (`TOOL_OUTPUT_LIMIT`) s'applique comme
sur une page d'historique, `chat.tool.full` reste l'échappatoire.

## Côté app

**Store.** Un résumé est un item comme un autre dans `threads`, avec un état
d'hydratation : `idle` → `loading` → `ready` (items splicés à la place du résumé) ou
`failed`. Un run hydraté reste hydraté jusqu'au trim (`MAX_HELD_ITEMS`), qui le redescend
à son résumé plutôt que de le dropper : c'est la version bon marché de l'unloading.

**Rendu.** `RunGroup` affiche l'en-tête depuis le résumé (aucun item requis), déclenche
la demande à l'ouverture, montre un squelette de `itemCount` lignes pendant le chargement.

**Ce qui ne change pas.** Le live : un run en cours n'est jamais résumé, les frames
continuent d'arriver item par item.

## Interactions à ne pas casser

- **Pagination `beforeId`.** Si la plus vieille ligne détenue est un résumé, le curseur vaut
  `run-<id de la première entrée repliée>` : `carriesDisplayId` le résout vers cette entrée.
  Sinon la pagination remeurt exactement comme en 0.4.83. Couvert par un test dédié.
- **Deltas de sync.** Un delta n'est jamais replié : c'est du travail que le client regarde
  arriver item par item, et le pli ne s'applique qu'à la fenêtre qui remplace son fil
  (`freshWindow`). Un delta peut par ailleurs réviser une carte (`spawn_state` qui se règle)
  vivant dans un run non hydraté : le remplacement par id ne trouve rien et doit être un no-op
  silencieux, pas une insertion en fin de fil.
- **Run en cours.** Jamais replié, quelle que soit sa taille : c'est ce à quoi les frames live
  ajoutent. Un run laissé ouvert par un crash reste donc entier lui aussi, ce qui est le bon
  compromis (c'est la queue du fil, une seule).
- **Trim.** Voir plus haut : déshydrater avant de dropper.
- **Branches / undo.** Un rewind change la branche : les résumés de l'ancienne branche
  partent avec le reset, rien de spécial.
- **Notifications, `/status`, recherche.** Ne lisent pas le fil de l'app, non concernés.

## Compatibilité

- **Vieille app / serveur neuf** : elle ne connaît pas `role: "run"`. `parseServerFrame`
  est une whitelist de *types de frame*, pas d'entrées : un résumé passerait et serait rendu
  comme une bulle vide. Le résumé n'est donc envoyé que si le client l'a demandé.
  **Écart avec la spec initiale** : pas de `caps` sur `device.hello`, parce qu'il n'existe
  aucune frame `device.hello` (le `hello` va du serveur vers le client). C'est un booléen
  `fold` **par requête**, sur `session.history` et `session.sync`. Plus simple : rien à tenir
  au niveau connexion, aucune course entre une annonce et la première page, et le client peut
  redemander une page entière quand il en a besoin (après un trim, par exemple).
- **App neuve / vieux serveur** : aucun résumé n'arrive, l'app fait ce qu'elle fait
  aujourd'hui. Aucun des deux sens ne casse.

## Lots

1. **Serveur, le pli.** — *livré*. `runFoldPlan` + `isHoisted` + le seuil dans `display.ts`,
   le résumé dans `displayOf` derrière le drapeau `fold`, `carriesDisplayId` qui résout
   `run-<id>`. Mesuré sur la session réelle (12 034 entrées) :

   | Page | Aujourd'hui | Replié | |
   |---|---|---|---|
   | Ouverture | 582 items, 1 282 KB | 94 lignes, 182 KB | x7,0 |
   | Un cran de scroll | 607 items, 1 556 KB | 45 lignes, 68 KB | **x23** |
   | Deux crans | 298 items, 783 KB | 2 lignes, 0,4 KB | **x2000** |

   L'ouverture plafonne à x7 parce que le run **en cours** n'est jamais replié : ses 73 items
   pèsent 155 des 182 KB restants. Une fois le run terminé, la même page tombe à ~27 KB.
2. **Serveur, l'hydratation.** — *livré*. `session.run.items` / `chat.run.items` dans
   `adapter.ts`, `runItems()` dans `sessions.ts`. Borné par la plage que la ligne porte
   (`fromId`/`untilId`), plafond `RUN_ITEMS_LIMIT` (1000 entrées) pour la requête que personne
   n'a mintée. Vérifié sur la vraie session : page repliée + items hydratés = la page pleine,
   **id pour id**, sur trois pages (594 KB -> 86 KB, 818 KB -> 6,7 KB, 1 094 KB -> 68 KB), et
   ~140 ms pour ouvrir un groupe, l'ordre de grandeur d'une page d'historique.
3. **App, le rendu.** — *livré* (`RunSummaryItem` dans `chat.ts`, `hydrateRun`, ligne
   `folded` dans `runRows.ts` avec fusion des segments adjacents, `FoldedRunGroup`,
   `core/runItems.ts`). `fold: true` est posé **dans les encodeurs** et non aux sites d'appel :
   comprendre `role: 'run'` est une propriété du bundle, et six endroits demandent un sync,
   deux une page — un seul oubli servirait un mégaoctet là où les autres servent des dizaines
   de kilooctets.

   Fausse alerte notée puis écartée : `buildRows` semblait traiter le dernier item d'une page
   comme la réponse du run. En réalité l'app tient toujours un **suffixe** de la conversation,
   jamais une tranche du milieu, donc la réponse d'un run détenu est toujours présente.
   L'écart venait du comparateur de la mesure, qui lui passait une page isolée.

   Vérifié en croisant les deux repos : la vraie page repliée du serveur (94 lignes, 7
   résumés), passée dans le store et `buildRows` de l'app, donne 92 lignes dont 7 groupes
   repliés ; tous les groupes ouverts, le fil est identique à la page non repliée, id pour id.
4. **App, le trim.** — *livré*. Deux étapes, la moins chère d'abord.

   **Déshydrater** : un groupe que le lecteur avait ouvert redevient la ligne que le serveur
   avait envoyée. Des centaines d'items redeviennent un, rien ne quitte le fil, et rouvrir le
   groupe le récupère. La ligne est celle du serveur **gardée telle quelle**, jamais
   reconstruite : elle porte les ids d'entrée exacts de sa plage, alors qu'une carte d'outil à
   l'écran porte `t-<callId>` — reconstruire une plage depuis l'écran, c'est renvoyer les
   mauvais ids, exactement le bug de 0.4.83.

   **Dropper** : le reste (un run arrivé en live, des bulles libres). Là du contenu part, donc
   c'est payé en disant au pager qu'il y a de nouveau du plus ancien.

   Ce dernier point est **le piège**. Une conversation vivante qui dépasse le plafond a ouvert
   sur une page dont le serveur n'avait rien de plus ancien : `hasMore` est faux. Dropper sans
   y toucher, et le lecteur qui remonte ne demande rien et ne reçoit rien — le début de sa
   propre conversation est perdu jusqu'à ce qu'il change de fil et revienne.

   Le trim tourne aussi désormais sur le chemin **live** (`append`), pas seulement sur les
   deltas de sync : un run qui streame pendant des heures ne passait par aucun point de trim
   tant que la socket tenait. Le lecteur remonté dans l'historique n'est jamais tronqué sous
   les pieds, live ou pas.

   Corrigé au passage : `clearAll()` ne vidait ni `pages` ni `trimAllowed`, donc un curseur
   survivait aux fils qui venaient de partir et un `trimAllowed` périmé décidait pour le
   lecteur suivant si ses vieux messages pouvaient être lâchés.

   Le mémo « déjà demandé » de `runItems.ts` a été supprimé : l'état vit sur la ligne
   (`hydration`). Un mémo module-level aurait refusé de re-fetcher un groupe déshydraté — il se
   serait ouvert sur un squelette qui ne se remplit jamais.

Chaque lot est livrable seul : après le 1, l'app neuve ignore les résumés qu'elle n'a pas
demandés ; après le 2, rien ne change tant que l'app ne met pas `fold`. Les quatre sont
livrés ; il faut déployer les deux moitiés ensemble pour voir quoi que ce soit, une app neuve
sur un vieux serveur ne reçoit simplement aucun résumé.

## Tests

- `displayOf` : un run sous le seuil voyage entier, au-dessus il devient un résumé ; les
  bulles hoistées et la réponse finale restent en clair dans les deux cas.
- `carriesDisplayId` : `run-<runId>` résout vers la première entrée du run (et la
  pagination remonte page après page sur une session dont chaque page est un résumé).
- `session.run.items` : rend les items du run ; `found: false` sur un run hors branche.
- Sans capability : l'octet près, la même réponse qu'aujourd'hui.
- App : ouverture → demande une fois (pas à chaque re-render), squelette, hydratation,
  échec réversible, trim qui déshydrate.
- Mesure de non-régression : la fenêtre d'ouverture de la session témoin sous 40 KB.

## Écarté

- **Clipper plus fort la sortie tool.** 26 % de gain, aperçu abîmé, ne touche pas au vrai
  poids (le nombre d'items).
- **Dédupliquer la run meta répétée sur chaque item** (61 KB, 5,7 %) : vrai gain, mais
  microscopique à côté de 50×, et inutile une fois les items non envoyés.
- **Pagination plus fine (pages de 20 entrées).** Ne réduit pas le total, multiplie les
  allers-retours, et une page peut tomber au milieu d'un run de 300 entrées.
- **Compression du transport.** Le WS peut négocier `permessage-deflate` ; ça diviserait
  les octets sur le fil mais pas le coût de parse ni la mémoire du store, qui sont la
  moitié du problème sur téléphone. Orthogonal, à regarder après.
