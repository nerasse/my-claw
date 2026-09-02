# my-claw — Session log, branches, fork/retry/undo

Refonte de la persistance de conversation, et les commandes qui en découlent.

Références auditées : `~/dev/pi-mono` (earendil-works, pi 0.84.3) et `~/dev/opencode`
(anomalyco/opencode, branche `dev`, HEAD `71d08e94d`). Toutes les affirmations sur ces
deux dépôts sont référencées fichier:ligne et ont été vérifiées.

Décisions arrêtées avec l'owner le 2026-08-24. Les lots marqués « livré » dans la Partie 9
sont implémentés ; ce document conserve la conception et les décisions qui les encadrent.

---

## Sommaire

- [Partie 0 — Pourquoi](#partie-0--pourquoi)
- [Partie 1 — Ce qu'on prend, ce qu'on laisse](#partie-1--ce-quon-prend-ce-quon-laisse)
- [Partie 2 — Le modèle de stockage](#partie-2--le-modèle-de-stockage)
- [Partie 3 — Les projections](#partie-3--les-projections)
- [Partie 4 — Le protocole de synchronisation](#partie-4--le-protocole-de-synchronisation)
- [Partie 5 — Branches, fork, retry](#partie-5--branches-fork-retry)
- [Partie 6 — /undo et /redo](#partie-6--undo-et-redo)
- [Partie 7 — Snapshots fichiers](#partie-7--snapshots-fichiers)
- [Partie 8 — Ce qui disparaît](#partie-8--ce-qui-disparaît)
- [Partie 9 — Lots, ordre, coût](#partie-9--lots-ordre-coût)
- [Partie 10 — Invariants et tests](#partie-10--invariants-et-tests)
- [Annexe A — Migration](#annexe-a--migration)
- [Annexe B — Décisions arrêtées](#annexe-b--décisions-arrêtées)

---

# Partie 0 — Pourquoi

## 0.1 Le symptôme

Un thread rouvert en cours de run perd des bulles, des cartes d'outil, des phases de
réflexion. Corrigé deux fois cette semaine (`48f084d` serveur, `516a75e` app), les deux
fois en ajoutant une devinette de plus.

## 0.2 La cause

`SessionData.messages` est **un seul tableau qui sert deux maîtres** :

| Consommateur | Ce qu'il veut |
|---|---|
| `bridge.ts` (prompt) | des messages OpenAI, élagués, compactés |
| `sessions.ts` (affichage) | des événements : phase scellée, carte ouverte, tour injecté |

Tout le reste en découle. `promptBase` existe parce que la compaction détruisait
l'affichage. `sourceId` existe parce que l'app ne reconnaissait pas ses propres bulles.
`UNMIRRORED_SEND_WINDOW_MS` (30 s) existe parce qu'un `/status` n'est jamais miroité.
Le filtre `carried` existe parce que `seedHistory` **remplace** l'écran et doit deviner
ce qu'il garde. Les ids `h-<ts>-<index>` existent parce qu'une entrée d'affichage n'a
pas d'identité propre. `commands` et `failures` sont des journaux latéraux recollés par
timestamp (`asides`, `flushCommandsUpTo`) parce qu'ils n'ont pas leur place dans
`messages`.

Sept mécanismes, une seule cause.

## 0.3 Les chiffres, mesurés

Sur cette installation, le 2026-08-24 :

```
sessions/                       52 MB
  fbe927c6-….json               12.0 MB / 3695 messages
    dont sorties d'outils        9.6 MB   = 94 % du contenu
  4d5775e7-….json                1.7 MB /  658 messages
    assistant avec reasoning      96 / 315
    assistant avec segments        0 / 315   <- les phases n'existent pas sur disque

autosave (toutes les 2 s tant que la session est dirty) :
  JSON.stringify               41.1 ms   synchrone, bloque l'event loop
  write atomique               11.9 ms
  total                        ~53 ms
append d'une ligne JSONL        0.02 ms   2600x moins

workspace/                      69 MB, pas un dépôt git
```

Trois conclusions :

1. On bloque l'event loop 41 ms toutes les 2 s pendant un run. C'est le stream WS qui
   hoquette.
2. 94 % de ce qu'on réécrit sont des sorties d'outils que personne ne relit (le prompt
   les élague, l'affichage les clippe à 4 KB, seul `chat.tool.full` les touche).
3. `segments = 0` partout : les phases de réflexion scellées en live ne sont **nulle
   part** sur disque. D'où `sessions.ts:412` qui saute les phases vides, et le thread
   rouvert qui saute de la question à la carte d'outil.

## 0.4 SessionData mélange quatre natures

| Nature | Champs | Ce que ça veut |
|---|---|---|
| Conversation | `messages`, `commands`, `failures` | immuable, append, jamais réécrit |
| Réglages | `title`, `pinRank`, `archivedAt`, `modelOverride`, `effortOverride`, `workspace`, `skillsOff`, `promptLayersOff`, `nestedDisabled`, `contextOverride`, `verbose`, `approvedTools`, `memoryRecallOff` | mutable, écrasable, minuscule |
| État de run | `scopeOverride`, `scopeEffort`, `invokedBy`, `lastPrompt`, `lastFixedTokens` | éphémère, ne devrait pas survivre au process |
| Projections | `tokenUsage`, `nestedAgents`, `callers`, `promptBase` | dérivable |

Un `verbose` qui bascule réécrit 12 MB.

---

# Partie 1 — Ce qu'on prend, ce qu'on laisse

## 1.1 De pi

**Pris :**

1. **JSONL append-only, une ligne par entrée.** `session-manager.ts:1021`,
   `appendFileSync(file, JSON.stringify(entry) + "\n")`. 0.02 ms contre 53.
2. **Lecture tolérante.** `parseSessionEntryLine` (`:503`) renvoie `null` sur parse
   error, la ligne est sautée. Un crash en écriture coûte **la dernière ligne**, pas le
   fichier.
3. **`type` ouvert sur l'entrée.** `message`, `model_change`, `thinking_level_change`,
   `compaction`, `branch_summary`, `label`, `session_info`, `custom`, `custom_message`.
   Un lecteur ancien ignore un type inconnu → zéro migration.
4. **`CustomEntry` vs `CustomMessageEntry`** (`:94-121`). L'une est affichage pur
   (ignorée par `buildSessionContext`), l'autre entre dans le prompt. C'est la ligne
   qu'on n'a jamais tracée, et c'est exactement le débat `ask`/`note` du hand-back
   sous-agent, résolu à la main pour un cas particulier.
5. **Compaction comme entrée.** `CompactionEntry { summary, firstKeptEntryId,
   tokensBefore }` et `buildContextEntries` (`:418`) qui saute ce qui précède
   `firstKeptEntryId`. On a déjà l'idée sous forme de `promptBase`.
6. **Arbre : `parentId` + `leafId`.** Voir §5.
7. **Curseur `since` en erreur explicite.** `rpc-mode.ts:640` répond
   `Entry not found: <id>` quand le curseur est inconnu. Le client sait qu'il doit
   refaire un fetch complet, et **pourquoi**.
8. **La politique des trois strates**, `harness.md` §7.5 :

   ```
   entries          le budget de stabilité est ICI, read-compatible pour toujours
   réglages         migrate-on-open, mécanique, quelques champs
   état d'opération éphémère par construction, la machine a le droit de churner ici
   ```

**Pas pris — le harness complet** (`packages/agent/src/harness/`, 3916 lignes + une spec
de 5000). Machine à états d'opération, registres, `effect_pending`, reprise mi-outil,
lanes, migrations totales. Trois raisons factuelles :

- **Il n'est pas en production chez eux.** `createCodingAgentHarness` n'est référencé que
  par `test/server/create-harness.test.ts`. CLI, TUI et RPC tournent tous sur
  `session-manager.ts` + `agent-loop.ts`, c'est-à-dire le modèle simple avec arbre.
- **Il diverge de sa propre spec.** `harness.md` §1.8 défend les registres et affirme
  « no reducer exists to have a bug ». L'implémentation a `reducer.ts`, 667 lignes, avec
  13 causes de corruption énumérées (`multiple_open_operations`, `tool_call_mismatch`,
  `duplicate_tool_invocation`, `record_after_finish`, …).
- On n'a pas le problème. Nos runs meurent, on journalise l'échec, l'utilisateur relance.

**Pas pris non plus :**

- **`_persist` et son `openSync(file, "wx")`** (`:1029`) : ils retiennent le flush tant
  qu'aucun assistant n'est arrivé, puis écrivent tout d'un coup. Écriture non atomique.
  Notre `SessionManager` LRU couvre le besoin.
- **Le découpage `agent` / `coding-agent`** en deux packages : un seul binaire Bun, un
  seul consommateur.
- **`branchWithSummary`** (`:1655`) : un appel LLM à chaque changement de branche.
  L'entrée `compaction` couvre déjà le besoin. À rouvrir si l'usage le demande.

**Retenu du harness malgré tout, l'invariant sans la machine :**

- « Aucun tool call ne reste sans réponse » — **livré**, `3b09196`. Voir §0.5.
- `replay: "never" | "safe"` par outil : déclaratif, sans état, ajoutable plus tard.
- **Queues persistées** : notre mailbox (`run-registry.ts` : `pending`/`claimed`/
  `accepting`/`RerouteSignal`) est exactement leurs queues steer/followUp/nextRun, mais
  purement en mémoire — un message parqué meurt avec le process. Eux journalisent
  `queue_enqueued`. Une entrée `queued` règle ça. Lot 9.

## 0.5 Ce que le deep dive a déjà trouvé et corrigé

Commit `3b09196`. L'assistant est persisté **avant** que ses outils ne tournent
(`bridge.ts:713`) et l'autosave tique toutes les 2 s. Un process tué pendant un outil
long laisse un `tool_call` que rien n'answerra jamais. Toute API OpenAI-compatible refuse
ce prompt : **la conversation est morte définitivement**, sans message d'erreur qui le
dise.

`sealDanglingToolCalls` existait mais ne tournait que sur abort, et seulement sur le
dernier tour assistant. Deux fichiers sur cette installation étaient dans cet état
(`subagent/run-696f6e1f-…` : 3 calls, `subagent/run-54e1cd44-…` : 2 calls).

Correctif : la fonction scanne tous les tours et insère chaque résultat synthétique
**sous le tour qui l'a demandé** (splice, pas push) ; le démarrage de run l'appelle.
Subtilité : sur disque, un call sans résultat veut dire **soit** « en cours » **soit**
« mort ». La sérialisation des runs par session est ce qui tranche — arriver au démarrage
d'un run prouve qu'aucun autre run ne tient l'historique. L'affichage continue de rendre
un call sans résultat comme *running*, ce qu'une page chargée en cours de run doit
montrer.

L'invariant vaut pour le nouveau format aussi et sera reporté tel quel.

## 1.2 D'opencode

**Pris :**

1. **La séparation Durable / All.** `packages/schema/src/session-event.ts:448-511`. Les
   deltas (`Text.Delta`, `Reasoning.Delta`, `Tool.Input.Delta`, `Compaction.Delta`) sont
   dans `Definitions` mais **pas** dans `DurableDefinitions` : ils voyagent sur le fil,
   ils ne touchent jamais le disque. Ce qui est durable, ce sont les paires
   `Started`/`Ended` et le texte final. Chez nous : `chat.stream.delta` reste éphémère,
   `phase` devient une entrée. C'est ce qui manque à nos phases (`segments = 0`).
2. **Le magasin de sorties d'outils séparé.** `packages/core/src/tool-output-store.ts` :
   `MAX_LINES = 2000`, `MAX_BYTES = 50 KB`. Réponse directe aux 9.6 MB. **Sans leur
   `RETENTION`**, voir §2.7.
3. **Le type versionné.** `versionedType(type, version)` stocke `"…tool.called@1"`.
   Version simplifiée chez nous : un champ `v` sur l'entrée, défaut 1.
4. **Le delta « tout sauf ce que tu as ».** `handlers/sync.ts:73`.
5. **`/undo` et `/redo`** — §6. pi n'en a pas.
6. **Les snapshots fichiers** — §7, avec une correction de fond sur les dépôts imbriqués.

**Pas pris :**

- **Effect.** Tout leur code est en `Effect.gen`/`yield*`. Refonte de 14 000 lignes chez
  nous, zéro gain fonctionnel.
- **SQLite + Drizzle + migrations pour la conversation.** On a déjà 4 bases
  (`analytics`, `approvals`, `memory`, `conversations`) sans schéma partagé. Un index
  SQL sert les lectures arbitraires ; notre seule lecture est « la suite depuis mon
  curseur ».
- **La machinerie de replay.** `packages/core/src/event.ts:255-360` : détection de
  divergence, idempotence sur `event.id`, `ownerID`, `strictOwner`, `Sequence mismatch`,
  `Replay diverged at aggregate`. ~640 lignes, qui existent parce qu'ils synchronisent
  plusieurs **instances** (control-plane, workspaces, `steal`). Nous : un serveur, N
  écrans passifs.
- **Le reducer comme mécanisme central.** Et là on cite pi contre opencode
  (`harness.md` §1.8) : « Recovery is a read. […] **No reducer exists to have a bug.** »
  Un tableau d'entrées lu dans l'ordre, c'est zéro code qui peut se tromper.
- **La destruction au revert.** `revert.ts:101-123` (`cleanup`) supprime pour de bon les
  messages masqués au prochain prompt. Avec un arbre c'est inutile : voir §6.2.
- **Leur V2 en tant que telle** : inachevée, `v1/` tourne encore à côté.

## 1.3 De nous, ce qui reste

- **`promptBase`** — compaction non destructive, la bonne intuition. Devient
  `firstKeptEntryId`.
- **Écriture atomique** (`utils/atomic-write.ts`) — pour `meta.json` (petit). Pas pour
  la conversation, qui prend l'append.
- **`SessionManager` LRU** — le cache reste. `dirtySessions` reste pour les réglages,
  devient inutile pour les entrées (une entrée écrite est écrite).
- **Clip à 4 KB + `chat.tool.full`** — bonne idée, à étendre au **stockage**.
- **`run-registry` + mailbox** — orthogonal, rien à voir avec la persistance.
- **Le journal SQLite d'approbations** — bon contre-exemple : donnée tabulaire
  interrogeable → SQLite. La conversation n'est pas ça.
- **`sealDanglingToolCalls` au démarrage de run** — §0.5.
- **La rétention cron** — `pruneSessions` garde les 25 dernières sessions par job
  (`scheduler.ts:126`). Une session de run **n'est pas supprimée** après le run : l'app
  l'ouvre comme un chat. (Deux commentaires de `store.ts` disaient le contraire, corrigés
  par `e02d68b`.)

---

# Partie 2 — Le modèle de stockage

## 2.1 Disposition

```
~/.my-claw/sessions/<id>/
  meta.json          réglages + projections. Petit, écriture atomique, écrasé.
  entries.jsonl      la conversation. Append-only. Une ligne = une entrée.
  tool-output/<id>   sorties > 50 KB. Durée de vie = celle de l'entrée (§2.7).
```

`<id>` est l'id de session actuel (`my-claw-app/thread/<owner>/<threadId>`,
`subagent/<name>-<hash>`, `cron/<jobId>/<runTs>`), sanitisé comme aujourd'hui. Un
répertoire remplace le fichier plat.

## 2.2 L'entrée

```ts
/** Assignés par le store, sauf lorsqu'un canal doit conserver l'id d'une bulle déjà affichée. */
interface EntryBase {
  id: string;               // UUIDv7 en général, ou id du canal ; stable, = l'id de la bulle
  seq: number;              // monotone par session, ordre d'écriture dans le fichier
  parentId: string | null;  // le leaf de la session au moment de l'append
  ts: number;               // Unix ms
  v?: number;               // version de forme, défaut 1
  type: EntryType;
}

type EntryType =
  | "user"          // un tour de l'humain (ou d'un parent, pour un sous-agent)
  | "phase"         // une phase assistant scellée : reasoning + texte
  | "tool"          // un appel d'outil et son résultat
  | "command"       // une slash command et sa réponse
  | "failure"       // un run mort et l'erreur montrée
  | "compaction"    // un résumé et la borne qu'il pose
  | "model_change"  // /model, /effort
  | "note"          // affichage seul, jamais envoyé au modèle
  | "spawn_state"   // un pas dans la vie d'un sous-agent, sur la carte qui l'a lancé (§3.5)
  | "queued";       // un message parqué en mailbox (lot 9)
```

Chaque entrée porte **`prompt: boolean`** : entre dans le contexte LLM, ou affichage
seul. C'est la distinction `CustomEntry` / `CustomMessageEntry` de pi, généralisée.

| type | `prompt` | commentaire |
|---|---|---|
| `user` | `true` | |
| `phase` | `true` | plusieurs phases d'un tour partagent un `runId` |
| `tool` | `true` | résultat clippé côté prompt par `context-pruning` |
| `command` | `false` | `/status` n'est pas un tour |
| `failure` | `false` | |
| `compaction` | `true` | porte le résumé |
| `model_change` | `false` | |
| `note` | `false` | le `note` du hand-back sous-agent |
| `spawn_state` | `false` | le spinner du sous-agent ; le modèle lit son résultat dans `tool` |
| `queued` | `false` | devient `user` quand il est drainé |
| `run_start` | `false` | ouvre un run ; tout ce qui suit jusqu'à `run_end` est son travail (§3.6, docs/run-grouping.md) |
| `run_end` | `false` | ferme un run, avec `reason: done \| aborted \| error` |

## 2.3 Charges utiles

```ts
interface UserEntry extends EntryBase {
  type: "user"; prompt: true;
  text: string;
  attachments?: SessionAttachment[];
  location?: SessionLocation;
  transcripts?: Record<string, string>;
  /** Renseigné quand le tour vient d'un autre agent (send piloté, hand-back). */
  from?: { sessionId: string; label: string };
}

interface CommandEntry extends EntryBase {
  type: "command"; prompt: false;
  input: string;
  output: string;
  details?: string;
  /** Id du chat.send ; l'affichage dérive `cmd-<sourceId>` pour la réponse. */
  sourceId?: string;
}

interface PhaseEntry extends EntryBase {
  type: "phase"; prompt: true;
  text: string;
  reasoning?: string;
  reasoningTokens?: number;
  runId: string;
  /**
   * Métadonnées opaques du provider, rejouées telles quelles -- docs/reasoning-replay.md.
   * NOUVEAU : ce champ n'est pas persisté aujourd'hui (il ne vit que dans le tableau
   * chatMessages en mémoire), donc un run repris après redémarrage perd la chaîne.
   * Toujours omis quand le tour est revenu incomplet, comme aujourd'hui.
   */
  providerMeta?: ProviderMeta;
}

interface ToolEntry extends EntryBase {
  type: "tool"; prompt: true;
  callId: string;          // l'id du modèle : c'est aussi l'id de la carte
  name: string;
  args: Record<string, unknown>;
  output: string;          // extrait ; le reste dans tool-output/<callId> (§2.7)
  outputPath?: string;
  truncated: boolean;
  ok: boolean;
  durationMs?: number;
  /** Legacy : l'état tel qu'il était à l'import d'une session d'avant le log (§3.5). */
  spawn?: SpawnState;
  runId: string;
}

/** La seule entrée qui parle d'une autre entrée. Pourquoi : §3.5. */
interface SpawnStateEntry extends EntryBase {
  type: "spawn_state"; prompt: false;
  callId: string;            // la carte annotée = l'id d'appel du spawn/send
  subagentId: string;
  status: "running" | "complete" | "error" | "aborted";
  displayName?: string;      // identité : portée par l'entrée d'ouverture seule
  agentType?: string;
  mode?: string;
  action?: "spawn" | "send";
  resultLength?: number;
  error?: string;
}

interface CompactionEntry extends EntryBase {
  type: "compaction"; prompt: true;
  summary: string;
  firstKeptEntryId: string;   // première entrée conservée telle quelle
  tokensBefore: number;
  count: number;              // ce que `summaryOf` porte aujourd'hui
}
```

`command`, `failure`, `model_change`, `note` sont triviaux et remplacent
`SessionCommandEntry` / `SessionFailureEntry` à l'identique.

## 2.4 meta.json

Tout ce qui n'est pas la conversation. Écrit atomiquement, seulement quand il change.

```ts
interface SessionMeta {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
  storageVersion: number;      // migrate-on-open, harness.md §7.3
  leafId: string | null;       // le curseur de branche
  title?: string;
  archivedAt?: string;
  pinRank?: number;
  modelOverride?: string;
  effortOverride?: EffortLevel;
  contextOverride?: ContextOverride;
  workspace?: string;
  verbose?: boolean;
  approvedTools?: string[];
  skillsOff?: string[];
  promptLayersOff?: string[];
  nestedDisabled?: string[];
  memoryRecallOff?: boolean;
  meta?: SubAgentMeta;
  callers?: SubAgentCaller[];
  tokenUsage?: TokenUsage;
  nestedAgents?: NestedAgentsRecord[];
  lastPrompt?: MeasuredPrompt;
  lastFixedTokens?: number;
  /** Origine, quand la session vient d'un fork. */
  forkedFrom?: { sessionId: string; entryId: string; attachments: "copied" | "none" };
  /** Branches nommées, pour le sélecteur (§5.4). */
  branches?: Array<{ leafId: string; label: string; ts: number }>;
  /** Position d'undo, quand elle est posée (§6). */
  undo?: { leafId: string; redoLeafId: string | null };
}
```

`scopeOverride`, `scopeEffort`, `invokedBy` disparaissent du disque : ce sont des états
de run, ils vivent dans l'objet en mémoire (et le scheduler les repose à chaque run).

## 2.5 Écriture

```ts
class SessionLog {
  append<T extends Entry>(e: Provisioned<T>, id?: string): T; // id du canal ou id généré
  branch(leafId: string | null): void;                       // déplace le curseur
  entries(): readonly Entry[];                     // le fichier, en ordre d'écriture
  leaf(): string | null;
  since(entryId: string | null): Entry[];          // throw UnknownCursor si inconnu
}
```

`append` fait trois choses : `parentId = this.leafId`, `appendFileSync` d'une ligne,
`this.leafId = e.id`. Le curseur suit toujours la dernière entrée écrite, sauf après un
`branch()` explicite. Pour un tour reçu par `chat.send`, le canal passe son id au second
argument ; le log le réutilise et refuse s'il existe déjà. Sinon il génère un UUIDv7.

`Provisioned<T>` = `Omit<T, "id" | "seq" | "parentId" | "ts">`. L'appelant ne fabrique
pas d'id interne : le seul id imposé est celui d'une bulle déjà ouverte par le canal, ce qui
garantit que l'id de la bulle live et l'id de l'entrée restent le même.

## 2.6 Lecture

Lire le fichier ligne par ligne, `JSON.parse` par ligne, ligne invalide sautée avec un
`warn`. Une fois par ouverture (les sessions sont dans le LRU).

## 2.7 Sorties d'outils : pas d'horloge

Au-delà de 50 KB, la sortie va dans `sessions/<id>/tool-output/<callId>` et l'entrée
garde l'extrait plus `outputPath`.

**Pas de TTL, contrairement à opencode.** Leur `RETENTION = 7 jours`
(`tool-output-store.ts:15`) existe parce que leur magasin est **global**
(`~/.local/share/opencode/tool-output/`) : un fichier n'y a pas de propriétaire, donc la
seule politique possible est une horloge. Chez nous il est **dans la session**, il a un
propriétaire — l'entrée qui le référence — et aucune entrée n'est jamais supprimée. Un
TTL supprimerait un fichier que l'UI affiche encore, avec un bouton « voir tout » qui
répondrait `found: false`. C'est une promesse cassée, pas une politique.

Et pi ne fait pas mieux qu'un TTL, il ne fait rien du tout : `harness.md` §0.6 pose que
la compaction **n'est pas un effacement** (`retainedTail` recopie l'ancien contenu en
avant) et que rien n'est jamais supprimé.

Donc :

- Le fichier vit exactement aussi longtemps que son entrée. Supprimé avec la session,
  archivé avec la session.
- Un GC ne ramasse que les **orphelins** : fichiers qu'aucune entrée ne référence
  (résidus de run tué).
- Si le volume devient un problème, la politique sera un plafond **par session**, plus
  ancien d'abord, et la carte affichera « sortie complète non conservée » au lieu d'un
  `found: false` muet.

---

# Partie 3 — Les projections

Deux fonctions **pures**, aucune mutation, aucune I/O.

```ts
function pathOf(entries: readonly Entry[], leafId: string | null): Entry[];
function promptOf(entries: readonly Entry[], leafId: string | null): ChatMessage[];
function displayOf(entries: readonly Entry[], leafId: string | null): HistoryEntry[];
```

## 3.1 `pathOf`

Copie conforme de `buildSessionPath` (pi, `session-manager.ts:334`) : indexer par id,
partir du leaf, remonter `parentId`, `reverse()`. `leafId === null` → chemin vide.
`leafId` inconnu → repli sur la dernière entrée, avec un `warn`.

## 3.2 `promptOf`

1. `pathOf`
2. Filtrer `prompt === true`
3. Trouver la **dernière** entrée `compaction` du chemin ; garder cette entrée puis tout
   ce qui suit `firstKeptEntryId`. Exactement `buildContextEntries` (pi, `:418`).
4. Projeter : `user` → `{role:"user"}`, `phase` → `{role:"assistant"}` (les phases d'un
   même `runId` fusionnées en un message avec ses `tool_calls`), `tool` →
   `{role:"tool", tool_call_id}`, `compaction` → le tour user porteur du résumé.
5. Rien à réparer en sortie : une entrée `tool` n'est écrite qu'une fois l'appel réglé,
   donc un `tool_call` sans réponse ne peut pas exister. `sealDanglingToolCalls` disparaît
   avec le lot 3b-iv.

`promptMessages()` et `promptBase` disparaissent. **Décision arrêtée : remplacement
direct au lot 3**, pas de cache dérivé — ce serait exactement le double usage qu'on
supprime, payé deux fois.

## 3.3 `displayOf`

`pathOf`, puis une entrée → une bulle, dans l'ordre. C'est tout.

Pas de recollage par timestamp, pas d'`asides`, pas de `flushCommandsUpTo`, pas de
`turnAlignedStart`, pas d'ids dérivés de `entries.length`.

## 3.4 Pagination

Une page est **un nombre d'entrées** avec alignement sur le tour : reculer jusqu'à la
première entrée `user` du chemin. `turnAlignedStart` disparaît en tant que fonction, sa
logique devient une ligne dans `displayOf`.

`HISTORY_LIMIT` reste à 50 mais compte enfin la bonne chose : mesuré sur `4d5775e7`,
50 messages = 1,5 tour ; 50 entrées alignées = 3 tours entiers.

**Côté app, plafond ~500 entrées en mémoire par thread.** Le delta accumule sinon
indéfiniment, et une session de 3695 entrées sur un téléphone finirait par ramer. Au-delà,
les plus anciennes sont relâchées et redemandées au scroll.

## 3.5 `spawnStates` — l'état d'un sous-agent, replié sur sa carte

### Le problème : un état qui arrive après la seule écriture de son entrée

Un `spawn` rend la main **au lancement de l'enfant**, pas à sa fin. L'entrée `tool` est donc
écrite pendant que l'enfant travaille, et tout ce qui vient après — `complete`, `error`,
`killed`, `reset` — arrive après l'unique écriture que cette entrée aura jamais. Or aucune
entrée n'est réécrite : c'est l'invariant qui permet à un lecteur de croire ce qu'il lit.

Ce n'était pas une hypothèse. `ToolEntry.spawn` **n'a jamais eu de producteur vivant** :
`bridge.ts` n'a jamais renseigné `call.spawn`, et le seul écrivain historique,
`recordSessionSubAgentState`, mutait `session.messages` — un tableau auquel plus rien
n'appendait depuis le passage au log. Les 26 états présents dans le log de prod viennent
tous d'`import.ts`, donc de sessions d'avant le log. Depuis 0.4.53, **aucune conversation
neuve n'a jamais persisté le cycle de vie d'un sous-agent** : au redémarrage, une carte
lancée redevenait une carte muette.

### La forme retenue : log immuable, vue calculée

C'est le modèle d'opencode v2 (log append-only + projection mutable), sans sa base SQLite :
ici le JSONL reste la vérité et la projection est repliée à la lecture plutôt que stockée.

- **L'écrivain append.** Un pas du cycle de vie = une entrée `spawn_state`, qui nomme la
  carte (`callId`) au lieu de la modifier.
- **Le lecteur replie.** `spawnStates(entries)` rend `Map<callId, SpawnState>` ;
  `displayOf` la reçoit et pose l'état sur la carte.

Deux règles, et elles vivent **dans le lecteur seul**, pour que le sens du log ne dépende
jamais de la discipline de celui qui l'a écrit :

1. **Un état terminal est définitif.** Rien après lui ne compte : ni un doublon, ni un
   `kill` visant un enfant qui avait déjà répondu. Sans cette règle, un balayage de roster
   à l'extinction transforme toute carte finie de l'historique en carte avortée. (C'est la
   règle « collant » de `recordSessionSubAgentState`, perdue avec lui, réexprimée ici.)
2. **Un `spawn` inline sur l'entrée `tool` est le plancher.** Les sessions d'avant portent
   leur état sur l'entrée elle-même, et c'est un état déjà réglé.

`cardOf` complète : un événement terminal ne connaît que l'enfant, jamais l'appel qui l'a
demandé — c'est le log qui répond, via l'entrée d'ouverture. La **dernière**, parce qu'un
`send` vers un enfant vivant ouvre une nouvelle carte, et c'est celle-là que la prochaine
réponse concerne.

### Ce qui n'est pas écrit

Un cycle de vie **sans carte derrière lui** (un enfant lancé depuis le roster, pas par un
appel d'outil) n'annote rien : rien n'est écrit. Un cycle de vie **au-delà d'un état
terminal** non plus. Dans les deux cas ce serait une ligne qu'aucun lecteur ne demande.

### Côté synchronisation

Un delta est ce que le client n'a pas vu, et un `spawn_state` seul n'est pas dessinable :
la carte qu'il annote a pu arriver il y a des pages, quand l'enfant tournait encore.
`withSpawnCards` remplace **un tel état** par son entrée `tool`, entière — le client
remplace une carte par id, et `displayOf` y pose l'état replié sur le log **entier**, donc
ce qu'il récupère est à jour et non une copie de ce qu'il avait déjà.

**Seulement quand le delta ne porte pas déjà cette carte.** C'est le point où la première
version s'est trompée, et elle est partie en prod (0.4.61) : `spawn` **attend** son enfant,
donc les états sont écrits *avant* l'entrée d'outil et arrivent d'abord dans le même delta.
Substituer la carte sur l'état puis laisser passer l'entrée réelle l'envoyait deux fois — et
le client garde les deux, parce qu'il remplace par id contre ce qu'il détient déjà, pas à
l'intérieur d'un delta. La carte revenait en double à chaque rechargement.

Donc : une entrée `tool` passe toujours **à sa propre position**, et un état ne se substitue
qu'à une carte absente. Hisser la carte à la place de son état la ferait aussi remonter avant
le tour qui l'a produite. Un état dont l'appel n'a jamais abouti est jeté : il n'y a pas
encore de carte, et les frames live portent celle-là.

Même raison pour la pagination : le pli se fait sur `log.entries()`, jamais sur la fenêtre.
Un enfant lancé cinquante entrées plus haut se règle ici, et replier la page seule laisse
la carte tourner pour toujours.

### Où c'est branché

`recordSpawnLifecycle` s'abonne aux six hooks (`subagent:spawn|complete|error|aborted|
killed|reset`) **une fois au boot**, pas par run : un sous-agent de fond survit au run qui
l'a lancé, donc un abonnement démonté avec ce run manquerait précisément ce qu'on veut
enregistrer. La carte est dans la conversation du parent, donc c'est ce log qu'on écrit —
`kill` et `reset` l'atteignent depuis une troisième conversation et tombent quand même sur
la bonne carte. Une chaîne de promesses par conversation garantit l'ordre : `logOf` est
asynchrone, et une entrée d'ouverture écrite après son propre état terminal, c'est une
carte bloquée sur le spinner à jamais.

---

# Partie 4 — Le protocole de synchronisation

## 4.1 Le frame

```ts
// client -> serveur
{ type: "session.sync", threadId, since?: string, limit?: number }

// serveur -> client
{ type: "session.sync.result", threadId,
  entries: HistoryEntry[],   // ce qui suit `since` dans l'ordre d'écriture
  leaf: string | null,       // le curseur courant
  head: string,              // id de la dernière entrée écrite
  activeRun: boolean,
  reset?: "unknown-cursor" | "branch-switch" }
```

Trois cas :

| Situation | Réponse | Action app |
|---|---|---|
| `since` connu, même branche | delta | `append` |
| `since` inconnu | `reset: "unknown-cursor"` + page complète | remplacer |
| `leaf` hors du chemin courant | `reset: "branch-switch"` + page complète | remplacer |

L'erreur explicite vient de pi (`rpc-mode.ts:640`). Le silence actuel est ce qui laisse
deux fenêtres diverger sans que personne ne le remarque.

**Décision arrêtée : reseed serveur au changement de branche**, pas de recalcul client.
Un changement de branche est une action de l'utilisateur, un redraw est attendu, et l'app
n'a pas à porter tout l'arbre d'une session de 12 MB. Le stockage permet l'autre choix
plus tard sans migration.

## 4.2 Côté app

`seedHistory` devient `appendEntries`. Le filtre `carried` disparaît : il n'y a plus rien
à deviner, la page ne remplace plus l'écran sauf `reset` explicite.

`chat.history` reste pour la pagination arrière (`before`), inchangé.

## 4.3 Ce que ça règle mécaniquement

- Multi-device : deux fenêtres appliquent le même delta.
- Reprise de socket : `resume.ts` envoie `session.sync {since: head local}`.
- Le badge `queued` levé trop tôt : l'état est une entrée, pas un marqueur hors-bande.
- La bulle user dupliquée : l'entrée porte l'id de la bulle, plus de `sourceId` ni de
  fenêtre de 30 s.

---

# Partie 5 — Branches, fork, retry

## 5.1 Ce que fait pi, exactement

Trois opérations **distinctes** :

| pi | Mécanique | Portée |
|---|---|---|
| `/tree` | `branch(id)` = `this.leafId = id` (`session-manager.ts:1362`) | même session |
| `/fork` | `createBranchedSession(leafId)` (`:1413`) : nouveau fichier, copie du chemin, `parentSession` pointe la source | nouvelle session |
| `/clone` | duplication à la position courante | nouvelle session |

Et la navigation (`agent-session.ts:3155`) :

```ts
if (target.type === "message" && target.message.role === "user") {
  newLeafId = target.parentId;                       // AVANT le tour
  editorText = contentText(target.message.content);  // le texte revient dans l'éditeur
} else {
  newLeafId = targetId;                              // SUR le nœud
}
```

C'est **exactement** le retry/edit.

Détail repris de `createBranchedSession` (`:1423-1429`) : à la copie, les `parentId` sont
**ré-chaînés** sur le chemin retenu, sinon les entrées filtrées laissent des sous-arbres
orphelins.

## 5.2 Ce qu'on garde

| my-claw | Mécanique | Portée |
|---|---|---|
| **branche** | `log.branch(id)` | même thread |
| **fork** | nouveau thread, copie du chemin ré-chaîné, `forkedFrom` dans `meta.json` | nouveau thread |
| **retry** | branche sur `parentId` d'un tour user + texte au composer | même thread |

## 5.3 Le point qui rend tout compatible

**`seq` et `parentId` coexistent.** `seq` est l'ordre d'écriture dans le fichier,
`parentId` la forme logique. Conséquence : **le curseur de sync reste `seq`**, il ne casse
pas avec les branches. Le client reçoit les nouvelles entrées dans l'ordre du fichier
quelle que soit la branche, plus le `leaf` courant, et le chemin se recalcule.

C'est ce qui rend l'arbre compatible avec le delta, et pourquoi l'arbre doit être là dès
le lot 2 : ce sont le protocole et l'app qui coûtent, pas le stockage.

## 5.4 Les commandes

Ajouter à `META_COMMAND_PATTERN` (`meta-commands.ts:8`), sinon elles partent au modèle.

### `/retry` — relancer le dernier tour

```
/retry            recule avant le dernier tour user, remet son texte au composer
/retry <n>        idem, n tours en arrière
```

`pathOf` → dernier `user` → `log.branch(entry.parentId)` → frame `chat.compose`. Le tour
abandonné **reste** dans le fichier, visible dans `/branches`.

Remplace `session.messages.length = messageCountBeforeLoop` (`bridge.ts:883`), qui efface
aujourd'hui tout le tour raté, travail compris. Un run de 40 minutes qui meurt à la fin
n'emporte plus rien.

### `/fork` — partir dans un nouveau thread

```
/fork             fork au point courant
/fork <entryId>   fork juste avant l'entrée choisie
```

Nouveau thread, `entries.jsonl` = copie du chemin avec `parentId` ré-chaînés,
`meta.json` porte `forkedFrom`. Le thread source n'est pas touché. Les ids sont régénérés,
et chaque `CompactionEntry.firstKeptEntryId` est remappé vers l'entrée correspondante du fork ;
sinon la projection repasserait toute la branche au modèle.

**Les pièces jointes sont un choix explicite, jamais un partage.** Les uploads sont par
thread (`files/my-claw-app/<threadId>/`) et `history()` les résout via
`files.list(owner, threadId)`. Partager les fichiers entre deux threads voudrait dire
qu'un `unlink` d'un côté casse l'autre silencieusement.

**Livré : la copie est systématique, sans feuille d'action.** La spec prévoyait de demander
copier ou non ; le lot 7 a tranché pour toujours copier. Un fork est une session à part
entière, avec sa propre suppression : deux sessions qui pointent le même fichier signifient
qu'en supprimer une mutile l'autre, c'est-à-dire l'invariant central de la refonte cassé par
la porte de derrière. Le coût est quelques octets déjà écrits par le propriétaire, et
seulement pour le préfixe copié. Une question qui n'a qu'une bonne réponse ne se pose pas.

Pas de hardlink non plus, même raison. Un fichier source déjà manquant ne fait pas échouer le
fork : l'entrée garde son chemin mort, exactement comme elle l'avait dans la source.
`forkedFrom` porte `sessionId` et `entryId`, d'où et depuis quel point exactement.

### `/branches` — voir et changer de branche

```
/branches                    liste les feuilles, premier tour et date
/branches <n>                bascule sur la branche n
/branches name <n> <label>   nomme une branche
```

Une feuille est une entrée sans enfant. Calcul = `getTree` de pi (`:1310`), ~40 lignes,
plus un aplatissement. Sur mobile, feuille d'action : une ligne par branche, premier tour
user en titre, date en sous-titre, branche courante cochée.

Nom retenu plutôt que `/tree` : jargon TUI, et sur mobile c'est une liste, pas un arbre.

## 5.5 Ce que ça change dans le bridge

`bridge.ts:883` disparaît. Un run qui échoue laisse ses entrées en place ; la branche
morte est visible et le retry est un frère, pas un écrasement.

---

# Partie 6 — /undo et /redo

pi n'a **pas** d'undo (ses occurrences du mot sont l'undo d'éditeur de la TUI). Le modèle
vient d'opencode seul.

## 6.1 Ce que fait opencode

`packages/opencode/src/session/revert.ts` (136 lignes), deux moitiés :

**Conversation.** `revert({sessionID, messageID})` pose un pointeur
`session.revert = { messageID, partID, snapshot, diff }`. Les messages après ce point ne
sont pas supprimés, ils sont masqués. `unrevert` restaure. `cleanup` (au prochain prompt)
les **supprime pour de bon** (`:101-123`).

**Fichiers.** §7.

**UX**, `packages/tui/src/routes/session/index.tsx:611-665` :

- `/undo` : **abort** si un run tourne (`if (status !== "idle") await session.abort()`),
  prend le dernier tour user, `revert()`, remet son texte et ses fichiers au composer.
- `/redo` : s'il existe un tour user après le point de revert, revert sur celui-là ;
  sinon `unrevert()`.

## 6.2 Ce qu'on fait

Avec l'arbre, `/undo` **est déjà** une navigation de branche :

```
/undo   = log.branch(parentId du dernier user du chemin) + texte au composer
          meta.undo = { leafId: <ancien leaf>, redoLeafId: <ancien leaf> }
/redo   = log.branch(meta.undo.redoLeafId)
```

Pas de pointeur `revert`, pas de masquage, **pas de `cleanup`, pas de suppression**. Là où
opencode détruit les messages au prochain prompt, on garde la branche : elle reste visible
dans `/branches` et atteignable indéfiniment.

**Décision arrêtée : `/redo` refuse dès qu'un tour a été écrit depuis le `/undo`**, et nomme
le numéro de branche à utiliser. `/redo` est l'inverse immédiat de `/undo`, et cette relation
ne tient que tant que rien n'a été écrit entre les deux : après, la branche abandonnée est une
branche parmi d'autres, et naviguer entre des branches quelconques est le travail de
`/branches`. Faire autrement téléporterait le propriétaire loin de ce qu'il vient d'écrire,
c'est-à-dire la même surprise coûteuse que `/branches` refuse pendant un run. Rien n'est
retiré au passage, seulement un raccourci qui a cessé d'être univoque. La détection se fait
sur le leaf attendu mémorisé dans `meta.undo`, jamais sur des timestamps.

| | leaf après | texte au composer | branche abandonnée |
|---|---|---|---|
| `/retry` | avant le tour user | oui | gardée |
| `/undo` | avant le tour user | oui | gardée + mémorisée dans `meta.undo` |

Une fonction, deux commandes.

**Décision arrêtée : `/undo` abort le run en cours**, comme opencode. Séquence : abort →
attendre le settle → `branch()`. `sealDanglingToolCalls` tourne sur l'abort, donc la
branche abandonnée reste **cohérente** (chaque tool call a sa réponse) et rejouable par
`/redo`.

## 6.3 Faisabilité

`/undo` sans l'arbre voudrait dire tronquer `messages` : destructif, non annulable,
incompatible avec la pagination. Donc lots 2 à 4 obligatoires, lot 7 fournit `branch()`,
`pathOf` et le sélecteur. `/undo` et `/redo` sont alors ~80 lignes serveur et un bouton.

C'est ce qui explique l'ordre des lots : `/undo` tombe naturellement, sans mécanisme
dédié.

---

# Partie 7 — Snapshots fichiers

## 7.1 Ce que fait opencode

`packages/core/src/snapshot.ts` (266 lignes) : un **dépôt git fantôme** dans
`~/.local/share/opencode/snapshot/<projectID>/<hash(worktree)>`, séparé du dépôt du
projet. `git.tree.capture` écrit un objet *tree* (pas un commit) de l'arbre de travail,
non suivis inclus jusqu'à `maximumUntrackedFileBytes: 2 MB` (`git.ts:458`), fichiers
ignorés retirés de l'index (`git.ts:473-486`). Capture au début et à la fin de chaque
step (`session/runner/llm.ts:224` et `:325`).

Garde-fou : `enabled()` exige `location.vcs?.type === "git"`.

## 7.2 Le piège des dépôts imbriqués — mesuré

Leur approche suppose **un** dépôt. Un workspace qui contient des dépôts git imbriqués la
casse **silencieusement**. Testé :

```
ws/top.txt
ws/a/b/proj/.git        <- dépôt imbriqué, profondeur 3
ws/a/b/proj/inner.txt

GIT_DIR=shadow GIT_WORK_TREE=ws  git add --all .
  warning: adding embedded git repository: a/b/proj
  index: 160000 076aebeb… a/b/proj      <- gitlink : un SHA, PAS les fichiers
         100644 bf1a1fde… top.txt
```

Le contenu du dépôt imbriqué n'est **pas capturé** ; un restore ne restaurerait rien
dedans. Pire, en visant le fichier directement sur un index propre :

```
git add --all a/b/proj/inner.txt
  -> index vide, aucune erreur          <- perte silencieuse
```

C'est exactement le cas qui compte ici : les vrais dépôts (`~/dev/my-claw`, …) sont
précisément ce qu'on voudrait pouvoir annuler.

**La solution, testée :** un shadow **par dépôt**.

```
GIT_DIR=shadow2 GIT_WORK_TREE=ws/a/b/proj  git add --all .
  index: 100644 f05648e7… inner.txt      <- capturé correctement
```

## 7.3 Conception retenue

1. Au démarrage du tour, découvrir les dépôts sous le workspace, **profondeur 3 max**
   (`~/dev/<repo>` = 1, un monorepo `packages/<x>/` = 3).
2. Un shadow par dépôt trouvé, plus un pour la racine du workspace **excluant** les
   chemins des dépôts imbriqués (sinon on recapture des gitlinks inutiles).
3. Le snapshot d'un tour est une **liste** `[{root, treeId}, …]`, pas un id unique. C'est
   la différence de fond avec opencode.
4. `.gitignore` de chaque dépôt respecté par construction (c'est son propre shadow),
   plafond 2 MB par fichier non suivi comme eux.

**Coût mesuré** sur le workspace réel (69 MB, sans git) :

```
première capture   2.2 s / 65 MB d'objets
capture suivante   4 ms      (index chaud, rien n'a changé)
```

Acceptable. Sur un dépôt de code, la première capture sera plus lente si `node_modules`
n'est pas ignoré, donc **respecter `.gitignore` est obligatoire**, et le premier snapshot
d'un workspace se fait en tâche de fond avec un log.

## 7.4 Deux garde-fous non négociables

- **Hors workspace, rien.** `bash` peut écrire dans `/etc`, `~/Documents`, n'importe où.
  `/undo` doit dire « restauration limitée au workspace », sinon il promet ce qu'il ne
  tient pas.
- **Jamais automatique.** `/undo` restaure la conversation, puis **propose** le diff :
  « 3 fichiers dans my-claw, +42/−7. Restaurer ? ». Un run de 40 minutes écrasé par un
  `/undo` réflexe serait pire que le problème.

---

# Partie 8 — Ce qui disparaît

À supprimer, pas à adapter :

| Où | Quoi | Pourquoi |
|---|---|---|
| `chat.ts` | `seedHistory` et son filtre `carried` | plus rien à deviner |
| `chat.ts` | `UNMIRRORED_SEND_WINDOW_MS` (30 s) | l'entrée porte l'id de la bulle |
| `chat.ts` | `markQueued`/`clearQueued` heuristiques | l'état est une entrée |
| `sessions.ts` | `asides`, `flushCommandsUpTo`, `inPage` | `command`/`failure` sont des entrées |
| `sessions.ts` | `turnAlignedStart` | intégré à `displayOf` |
| `sessions.ts` | ids `h-<ts>-<index>`, `c-<ts>-<i>-in/out`, `f-<ts>-<i>` | ids stables |
| `store.ts` | `sourceId` | idem |
| `store.ts` | `promptBase` | `firstKeptEntryId` |
| `store.ts` | `commands`, `failures` | entrées |
| `store.ts` | `dirtySessions` sur la conversation | l'append est la vérité |
| `bridge.ts` | `messageCountBeforeLoop` + rollback | la branche morte reste |
| `adapter.ts` | `activeRun` sur `chat.history` (`48f084d`) | l'app ne devine plus |
| `types.ts` | `chat.send.queued` / `.acked` comme marqueurs hors-bande | entrées |

Le fix `48f084d` est donc **temporaire par conception**. Assumé : il règle le symptôme
maintenant, il disparaît avec la cause.

---

# Partie 9 — Lots, ordre, coût

| Lot | Contenu | Coût | Dépend de |
|---|---|---|---|
| **0** | ~~`sealDanglingToolCalls` au démarrage de run~~ **livré `3b09196`** | — | — |
| **1** | ~~Ce document en `docs/session-log.md`~~ **livré `a026c32`** | — | — |
| **2** | ~~`sessions/log.ts` : entrée, `append`, lecture tolérante, `branch`, `since`, `pathOf`~~ **livré `d592d1d`** | — | 1 |
| **3a** | ~~`promptOf` (`sessions/projection.ts`) + `displayOf`/`pageOf` (`channels/my-claw-app/display.ts`), purs, testés~~ **livré `f83bf60`, `0262e36`** | — | 2 |
| **3b-i** | ~~`SessionManager.logOf`, cycle de vie (éviction, delete, flushAll), `meta.json` écrit~~ **livré `b8e5cb1`** | — | 2 |
| **3b-ii** | ~~`RunRecorder` : un run écrit en entrées, `providerMeta` persisté, rewind non destructif~~ **livré `979465d`** | — | 3a |
| **3b-iii** | ~~Accès au log depuis un run (`sessions/log-access.ts`)~~ **livré `ebcac59`** | — | 3b-i |
| **3b-iv** | ~~Câblage : `bridge.ts` appelle le recorder, `promptOf` remplace `promptMessages`~~ **livré `0d326c6`** | — | 3b-iii, 6 |
| **4** | ~~Frame `session.sync {since, leaf}`, sync côté app, suppression de `carried`, plafond 500 entrées~~ **livré `4128363`, app `0615cb1`** | — | 3 |
| **5** | ~~Magasin de sorties d'outils + GC des orphelins~~ **livré `dc45495`** | — | 2 |
| **6** | ~~Import one-shot `.json` → `<id>/entries.jsonl` + `meta.json` (les 3 familles)~~ **livré `6253c15`, `7616080`, `3334ff4`** | — | 2 |
| **7** | ~~`/branches`, `/fork`, `/retry`~~ **livré `5813d4c`** | — | 4 |
| **8** | ~~`/undo`, `/redo` (abort du run en cours)~~ **livré `ec72154`** | — | 7 |
| **9** | Queues persistées (mailbox durable) | 0,5 j | 2 |
| **10** | Snapshots fichiers multi-dépôts + restauration proposée dans `/undo` | 1,5 j | 8 |

Le lot 6 est passé **devant** le lot 3b, contrairement à l'ordre initial : basculer le
bridge sans que les données existantes sachent se relire rouvrirait chaque conversation
vide. L'import ne dépend que du lot 2 et se vérifie contre l'ancien chemin (`promptOf` de
l'import == `promptMessages` de l'original), ce que la bascule ne permet plus une fois
faite. Le lot 3 s'est coupé en deux pour la même raison : les projections sont pures et
livrables seules, la bascule ne l'est pas.

**Chemin critique jusqu'à `/undo` : lots 1 à 8 = ~7 jours.**
Avec snapshots : ~9 jours.

Les lots 2 à 6 livrent un système **linéaire à l'usage** mais **arborescent en
stockage** : `parentId` toujours égal à l'entrée précédente, un seul leaf. Les lots 7 et
8 n'ajoutent alors **aucune migration**, juste des écrans et des commandes.

Pas de shim de compatibilité (règle `AGENTS.md`) : le lot 6 tourne une fois au boot, les
`.json` deviennent des répertoires, et on ne parle plus jamais de l'ancien format.

---

# Partie 10 — Invariants et tests

## 10.1 Invariants

1. Une entrée écrite n'est jamais modifiée ni supprimée. Seul `meta.json` mute.
   **Risque ouvert** : `log.ts:write()` avale les erreurs d'append (ENOENT = suppression sous le run,
   erreur disque = la prochaine échouera aussi). Décision prise avant que le log soit la source
   de vérité unique ; à réexaminer.
2. `id` d'entrée = id de bulle. Le serveur ne dérive jamais un id d'affichage.
3. `parentId` pointe une entrée existante, ou `null`. Un parent manquant est une
   corruption, pas un cas à réparer.
4. `promptOf` et `displayOf` sont pures et ne partagent aucun état.
5. Aucun `tool_call` sans résultat dans `promptOf` (garanti par `3b09196`).
6. Une ligne JSONL invalide est sautée, jamais fatale. Et une dernière ligne **non
   terminée** est retirée du fichier à l'ouverture : la sauter en lecture ne suffit pas, l'append
   suivant se collerait au moignon et serait avalé avec lui (trouvé par le test au lot 2).
7. Un curseur `since` inconnu est une erreur explicite, jamais un delta silencieux.
8. Une pièce jointe appartient à un seul thread. Aucun partage inter-session, jamais.
9. Un snapshot ne couvre que le workspace, et `/undo` le dit.

## 10.2 Tests à écrire

- **Round-trip** : append de chaque type, relecture, égalité.
- **Ligne cassée** : fichier avec une ligne tronquée au milieu, la ligne est sautée, les
  suivantes arrivent.
- **Crash simulé** : couper le fichier à un octet arbitraire, la session reste lisible.
- **Chemin** : arbre à trois branches, `pathOf` rend le bon chemin pour chaque leaf.
- **Compaction** : `promptOf` saute avant `firstKeptEntryId`, `displayOf` garde tout.
- **Delta** : `since(head)` = vide ; `since(inconnu)` throw ; après `branch()`, le serveur
  renvoie `reset: "branch-switch"`.
- **Retry** : le tour abandonné reste dans `entries()`, sort de `pathOf`, revient en
  changeant de branche.
- **Undo/redo** : `/undo` puis `/redo` rend exactement l'état de départ, y compris après
  un nouveau tour sur la branche d'undo.
- **Undo pendant un run** : le run est aborté, la branche abandonnée a tous ses tool calls
  répondus, `/redo` la restaure telle quelle.
- **Fork avec copie** : les fichiers sont dans le nouveau thread, supprimer le thread
  source ne casse rien.
- **Fork sans copie** : les bulles gardent leur texte, les attachements sont flaggés
  absents, aucune lecture ne pointe vers l'autre thread.
- **Fork, ré-chaînage** : les `parentId` du nouveau fichier forment une chaîne, le source
  est inchangé octet pour octet.
- **Snapshot dépôt imbriqué** : un fichier dans un dépôt à profondeur 3 est bien dans le
  tree capturé (le test échoue si on revient à un shadow unique).
- **Perf** : append < 1 ms sur une session de 4000 entrées (échoue si on réintroduit une
  réécriture).

## 10.3 Catalogue de courses

- Deux fenêtres qui appliquent le même delta ne dupliquent rien (id stable).
- Un `branch()` pendant qu'un run tourne : refusé, comme `beginCompaction` refuse une
  session déjà prise (`run-registry.ts:119`). Sauf `/undo`, qui abort d'abord.
- Un `session.sync` pendant un append : le `head` renvoyé est celui du moment, le suivant
  rattrape.

---

# Annexe A — Migration

Une passe au boot, `sessions/migrate.ts`, idempotente, sur **les trois familles**
(`my-claw-app/thread/*`, `subagent/*`, `cron/*`) :

```
pour chaque ~/.my-claw/sessions/**/<id>.json :
  lire, mapper vers des entrées :
    user            -> UserEntry (sourceId devient l'id de l'entrée quand il existe)
    assistant       -> une PhaseEntry par segment, ou une seule si segments absent
      + une ToolEntry par toolCall, output pris dans le message role:"tool" suivant
    summaryOf       -> CompactionEntry (firstKeptEntryId = entrée à promptBase)
    commands[]      -> CommandEntry, placée par timestamp
    failures[]      -> FailureEntry, placée par timestamp
  parentId = entrée précédente, leafId = dernière entrée
  écrire <id>/entries.jsonl + <id>/meta.json
  déplacer <id>.json vers sessions-archive/<id>/<ts>.json
```

Pour un tour `user`, le `sourceId` devient l'id de l'entrée : c'est la migration qui règle
définitivement la dédup de bulle. Pour une commande, l'entrée garde `sourceId`, car elle produit
deux bulles : `<sourceId>` pour la saisie et `cmd-<sourceId>` pour la réponse.

Les sessions cron sont migrées comme les autres : elles **ne sont pas** supprimées après
run, `pruneSessions` en garde 25 par job (`scheduler.ts:126`).

Volume mesuré : 52 MB, 9 threads plus les sous-agents et 12 sessions cron. Quelques
secondes.

`storageVersion: 1` posé sur chaque `meta.json`. Ouverture avec une version supérieure au
binaire → refus d'ouvrir, jamais de lecture optimiste (`harness.md` §7.3).

## La migration ne se rembobine pas toute seule

Elle est idempotente mais à sens unique. Une fois `<id>.json` archivé, un binaire antérieur
au lot 3b-iv ne trouve plus rien à lire et ouvre des conversations vides : les données sont
intactes dans `sessions-archive/`, mais seul un `mv` les y ramène.

Ce qui rend le point sérieux à la mise en production, c'est le rollback automatique. Le timer
de mise à jour redéploie la version précédente quand la santé ne revient pas, et cette
version-là est justement celle qui ne sait pas lire ce que la nouvelle vient d'écrire. Un
rollback après migration ne perd rien, mais montre un historique vide jusqu'à restauration
manuelle. Prendre une copie de `~/.my-claw/sessions/` avant la première montée de version coûte
quelques secondes et rend la question théorique.

---

# Annexe B — Décisions arrêtées

| # | Décision | Statut |
|---|---|---|
| 1 | `promptOf` remplace `promptMessages` dès le lot 3, pas de cache dérivé | arrêté |
| 2 | `providerMeta` persisté sur `PhaseEntry` (nouveau : ne l'est pas aujourd'hui) | arrêté |
| 3 | Migration des trois familles ; **cron gardé**, 25/job ; commentaires corrigés (`e02d68b`) | arrêté |
| 4 | Fork : pièces jointes **toujours copiées**, jamais de partage inter-session, pas de hardlink | arrêté (lot 7) |
| 5 | Changement de branche : reseed serveur | arrêté |
| 6 | `/undo` **abort** le run en cours ; `/branches` et `/retry` **refusent** à la place | arrêté (lot 7) |
| 6b | `/redo` refuse dès qu'un tour a été écrit depuis le `/undo`, et nomme la branche | arrêté (lot 8) |
| 7 | `/branches`, `/fork`, `/retry`, `/undo`, `/redo` + `META_COMMAND_PATTERN` | arrêté |
| 8 | Sorties d'outils : **pas de TTL**, durée de vie = l'entrée, GC des orphelins seuls | arrêté |
| 9 | Snapshots : retenus, **un shadow par dépôt**, profondeur 3, workspace only, restauration proposée | arrêté |
| 10 | App : plafond ~500 entrées en mémoire, pagination conservée | arrêté |
| 11 | Pas de `branchWithSummary` au lot 7 (un appel LLM par changement de branche) | arrêté |
| 12 | Sous-agents **pas** convertis en lanes : ils sont inter-sessions par conception, ce que les lanes ne modélisent pas. L'arbre ne ferme pas la porte. | arrêté |

Reste à surveiller, pas à décider maintenant : la taille d'un thread de deux ans. Le lot 5
enlève 94 % du volume ; le reste est du texte.

---

# Annexe C — Journal de livraison

## Ce qui tourne aujourd'hui

Le chemin critique est livré : lots 1 à 8. Le log **est** l'historique. `promptOf` fait le
prompt, `displayOf` fait l'écran, un run s'écrit par le `RunRecorder`, et l'arbre est
accessible au propriétaire par `/branches`, `/fork`, `/retry`, `/undo` et `/redo`.
`promptMessages`, `sealDanglingToolCalls`, `prePushed` et `messageCountBeforeLoop` n'existent
plus. Au boot, chaque `<id>.json` devient un `<id>/` et l'ancien fichier part dans
`sessions-archive/`.

Restent optionnels : les lots 9 (queues persistables) et 10 (snapshots), le champ `messages`
de `SessionData` que `manager.ts` lit encore pour ses compteurs, et les boutons de l'app pour
les branches et l'undo, les lots 7 et 8 n'ayant livré que les commandes.

### Un répertoire remplace le fichier plat : les deux moitiés de « trouver une session »

Mesuré en prod sur 0.4.53, après une migration pourtant propre (69 migrées, 3 sautées,
0 échec) : **aucune conversation n'était plus joignable depuis le tiroir de l'app.**

« Trouver une session sur le disque » se fait à deux endroits, et un seul avait appris le
nouveau format. `legacySessionIds` (`migrate.ts`) s'était donné le garde-fou et l'avait même
nommé — *un répertoire migré est aussi un répertoire, qui contient `meta.json`* — mais
`scanSessionFiles` (`store.ts`) cherchait toujours des `*.json` en descendant partout. Comme
la migration archive le vrai `<id>.json`, le seul `.json` restant sous une conversation était
son propre `meta.json` : le parcours rendait `<id>/meta`, un id qui ne désigne rien. Une
conversation réelle, zéro. Et comme un threadId est le dernier segment d'un id, les neuf
fantômes se réduisaient au même : `"meta"`.

Trois conséquences du même oubli, corrigées ensemble :

1. **La liste.** `scanSessions` s'arrête sur un répertoire qui contient `entries.jsonl` et rend
   ce répertoire. Le nom du fichier est une constante partagée (`ENTRIES_FILE`) plutôt que trois
   orthographes. Une session peut être des deux formes à la fois tant que `persist` écrit encore
   un fichier plat à côté, donc les ids sont dédupliqués sur la plus récente des deux dates.
2. **Le chargement.** `loadSession` lisait le fichier plat, donc rendait `null` pour toute
   session migrée — et `getOrCreateWithMeta` en déduisait « pas de session » et en fabriquait
   une neuve : mêmes entrées sur le disque, mais titre, modèle, fenêtre et approbations aux
   valeurs par défaut, que le `persist` suivant écrivait par-dessus `meta.json`. Il lit
   maintenant le répertoire quand le plat a disparu (`sessionFromMeta`, l'inverse de `metaOf`).
   La migration reçoit `loadLegacySession`, qui ne lit que le plat : sinon la passe pourrait
   relire sa propre sortie.
3. **La purge.** `pruneOldSessions` supprimait chaque `*.json` rendu par le parcours, c'est-à-dire
   `<id>/meta.json` tout seul pour une session `cron/*` inactive depuis 30 jours : un log
   d'entrées sans réglages, assez présent pour être listé, trop cassé pour être ouvert. Elle
   supprime le répertoire entier.

La leçon n'est pas « il manquait un garde-fou ». Il était écrit, à quatre lignes de là, avec le
mode de panne en commentaire. Ce qui manquait, c'est qu'un fait aussi structurant que *« une
session est un répertoire »* était encodé deux fois, dans deux parcours indépendants.

#### Et une conversation vide n'est pas « pas une conversation »

Le correctif ci-dessus a unifié le test, mais sur le mauvais critère, et 0.4.55 a **crash-loopé**
en prod. Une conversation vide se migre en `appendAll([])`, qui n'écrit aucune ligne : le
répertoire n'avait donc pas d'`entries.jsonl`. Un test portant sur le log seul la lisait comme
« pas une session », descendait dedans, et proposait `<id>/meta`. Charger cet id rend le
`meta.json` analysé, qui n'a pas de `messages` — et le premier `.length` dessus a emporté le
process : `SessionManager.cache` (`manager.ts:172`), atteint par `peek`, atteint par
`pinnedSessionIds`. **Épingler une conversation suffisait à tuer le serveur**, que systemd
relançait, jusqu'à la prochaine tentative. Cinq boucles mesurées entre 12:14 et 12:17 UTC.

Le même critère faisait aussi re-migrer cette conversation à chaque boot : `alreadyMigrated`
portait sur `entries.jsonl`, donc répondait « non » indéfiniment, et la passe réarchivait le
fichier plat que `persist` venait de réécrire.

Trois changements, du plus structurel au plus défensif :

- `holdsSession(names)` est le seul endroit qui décide si un répertoire *est* une session, et
  **une moitié suffit** : le log ou les réglages. `ENTRIES_FILE` et `META_FILE` n'ont plus qu'une
  seule orthographe, dans `log.ts`, qui possède la disposition du répertoire.
- `openSessionLog` crée `entries.jsonl` vide en même temps que le répertoire, au lieu d'attendre
  le premier append. L'invariant « un répertoire de session contient son log » devient vrai dès
  l'existence du répertoire, donc la forme « réglages sans log » ne se reproduit plus.
- `loadLegacySession` vérifie que ce qu'il a analysé est bien une session (`messages` est un
  tableau) au lieu de faire confiance à son `as SessionData`. Un `.json` sous `sessions/` n'est
  pas nécessairement une session : `<id>/meta.json` est à un segment de là. Un fichier qui n'est
  pas une session se lit comme pas de session, et une lecture douteuse cesse d'être un crash.

Ce qui aurait attrapé ça plus tôt : le cas vide. Les deux correctifs précédents ont été testés
sur des conversations qui avaient des entrées.

#### Et un fichier nommé `meta.json` n'est pas forcément des réglages

Le critère « une moitié suffit » avait lui-même un trou, trouvé avant déploiement en se demandant
ce qu'avait produit un **clic suivi d'un message** dans la conversation fantôme de 0.4.53 : cela
persiste `<owner>/meta.json`, un fichier **de session** qui se trouve porter le nom d'un fichier
de réglages, posé un cran au-dessus des conversations. La règle « un répertoire contenant
`meta.json` est une session » lisait donc le répertoire du propriétaire comme une conversation, et
**cachait toutes les vraies** — pire que le défaut qu'on corrigeait.

`holdsSession` lit maintenant le fichier quand le log est absent : seuls des réglages portent
`storageVersion`. Une session ordinaire n'en a pas, donc `<owner>/meta.json` reste une session
parmi les autres, que la migration convertit en répertoire comme n'importe quelle autre. Le
message que le propriétaire y a écrit est conservé, sous un thread nommé `meta` qu'il peut
supprimer.

Le coût est une lecture de fichier par répertoire sans log, c'est-à-dire seulement sur les
répertoires écrits par 0.4.53 à 0.4.55 — `openSessionLog` garantit le log pour tous les suivants.

### Le répertoire est ce qu'on relit

Restait la question laissée ouverte : quand les deux formes coexistent, laquelle fait foi ?
C'est le répertoire, et il a fallu rendre deux choses vraies en même temps.

**Le répertoire ne doit jamais être la copie la plus vieille.** `persist` écrivait `meta.json`
seulement si un log était ouvert — donc il le sautait exactement quand aucun run n'en avait
ouvert : renommer un fil dans un process neuf atteignait le fichier plat et pas le répertoire.
Il l'écrit maintenant toujours. Le curseur de branche est repris du fichier quand aucun log
n'est ouvert, jamais remis à `null` : `null` veut dire « repartir de la fin du log », donc
l'écrire sur une conversation garée sur une branche ancienne la ramènerait silencieusement au
dernier tour. Et un `meta.json` illisible est laissé tel quel — le seul cas où refuser d'écrire
est plus sûr qu'écrire, puisque `metaOf` laisserait tomber les champs qu'il ne connaît pas.

**Écrire le répertoire ne doit pas effacer la moitié que la session ne possède pas.**
`metaOf` reconstruit les réglages depuis la session, donc tout ce que `branch-commands` écrit
directement dans le fichier disparaissait à l'écriture suivante. Mesuré sur 0.4.57 publiée : un
seul `persist` après un `/fork` effaçait `forkedFrom` **et toutes les branches nommées**. Le
`/fork`, le `/branches <nom>` et l'`/undo` ne survivaient donc que jusqu'au tour suivant. Un
`Record<keyof SessionMeta, "session" | "carried">` dit maintenant qui écrit chaque clé, et une
clé ajoutée à `SessionMeta` sans être classée **casse la compilation** au lieu d'être effacée
au prochain write. Le report ne concerne que les clés `carried` : un réglage que le
propriétaire efface reste effacé, il n'est pas ressuscité depuis l'ancien fichier.

### Les derniers lecteurs restés braqués sur l'ancien monde

Une fois le répertoire canonique, il restait des endroits qui parlaient encore au fichier plat ou
au tableau `messages`. Aucun ne levait d'erreur : ils rendaient simplement zéro.

**`/reset` d'un sous-agent ne réinitialisait rien.** `archiveSession` déplaçait `<id>.json`, qui
depuis le basculement ne contient que les réglages et un `messages` vide — la conversation, elle,
est `<id>/entries.jsonl`. Le sous-agent « frais » revenait donc avec tout ce qu'il était censé
avoir oublié. Mesuré : 1 entrée avant, 1 entrée après. `archiveSession` déplace maintenant les
deux moitiés, le répertoire vers `<archive>/<ts>/` et le fichier legacy vers `<archive>/<ts>.json`.

Et le manager doit **oublier le log**, pas seulement le vider : il est mis en cache aussi longtemps
que la session, et il retient sa feuille. Laissé en place, le `persist` suivant écrivait cette
ancienne feuille dans les réglages de la conversation neuve, et `logOf` continuait à rendre un log
dont le fichier avait bougé. D'où `archiveConversation` sur le manager, que `runner.ts` appelle
quand un manager existe.

**Les conversations de sous-agents n'étaient plus cherchables.** `indexSessionArchive(session)`
itère `session.messages`, appelé à cinq endroits de `runner.ts` : cinq no-ops depuis le
basculement. `indexSessionEntries(session, entries)` indexe depuis le log. Les sorties d'outils
sont exclues — les indexer noierait le corpus dans le bruit qu'elles servent justement à cacher.
`indexSessionArchive` reste, pour le backfill des archives legacy qui ont, elles, un vrai
`messages`.

**Le compteur `skipped` grimpait pour toujours.** `persist` réécrit un fichier plat à côté de
chaque répertoire migré, donc `legacySessionIds` le proposait, `alreadyMigrated` répondait « oui »,
et la passe comptait un saut à chaque boot. Mesuré sur une copie d'une install réelle :
`skipped: 10`, indéfiniment. Un fichier legacy posé à côté de son propre répertoire migré n'est
pas du travail à faire : il n'est plus proposé, et la passe retombe à `skipped: 0`.

Ce que l'inversion rend visible, c'est que `messages`, `commands` et `failures` de `SessionData`
ne survivaient que par le fichier plat. `messages` est mort — rien dans `src/` n'y ajoute depuis
le basculement, seul `manager.ts` le vide et compte. `commands` et `failures` sont des copies
« legacy compat » de ce que le log détient déjà, et c'est le log que l'app relit. Neuf tests
affirmaient ces round-trips : ils affirment désormais la même intention sur un champ vivant,
ou visent explicitement `loadLegacySession` quand c'est bien la forme legacy qui est en jeu.

### Le fichier plat est parti, et avec lui tout ce qui le lisait

Le `<id>.json` ne pesait plus que **8 Ko sur dix conversations** (médiane 596 octets) contre
58,6 Mo de logs : son `messages` était vide. Le garder ne coûtait donc rien en I/O — le gain de la
refonte était déjà acquis. Ce qu'il coûtait, c'est **un second store des mêmes faits**, et un champ
au type vivant sans sens vivant.

Ce piège s'est refermé trois fois : `recordSessionSubAgentState` parcourait `session.messages`,
`indexSessionArchive(session)` était appelé cinq fois depuis `runner.ts`, et le garde-fou de
`flushDirty` comparait `savedCounts` à `messages.length`. Trois no-ops silencieux, dont un qui a
fait disparaître la recherche sur les sous-agents.

`persist` n'écrit plus que les réglages. `SessionData` perd `messages`, `commands` et `failures` ;
`LegacySessionData` porte l'ancienne forme, pour la migration et pour le backfill de recherche qui
lit les copies déjà présentes dans `sessions-archive/`. `saveSession` n'existe plus.

**Ce que le retrait a mis au jour, et qui était cassé sans que rien ne le dise** — chaque endroit
qui répondait à « quelles sessions existent ? » en cherchant des `*.json` :

- `runner.list` globait `sessions/subagent/*.json` : **le tiroir des sous-agents était vide** dès
  que le fichier plat n'était plus écrit. Il passe par le parcours partagé.
- `registry.listExistingIds` faisait le même glob : la génération d'id ne voyait aucun id pris.
- `subagentThreadToSession` idem, donc un thread de sous-agent ne se résolvait plus.
- `kill_agent` appelait `deleteSessionFile`, qui retire `<id>.json` et laisse `<id>/entries.jsonl` :
  il annonçait une suppression et le sous-agent revenait entier à la lecture suivante. C'est le
  même défaut que `/reset`, et `deleteStoredSession` le corrige au même endroit pour les deux.
- `clearHistory` vidait un tableau mort et n'était appelé que par des tests. `getInfo` inventait un
  compteur. Les deux partent.
- La chaîne `toChatMessages → sessionChatMessages → dropLeadingOrphanToolMessages` n'avait plus
  aucun appelant en production — `promptSideChat`, écrit deux jours plus tôt, n'était appelé que
  par un test. La réparation d'orphelins qu'elle portait est devenue structurelle :
  `alignEntryTailBoundary` recule sur les entrées d'outil, donc une frontière de compaction ne peut
  pas tomber sur un résultat d'outil (couvert par `compaction.test.ts`).

Trois compteurs de surface (`/status`, la liste des runs cron, l'état renvoyé à l'app) lisaient
`messages.length`. Ils comptent maintenant les entrées du log. **Le champ de protocole garde son
nom `messages`** : un APK déjà installé le lit sous ce nom et ne se met pas à jour au rythme du
serveur, donc renommer pour la cosmétique casserait des clients.

**Ce qui n'était pas fait, et pourquoi.** `ToolEntry.spawn` existe, `display.ts` le rend, `import.ts`
le remplit depuis une session d'avant la refonte — mais rien ne l'alimentait pour une conversation
neuve, parce que `call.spawn` n'est jamais assigné. La persistance du cycle de vie des sous-agents
n'a donc jamais fonctionné depuis le basculement. Le code qui prétendait le faire est retiré, ce
qui rend le trou visible ; le combler demande de décider comment l'état terminal rejoint l'entrée
d'outil, qui est écrite après lui. Et la règle « un état terminal est collant » que son test
encodait est perdue avec lui : elle devra être réécrite sur le log. **Livré depuis** — voir
« Un état qui arrive après son entrée » plus bas et §3.5.

| Fichier | Rôle | Tests |
|---|---|---|
| `sessions/log.ts` | l'entrée, `append`, `appendAll`, `branch`, `since`, `pathOf` | 32 |
| `sessions/projection.ts` | `promptOf`, `contextEntries` | 20 |
| `sessions/import.ts` | `SessionData` → entrées, pur | 28 |
| `sessions/meta.ts` | la moitié réglages, `storageVersion` | (couvert par migrate) |
| `sessions/migrate.ts` | la passe one-shot, idempotente | 15 |
| `sessions/tool-output.ts` | spill au-delà de 50 KB, lecture, GC des orphelins | 14 |
| `sessions/spawn-state.ts` | `spawnStates`, `cardOf`, `appendSpawnState`, `recordSpawnLifecycle` | 16 |
| `channels/my-claw-app/display.ts` | `displayOf`, `pageOf`, `withSpawnCards` | 30 |
| `tests/sessions/prompt-conformance.test.ts` | le prompt gelé en littéraux, sans témoin | 15 |

### Un état qui arrive après son entrée

Le trou signalé ci-dessus est comblé, et la façon dont il l'est vaut d'être notée parce qu'elle
se reposera : **une entrée est écrite une fois, et certains faits arrivent après.**

Deux dépôts ont été lus avant de trancher. **pi-mono** n'offre rien d'exploitable : son seul
stockage en production (`SessionManager` v3, 1715 lignes) est un JSONL à entrées plates, c'est-à-dire
le nôtre avec le même trou ; son successeur v4 est complet et testé mais son unique consommateur
`AgentHarness.prompt()` fait `throw` ; et le modèle à registres mutables décrit sur 2941 lignes
dans `docs/harness.md` n'existe nulle part dans le code. **opencode v2** en offre un, vivant :
table `event` append-only, tables `message`/`part` projetées **dans la même transaction**, l'UI
lisant la projection et jamais le log, chaque append étant un instantané complet que le projecteur
`UPSERT` par-dessus.

Retenu : le principe, pas la base SQLite. Le JSONL reste la vérité, la projection est repliée à la
lecture (`spawnStates`), et l'instantané complet se fait au moment de projeter plutôt qu'au moment
d'écrire. Aucun consommateur n'a besoin de SQL sur les parts, et le manager LRU met déjà la session
repliée en cache.

**Ce que ça a corrigé au passage.** `ToolEntry.spawn` n'est pas un champ mort : 26 entrées d'un log
de prod le portent, toutes issues d'`import.ts`. L'audit initial concluait « zéro donnée » et se
trompait — le champ est **legacy et figé**, pas vide, et le retirer aurait effacé de l'historique
affiché. Il reste donc en lecture, comme plancher du pli.

**La carte en double, et pourquoi les tests ne l'ont pas vue.** 0.4.61 renvoyait la carte deux
fois à chaque rechargement. La cause tient en une phrase : `spawn` **attend** son enfant, donc
les deux `spawn_state` sont écrits *avant* l'entrée d'outil et arrivent d'abord dans le même
delta — `withSpawnCards` se substituait sur le premier état, puis laissait passer l'entrée
réelle. Mes tests couvraient l'ordre inverse, celui que j'avais supposé avant de lire
`runner.ts:255-264`. C'est deux fois la même erreur dans la même journée : **tester la géométrie
imaginée plutôt que celle que le code écrit.** Le test porte désormais les deux ordres, et un
test d'intégration rejoue un rechargement complet dans l'ordre réel.

À retenir sur le protocole : le client remplace une carte par id **contre ce qu'il détient
déjà** (`chat.ts:511`), pas à l'intérieur d'un delta. Deux exemplaires dans une même trame
passent tous les deux.

**Vérifié sur les vraies données** (copie du store, 70 sessions, 17 190 entrées) : 26 cartes
repliées, toutes `complete`, toutes venant du legacy inline ; aucun `spawn_state` n'atteint un
prompt ; aucune carte orpheline ; 5 996 bulles projetées sans erreur. Puis un cycle de vie complet
rejoué par le bus sur une vraie conversation : `complete`, `error`, `killed`, encore en cours,
`send` réinitialisé, plus un `kill` tardif visant un enfant déjà réglé — les six cartes se relisent
correctement après réouverture, le `kill` tardif est refusé, et l'enfant sans carte n'écrit rien.

## Mesures sur les vraies données

Passe à blanc sur une copie du store réel (68 sessions, 53 MB) :

- migration : **596 ms**, 68/68, 13 050 entrées, 0 échec
- `promptOf` de l'import == `promptMessages` de l'original sur **les 68**, tour pour tour
- aucun `tool_call` sans réponse dans les 68 projections
- plus grosse session, 4 239 entrées : ouverture **63 ms**, `append` **0,007 ms**,
  `promptOf` **6,6 ms** — contre 41,1 ms de `JSON.stringify` synchrone toutes les 2 s

## Trois choses trouvées en construisant, pas en concevant

**Le plancher de compaction ne se résout pas par timestamp.** La compaction insère son
résumé au milieu du tableau avec l'horloge du moment où elle tourne : sur une session
réelle ici le résumé est estampillé 18:15:35 et le tour juste après 18:14:17. Toute
recherche par `ts` saute les tours qu'elle devait garder. Résolu par position. La leçon
était déjà écrite ailleurs dans le code (« l'ordre du tableau fait foi, l'horloge est un
indice ») et n'avait pas été appliquée là.

**Une frontière de compaction n'a pas une géométrie mais deux.** Vivante, elle est
ajoutée *après* les tours qu'elle couvre ; importée, elle siégeait *au milieu* du tableau
qu'elle résumait. Même énoncé, deux positions. `contextEntries` garde donc « tout à partir
du plancher » au lieu d'une tranche entre deux index, et les deux cas se confondent.

**Une entrée qui doit en nommer une autre a besoin d'un instant qui n'existait pas.**
`append` sérialise sa ligne immédiatement et aucune entrée n'est jamais réécrite : une
référence croisée ne peut donc être résolue ni avant (l'id n'existe pas) ni après (la
ligne est écrite). D'où `appendAll(payloads, patch)`, qui attribue les ids manquants, conserve ceux fournis par un canal
et assigne le chaînage de tout un lot, laisse résoudre, puis écrit.

## Ce que la bascule a trouvé

Quatre défauts, dont trois auraient tourné en production sans se voir.

**L'auto-compaction était morte.** Son seuil mesurait `session.messages.length`, un tableau
que plus rien n'alimente : jamais atteint, jamais déclenchée. Le symptôme n'apparaît qu'en
faisant exploser une fenêtre de contexte, longtemps après la cause.

**`/status` affichait zéro.** Deux appelants de `promptMessages` hors des sites recensés.
Lire le log a rendu `statusReport` asynchrone, ce qui est le vrai coût du changement.

**Le rewind repassait par-dessus une question du propriétaire.** Le recorder rembobinait à
un leaf fixé à sa construction : un run qui échouait après avoir absorbé un message de
steering effaçait ce message. C'est la régression déjà corrigée une fois dans l'ancienne
boucle, réintroduite par une autre porte. Le plancher avance désormais dans `user()`
lui-même : l'invariant tient par construction et non parce qu'un appelant y pense.

**Le chemin sous-agent écrivait le tour user deux fois**, une fois dans le runner et une
fois dans le bridge.

Ce qui a permis de les trouver plutôt que de les livrer : `prompt-conformance.test.ts`, dont
les attentes sont écrites en littéraux et ne dépendent donc pas du chemin qu'elles vérifient.
Un témoin qui compare deux implémentations meurt avec celle qu'il remplace ; un témoin qui
énonce le résultat attendu survit à la bascule et c'est précisément là qu'il sert.

Correction appliquée après la bascule : `append` accepte un id fourni par le canal quand une
bulle existe déjà, avec rejet d'un doublon dans le log. `appendAll` conserve ces ids lors de
l'import legacy ; les tours `user` réutilisent donc leur `chat.send` id, et les commandes
conservent leur `sourceId`. Lors d'un fork, les ids internes sont régénérés et les références de
compaction sont remappées dans le même lot avant l'écriture.

---

# Annexe D — Où en est le lot 3b

La bascule s'est décomposée en trois, non pas pour la rendre livrable en morceaux — elle
ne l'est pas — mais parce que **deux des trois ne changent aucun comportement** et se
testent donc pour de vrai, isolément. Ce qui reste est le câblage, mécanique.

| | Quoi | État |
|---|---|---|
| 3b-i | Le manager possède le log : `logOf`, éviction, delete, `flushAll`, `meta.json` | livré `b8e5cb1` |
| 3b-ii | `RunRecorder` : la forme d'un run en entrées | livré `979465d` |
| 3b-iii | L'accès au log depuis un run (`sessionLogOf`) | livré `ebcac59` |
| 3b-iv | Le câblage dans `bridge.ts`, `compaction.ts`, `runner.ts`, `sessions.ts` | livré `0d326c6` |

## Pourquoi l'accès au log est passé devant

`bridge.ts` reçoit un `SessionData` et ne voit pas le manager qui l'a mis en cache. Ses
deux sites de construction passent déjà onze arguments positionnels : en enfiler un
douzième à travers le dispatcher et le runner de sous-agents, pour donner à chaque run une
chose que le boot possède déjà, est la mauvaise forme. D'où `sessions/log-access.ts`, la
même couture que `llm/world.ts` pour le monde de disponibilité.

Le résolveur par défaut ouvre le fichier directement au lieu de lever. Un run qui y arrive
n'a pas de cache et ne partage rien, mais il **écrit** quand même : un bridge exercé sans
manager est le cas normal en test, et la seule chose interdite est de perdre silencieusement
ce qu'un run a produit.

## Ce que 3b-iv doit faire, site par site

Huit écritures dans `bridge.ts`, toutes remplaçables une pour une :

| Ligne | Aujourd'hui | Devient |
|---|---|---|
| 414 | `messages.push` tour user (+ variante `prePushed`) | `recorder.user()` |
| 619 | `messages.push` tour assistant final | `recorder.turn()` |
| 726 | `persistedAssistant` avec `toolCalls` | `recorder.turn()` seul |
| 861 | `messages.push` résultat d'outil | `await recorder.tool()` |
| 895 | `messages.length = messageCountBeforeLoop` | `recorder.rewind()` |
| 940 | `messages.push` tour injecté | `recorder.user()` |
| 979 | `messages.push` consigne de résumé | `recorder.user()` |
| 1040 | `messages.push` résumé final | `recorder.turn()` |

Et six lectures (`429`, `435`, `457`, `458`, `565`, `1225`) qui deviennent toutes
`promptOf(entries, leaf)`.

**Le `prePushed` disparaît.** Le runner de sous-agents pré-pousse la tâche avec le même
`sourceId` avant le run pour qu'un crash montre quand même la question ; le bridge
complétait ensuite cette bulle au lieu d'en pousser une seconde. Avec le log, le runner
écrit une `UserEntry` et le bridge n'a rien à compléter : l'entrée porte déjà son id.

**`sealDanglingToolCalls` disparaît des deux côtés** (démarrage de run, abort). Il
répare une forme que le recorder ne produit pas : les `tool_calls` du prompt sont dérivés
des entrées qui portent les résultats.

**`messageCountBeforeLoop` disparaît.** C'était l'index de rembobinage ; le recorder tient
un leaf, ce qui est la même information sans dépendre de la longueur d'un tableau.

**`user()` déplace le plancher de rembobinage.** Un run qui échoue ne doit jamais emporter
une question que le propriétaire a posée. Dans le code actuel, `messageCountBeforeLoop`
est re-fixé après chaque tour user (initial ou injection mid-run). `RunRecorder.user()`
reprend cette sémantique en avançant `startLeaf` à chaque appel, de sorte que `rewind()`
ne remonte jamais par-dessus un tour user. L'invariant tient par construction, pas par
discipline de l'appelant.

## Ce qui reste vrai après, et qu'il faut vérifier avant de retirer quoi que ce soit

`tests/sessions/prompt-conformance.test.ts` gèle le prompt attendu en littéraux, sans
comparaison à `promptMessages` — il survit donc à la suppression de son propre sujet. Le
dernier bloc du fichier, lui, compare encore les deux chemins : il part avec eux.

## Comment 3b-iv se fait : d'un bloc, sans double écriture

Deux voies existaient. La double écriture transitoire — le bridge alimente `messages` *et*
le log, avec une assertion d'égalité en fin de run — aurait permis de valider le
`RunRecorder` contre de vrais runs avant que quoi que ce soit en dépende. C'est un shim de
compatibilité, que `AGENTS.md` interdit, et l'exception n'a pas été prise : un shim daté
reste un shim, et celui-ci demandait de maintenir deux écritures cohérentes dans les huit
sites les plus délicats du fichier — soit exactement le double usage que la refonte
supprime, réintroduit là où il coûte le plus cher.

**Retenu : un seul diff.** `bridge.ts`, `compaction.ts`, `runner.ts`, `sessions.ts`, plus
les tests. Le filet n'est pas une double écriture mais
`tests/sessions/prompt-conformance.test.ts`, qui gèle le prompt attendu en littéraux et ne
dépend donc pas du chemin qu'il vérifie.

**Volume mesuré : 27 fichiers de tests** touchent `session.messages` (et non 41 : le
premier comptage incluait `src/**/__tests__/` et des occurrences du mot sans rapport).
C'est le gros du diff, pas les 14 sites de production.

Aucun helper de test ne construit de session : il n'y a donc pas de point unique où
absorber le changement, chaque fichier porte ses propres fixtures. C'est ce qui rend le
travail long plutôt que difficile.
