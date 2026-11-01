# Plan — épingler une conversation sur un modèle, et boucler sur les quotas

Deux phases, dans l'ordre. La phase 1 est une option du retry ; la phase 2 change la forme de
cette option.

Statut : **proposition, rien n'est implémenté.** Rien n'entre dans le code avant ton accord.

---

## Phase 1 — un modèle unique pour toute la session

### Le besoin

Une option, à côté de « Retry when the quota returns », qui prend **un modèle** et le pose sur toute
la session : l'orchestrateur, chaque sous-agent, chaque sous-agent de sous-agent (le navigateur
compris), quel que soit le modèle qu'ils demandent. Quand le quota de ce modèle tombe, l'attente
s'arme et **tout** repart dessus au reset.

Ce n'est pas un pin ordinaire : c'est un **override qui gagne sur tout**, y compris sur un spawn qui
nomme explicitement un autre modèle.

### Ce qui existe aujourd'hui

| Mécanisme | Portée | Force |
|---|---|---|
| `config.agents.<type>.llm.defaultModel` | un type d'agent | la plus faible |
| `agents/*.md` `model:` | un agent fichier | sous le spawn explicite |
| `session.modelOverride` | une conversation | gagne sur l'agent |
| spawn `model` / `delegate_browser_task` `model` | un enfant précis | gagne sur tout sauf un tag de session |

La précédence documentée est **session > tag > agent > capExempt > global**, et un spawn explicite
se place au niveau d'un pick de conversation. Il n'existe aucun niveau qui gagne sur un spawn.

### Les trois verrous du besoin

1. **Le modèle de l'orchestrateur.** `session.modelOverride` le porte déjà — sauf qu'un pick de tag y
   écrit `tag:Nom`, qui n'est pas un modèle. L'option prend un modèle, donc rien à changer ici.
2. **Les sous-agents.** `SubAgentRunner` résout le modèle via `resolveRunModel` à chaque run
   (`src/subagents/runner.ts:1168`) avec `pick = model ?? session.modelOverride`. Un spawn explicite
   passe devant. Il faut un cran au-dessus : lire le pin de la **racine**, et court-circuiter.
3. **Les sous-agents de sous-agents.** Ils sont créés par le même `runner.ts`, mais leur session n'a
   pas de `modelOverride` de racine. D'où `payerOf`/`invokedBy` : la session porte déjà qui l'a
   lancée, donc la racine se remonte par la chaîne des parents.

### Le design

**Le pin vit sur la session racine, dans son `meta.json`**, à côté du retry :

```ts
// SessionData
pinModel?: string;   // "provider/model" exact, jamais un tag en phase 1
```

Pas dans `config.json` : c'est une décision de conversation, comme le switch quota, et elle doit
survivre à un restart avec le fil. Le compte est celui du fil, pas de l'installation.

**Un seul point d'application**, et il existe déjà : `RunModelRequest.forcedModel`
(`src/llm/run-model.ts:235`) *« Forces the model, skipping the chain: a reroute the resolver itself
decided »*. C'est le cran au-dessus du spawn explicite, sans en ajouter un.

Dans `SubAgentRunner` (`src/subagents/runner.ts:1168`), avant `resolveRunModel` :

```ts
const rootPin = await this.rootPinOf(session);   // remonte invokedBy jusqu'à la racine
const request: RunModelRequest = {
  ...,
  ...(rootPin ? { forcedModel: rootPin } : (pick ? { sessionModel: pick } : {})),
};
```

et dans le bridge, pour l'orchestrateur, là où `llmConfig` est construit (`src/agent/bridge.ts:531`) :
si `session.pinModel` existe, il écrase `resolvedModel`. Un pin n'est pas un pick : il ne passe pas
par la chaîne de précédence, il la remplace.

**La remontée à la racine existe aussi** : `attributionParent(session)` (`src/sessions/store.ts:282`)
rend `session.invokedBy || meta.parentSessionId || session.id`, et s'arrête de remonter quand la
session est sa propre racine. Une boucle sur ce prédicat donne la racine d'un enfant de n'importe
quelle profondeur, sans nouveau champ et sans copie.

**L'héritage, pas la copie.** Les enfants ne reçoivent pas de `pinModel` : ils le lisent à la racine à
chaque run. Une copie divergerait au premier `send()` sur un enfant dont le parent a changé.

**`fallbackPolicy`.** Aujourd'hui un pin explicite interdit le fallback (`forbid`). Ici c'est
l'inverse : le pin est une **destination**, pas une restriction. Le run bascule sur un autre modèle
si le pin échoue pour une raison qui n'est pas un mur — et revient au pin au tour suivant. C'est la
différence qu'il faut écrire noir sur blanc dans `docs/provider-failures.md`, sinon quelqu'un lira
`pinModel` comme un `forbid`.

**Le retry, déjà branché.** `settleQuotaRetry` (adaptateur) et `armQuotaWait` (runner) lisent
`session.quotaRetry.enabled`. Le pin ne change rien à leur logique : il change seulement **quel
modèle** le run reprend. Le `Continue` d'une conversation repart sur `pinModel` ; le `resumeArmedWait`
d'un enfant repart sur le pin racine par la même résolution.

**L'UI.** Une ligne de plus dans le menu de conversation, sous le switch quota : *« Pin this
conversation to a model… »*, qui ouvre le **model picker existant avec le filtre déjà en place** —
pas d'écran Apply (règle du 23/10), la dernière décision applique. Le hint dit `pinned to X · every
agent, every sub-agent`, ou `off`. Deux frames : `session.model.pin.set` / le state poussé sur
chaque sync, exactement le patron du switch quota qu'on vient de réparer deux fois.

### Ce que ça touche

- `src/sessions/store.ts` — `pinModel` sur `SessionData`, et la liste des clés que `meta.ts` sait
  relire (sinon il est écrit et jamais lu).
- `src/agent/bridge.ts` — l'override au moment de composer `llmConfig`.
- `src/subagents/runner.ts` — la remontée à la racine (via `attributionParent`) et `forcedModel`.
- `src/channels/my-claw-app/{adapter,sessions,types}.ts` — deux frames, l'état dans le sync.
- `src/app/AppShell.tsx` (app) — l'entrée de menu et le picker filtré.
- `docs/quota-retry.md`, `docs/subagents.md`, `docs/provider-failures.md`.

### Les cas qui décident si ça tient

- Un spawn nomme `model: "autre/chose"` → il tourne quand même sur le pin. **C'est le cœur du
  besoin**, et c'est le test qui doit être rouge avant.
- Un enfant est `send()` après coup → il relit la racine, il ne garde pas une copie.
- Le pin est retiré pendant qu'un enfant tourne → l'enfant finit son run sur le pin (il l'a résolu),
  le suivant repart libre. Pas de changement de modèle en plein run.
- Le pin nomme un modèle qui n'existe plus → il ne résout pas : erreur claire au pick, et le run
  retombe sur la chaîne normale plutôt que de mourir. Même traitement que `modelOverride` périmé.
- Un modèle sans vision + une image → le pin ne se bat pas contre le reroute vision, qui reste la
  dernière étape. À trancher explicitement : je propose que le reroute vision gagne, parce qu'un run
  qui ne peut pas lire l'image ne peut pas travailler.

### Estimation

Une journée de travail, dont la moitié en tests. Pas de migration, pas de changement de protocole
hors les deux frames.

---

## Phase 2 — un tag, et boucler sur les quotas disponibles

### Le besoin, dit autrement

Choisir un **tag** dont la route liste plusieurs comptes du même vendeur (`chatgpt-1`, `chatgpt-2`,
`claude-1`, `claude-2`…), et **consommer les quotas dans l'ordre de la route** : on épuise le premier,
on passe au deuxième, au troisième — et dès qu'un précédent est redevenu disponible, on **remonte**
au plus haut dans la liste. Le premier de la liste a toujours la priorité.

C'est une politique de sélection, pas un simple pin : elle change **à chaque run** en fonction de ce
que les barres disent.

### Ce qui manque

1. **La route n'est pas un ordre de consommation.** `RunModelRoute.selectedIndex` est choisi une
   fois par `resolveRunModel`, d'après la disponibilité *déclarée* (le provider a-t-il répondu, la clé
   est-elle là), jamais d'après les quotas. Une route `[chatgpt-1, chatgpt-2, claude-1]` aujourd'hui
   démarre sur le premier *disponible*, pas sur le premier *ayant du quota*.
2. **Le retour en arrière n'existe pas.** `providerFallbackTargets` retire les candidats déjà tentés
   (`attempted`), par run. Un candidat épuisé n'est jamais re-testé dans le même run — ce qui est
   correct pour une panne, faux pour un quota qui se réouvre.
3. **Les comptes multiples ne sont pas adressables comme un groupe.** Deux providers `chatgpt-1` et
   `chatgpt-2` sont deux entrées indépendantes ; rien ne dit qu'ils partagent un vendeur, ni qu'ils
   forment une réserve.

### Le design

**Une politique sur le tag, pas un nouveau type de route.** Dans `config.tags`, un champ :

```ts
{ route: [...], quotaOrder: "return-to-top" }   // absent = comportement d'aujourd'hui
```

**Le sélecteur lit les barres avant de choisir.** Un nouveau module
`src/llm/quota/consumer.ts` :

```ts
pickByQuota(route, { readQuota, now }) -> { index, reason }
```

Il interroge `quotaFor(...)` pour les candidats (en cache, sans force), écarte ceux dont **toutes** les
barres périodiques sont pleines ou dont le reset est passé mais la lecture périmée, et renvoie le
**premier** de la route qui a de la place. Ordre de route = ordre de priorité, toujours.

**La remontée** découle de la même règle, sans état : à chaque run, le premier ayant de la place est
pris. Si le premier s'est réouvert, il reprend sa place — c'est exactement « on remonte au premier ».
Pas de pointeur, pas de mémoire de consommation : **une fonction du présent**, ce qui évite tout un
classe d'états incohérents après un restart.

**Le mur en cours de run.** Quand un run tombe sur un mur, la cible suivante est le prochain candidat
**qui a du quota maintenant**, pas simplement le suivant de la liste. `providerFallbackTargets` reçoit
donc le résultat de `pickByQuota` au lieu de l'ordre brut. C'est le seul endroit où la phase 2 touche
du code chaud : c'est aussi celui où le risque est le plus grand.

**Le pin de la phase 1 grandit d'un cran.** `pinModel` accepte un `tag:` ; la politique de la phase 2
s'applique à la route du tag. C'est pour ça que la phase 2 est plus grosse : le pin devient un choix
de route, pas un choix de modèle.

### Ce qui peut mal tourner (à traiter dans le plan, pas après)

- **La lecture coûte des requêtes.** Un tag à cinq candidats = cinq probes. La cadence par provider
  (120 s / 300 s) les amortit, mais un run qui boucle dessus ne doit pas marteler : lecture en cache
  seulement, jamais `force`, et un `unknown` (provider muet) compte comme disponible.
- **Un provider sans source de quota** (LiteLLM, Groq, Gemini) ne peut pas être ordonné. Il doit être
  traité comme « disponible » — sinon un tag qui le contient deviendrait inutilisable.
- **Deux comptes du même vendeur ne sont pas toujours interchangeables** : une scopée hebdo peut
  nommer un modèle précis. La barre dit `Week · Fable` ; il faut que la sélection lise la bonne barre
  plutôt que « au moins une barre pleine ».
- **La boucle et l'attente ne doivent pas se contredire.** Si tous les candidats sont pleins, le run
  s'arrête et arme **une** attente sur le reset le plus proche de la route, pas une par candidat.
- **Le `forbid` reste le `forbid`.** Un run qui a explicitement interdit le fallback ne boucle pas,
  même sous politique : sinon la politique contourne la décision du propriétaire.

### Estimation

Deux à trois journées, dont une sur les tests et une sur la lecture des barres par modèle scopé. La
partie UI est petite (le picker accepte déjà les tags) ; la partie risquée est la sélection en cours
de run.

---

## Ordre proposé

1. **Phase 1** maintenant : elle est petite, elle répond au besoin immédiat, et toutes ses décisions
   se retrouvent en phase 2 (le pin devient un tag, la politique s'y greffe).
2. **Phase 2** ensuite, avec la phase 1 en production pour voir comment les comptes multiples se
   comportent vraiment.

## Les trois décisions qu'il me faut avant d'écrire du code

1. **Le pin gagne-t-il sur un spawn explicite ?** Ta demande dit oui (« quoi qu'il arrive »). Ça
   signifie qu'un `spawn model: X` sous une conversation épinglée tourne sur le pin, sans
   avertissement. Je suis d'accord, mais c'est une règle qu'on ne pourra plus changer sans casser des
   habitudes.
2. **Le reroute vision gagne-t-il sur le pin ?** Un modèle sans vision + une image : soit le pin est
   abandonné pour ce run (mon avis), soit l'image fait échouer le run.
3. **Où vit la politique de bouclage en phase 2 :** sur le tag (une config réutilisable, ce que je
   propose), ou par conversation (un réglage de plus dans le menu) ? La config me semble le bon
   niveau : c'est une propriété de la route, pas d'un fil.
