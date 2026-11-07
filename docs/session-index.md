# my-claw — L'index du log de session

Ouvrir une conversation ne lit plus la conversation. Ce document décrit la carte en octets qui
rend cela possible, ce qu'elle garantit, et les deux chemins qui restent autorisés à lire le log
entier.

Complète [session-log.md](session-log.md) : le log reste la seule vérité, ce fichier n'en est
qu'une projection, reconstructible et jetable.

---

## 1. Le problème mesuré

Sur les conversations réelles de cette install (2026-11-07), avant ce changement :

| conversation | entrées | fichier | ouverture à froid | mémoire retenue |
|---|---|---|---|---|
| `fbe927c6` | 46 355 | 127 Mo | 1 380 ms | ~600 Mo |
| `4d5775e7` | 45 760 | 126 Mo | 1 290 ms | ~600 Mo |
| `b509c5a0` | 24 719 | 73 Mo | 770 ms | ~350 Mo |

`MAX_OPEN_LOGS` vaut 24, et chaque log ouvert était le fichier entier parsé en objets : le process
de production tenait 1,8 Go de RSS avec du swap entamé.

Ce que le client recevait réellement pour ces 1 380 ms : 30 à 90 Ko, 31 à 116 cartes. Et un run
n'a besoin que de la branche depuis sa dernière compaction — 0,36 Mo d'un fichier de 127 Mo. **97 %
du travail était jeté.**

## 2. Le format

`entries.idx`, à côté de `entries.jsonl`, un enregistrement de 56 octets par entrée, dans l'ordre
du fichier :

| octets | champ |
|---|---|
| 0-15 | id (hex, 16 octets — les ids sont des UUIDv7) |
| 16-19 | position du parent dans l'index (`0xFFFFFFFF` = racine, `0xFFFFFFFE` = parent absent du log) |
| 20-23 | `seq` |
| 24-31 | offset de la ligne dans `entries.jsonl` (hi/lo 32 bits) |
| 32-35 | longueur de la ligne, saut de ligne exclu |
| 36-43 | `ts` (double) |
| 44 | type (un octet, table fixe dans `log-index.ts`) |
| 45 | drapeaux : dans le prompt, carte de `spawn`/`send`/`delegate_browser_task` |
| 46-55 | réservé |

Le parent est une **position**, pas un id : la marche de branche depuis la feuille lit l'index et
ne touche jamais au log.

Un id qui ne tient pas 16 octets (rien en production ; un test qui nomme ses entrées `u1`) va dans
`entries.idxids`, une ligne `position<TAB>id` par cas. Jamais d'approximation sur une recherche par
id.

### Reconstruction

Une ligne n'est pas parsée pour être indexée : les quatre champs dont l'enregistrement a besoin
sont à la fin de chaque ligne, dans un ordre que les deux writers de ce fichier respectent, et le
type et le nom d'outil sont en tête. Une regex sur deux tranches de 320/200 octets par ligne, avec
repli sur `JSON.parse` quand aucune forme ne colle (une ligne d'un troisième writer, une ligne
éditée à la main) : 127 Mo en ~150 ms contre ~900 ms à tout parser.

L'index est **dérivé, jamais autoritaire** : absent, en retard, ou pointant au-delà de la fin du
log, il est reconstruit ou tronqué depuis le log. Le supprimer coûte un scan.

## 3. Le contrat

`SessionLog` expose deux niveaux, et la distinction est le sujet :

- **`all()`** — le log entier, parsé, en mémoire, réparé si sa forme l'exige. C'est le prix ancien
  (1,1 s et 600 Mo sur la conversation mesurée), payé une fois, par les seuls chemins qui en ont
  besoin : `/undo`, `/retry`, `/branches`, la compaction, la maintenance de boot.
- **l'index** — `pathRecords()`, `entriesIn()`, `recordOf()`, `recordsSince()`, `context()`. Aucune
  allocation du log, seulement les octets de la fenêtre demandée.

`entries()` (sans `await`) **lève** quand le log n'est pas en mémoire. C'est le garde-fou : sans
lui, un chemin qui devait rester borné redevient silencieusement un parse complet, et c'est comme ça
qu'une ouverture de conversation coûtait une seconde.

### `context()`

La branche depuis sa dernière frontière de compaction, avec la frontière elle-même : exactement ce
qu'un prompt peut lire. Si la branche n'a aucune frontière, elle rend tout le log — c'est ce que la
compaction existe pour empêcher, et c'est le prix d'avant.

Le tableau rendu est **vivant** : un append qui prolonge la branche y entre, donc le tour que le
run vient d'écrire est dans son prompt suivant sans relire le log. Un `branch()` le jette.

### Le second handle

Un process tient un log par session (l'invariant du `SessionManager`). Quand un second handle
écrit quand même — le runner de sous-agent et un run sur deux instances, comme dans les tests —
`context()` compare la taille du fichier à celle qu'il attend avant de servir son cache, et se
réaligne (index, liste, feuille) si elle a grandi. Un fichier qui a *rétréci* ou disparu signifie
« supprimé sous nous » : on ne l'adopte pas.

## 4. La réparation ne se fait plus à l'ouverture

`branches.ts` a besoin de toutes les entrées. Elle tourne donc :

1. à l'ouverture, **seulement si** l'index dit que la forme mérite un regard (un parent absent du
   log, ou une fourche) **et** que le meta ne dit pas déjà qu'elle a été vérifiée ;
2. dans la passe de maintenance du boot, pour les conversations jamais vérifiées.

`meta.branchesChecked` porte cette réponse. Une fourche n'est pas un dégât en soi — `/undo` et
`/retry` en laissent une exprès — et une fourche vit dans le fichier pour toujours : sans ce
drapeau, chaque ouverture d'une conversation annulée une fois repaierait le log entier.

Une feuille en retard sur le fichier (le meta écrit au tick d'autosave, pas les entrées) est
adoptée sans rien parser quand le fichier ne contient qu'une ligne droite après elle
(`adoptStraightTail`) ; une annulation échoue ce test à son entrée de commande.

## 5. La passe de maintenance

`maintain.ts`, lancée au boot, une conversation à la fois, jamais sur un log qu'un run utilise :

- construit l'index des conversations qui n'en ont pas (une conversation de trois cents lignes
  n'attend pas la première ouverture) ;
- répare celles dont la forme est douteuse et écrit `branchesChecked` ;
- réécrit la feuille du meta quand elle a été adoptée.

Budget de dix minutes par passe ; ce qui reste est fait au boot suivant. Un process tué au milieu
ne coûte que les conversations non atteintes, dont l'index se construit à la première ouverture.

## 6. Ce que ça donne

Sur la même conversation de 46 355 entrées (copie en sandbox, machine sous charge) :

| opération | avant | après |
|---|---|---|
| ouverture à froid (aucun index) | 1 380 ms | 1 200 ms (un scan, une fois) |
| ouverture, index présent et vérifié | 1 380 ms | **67 ms** |
| `sync` d'une page (31 cartes) | ~1 600 ms | **54-77 ms** |
| `history` d'une page | ~1 400 ms | **19-42 ms** |
| `context()` + `promptOf` (démarrage de run) | 1 100 ms | **45-80 ms** |
| RSS après une ouverture | ~780 Mo | **135 Mo** |

Le premier 1 200 ms est le prix du scan initial, payé une fois par conversation et fait en
arrière-plan par la maintenance.

## 7. Invariants et tests

- Un log d'une million d'entrées tient dans 56 Mo d'index ; la page demandée coûte ses octets.
- Une page lue deux fois ne relit pas l'index (listes de spawn et listing des fichiers cachés,
  invalidés par le compte d'entrées / par une écriture).
- Aucun chemin d'affichage n'appelle `all()` : `tests/sessions/log.test.ts` le vérifie sur une
  conversation de 20 000 entrées (`isMaterialized()` reste faux après `history()`).
- La reconstruction ne perd rien : chaque test des `sessions/` passe indifféremment avec un index
  présent ou absent (les tests partent d'un répertoire nu).
- Un enregistrement qui pointe au-delà de la fin du log est ignoré, un en-tête partiel est tronqué,
  une queue manquante est scannée : `openSessionIndex` répare les trois cas.
