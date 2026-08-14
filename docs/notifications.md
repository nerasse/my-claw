# Notifications de run vers l'app (UnifiedPush + ntfy)

L'app my-claw-app reçoit une notification système quand un run de session ou un job cron se
termine. Le canal est **UnifiedPush**, avec un serveur **ntfy self-hosté** comme serveur push
**aucun Firebase, aucun Google**, cohérent avec le reste de l'infra.

## Architecture

```
┌──────────────┐   POST JSON plaintext    ┌─────────────────┐   connexion persistante   ┌──────────────┐
│  my-claw     │ ───────────────────────► │  ntfy (VPS)     │ ◄──────────────────────── │  app ntfy    │
│  (serveur)   │    endpoint /up/<secret> │  (serveur push) │     socket websocket     │  (distributeur│
└──────────────┘                          └─────────────────┘                          │   sur le tel) │
                                                                                      └──────┬───────┘
                                                                                             │ broadcast local
                                                                                             ▼
                                                                                    ┌──────────────┐
                                                                                    │  my-claw-app │
                                                                                    │  (notif système│
                                                                                    │  rendue en Kotlin│
                                                                                    └──────────────┘
```

1. **Serveur push** : un ntfy (docker ou binaire) tournant sur le VPS. C'est lui qui détient
   la connexion avec les téléphones. Il n'y a rien à configurer de particulier : les topics
   UnifiedPush (`/up/…`) sont supportés nativement.
2. **Distributeur** : l'application **ntfy** (ou NextPush) installée sur le téléphone et
   sélectionnée dans les paramètres de l'app. C'est elle qui maintient la connexion au serveur
   push, donc elle doit rester autorisée en arrière-plan (exemption de batterie recommandée
   dans les paramètres système).
3. **Enregistrement** : à chaque démarrage, l'app appelle `registerDevice(vapidPublicKey)`
   avec la clé VAPID publique que le serveur my-claw lui envoie (frame `notifications.info`,
   envoyée dès la connexion du socket). Le distributeur répond par une *subscription* de forme
   Web-Push : `{ url, pubKey, auth }`. L'app l'envoie au serveur via la frame
   `notifications.register`.
4. **Publication** : quand un run se termine, le serveur envoie le payload **chiffré Web Push
   (RFC 8291)** à l'endpoint `url` reçu, avec une signature VAPID. Le connecteur Android du
   téléphone déchiffre avec les clés `p256dh`/`auth` qu'il a générées à l'enregistrement et
   **jette tout ce qu'il ne peut pas déchiffrer** : un plaintext n'est jamais affiché. C'est
   pourquoi `web-push` (la bibliothèque npm) construit la requête (body chiffré + en-têtes
   VAPID), le transport restant un simple POST. Un endpoint qui répond 404/410 est considéré
   mort et retiré de la liste, au lieu d'être retenté à chaque run. Le secret de l'endpoint
   (`/up/<secret>`) authentifie le push côté ntfy.
5. **Rendu** : `expo-unified-push` (côté app) rend la notification système à partir du JSON
   `{ id, title, body, url }`. Le tap ouvre le deep link `url` (voir plus bas).

## Payload publié

```json
{
  "id": 1723300000000,
  "type": "runs",
  "title": "<nom de session ou de job>",
  "body": "Run finished in 42s: <extrait de la réponse>",
  "url": "myclaw://thread/<threadId>" | "myclaw://job/<jobId>"
}
```

`type` nomme le canal Android (`<package>:unified_push_channel:<type>`). L'app pré-crée ce
canal en `IMPORTANCE_HIGH` au boot, ce qui rend la notification affichable en bannière en haut
de l'écran ; la lib expo-unified-push ne le crée qu'en `IMPORTANCE_DEFAULT` (son sans
bannière), mais les réglages d'un canal sont figés à sa première création, donc la
pré-création gagne. `type` doit rester stable pour que le canal ne change pas.

## Événements notifiés

| Événement serveur | Titre | Body | Deep link |
| --- | --- | --- | --- |
| `message:route:complete` | titre de session (ou premiers mots du message) | `Run finished in <durée>: <extrait>` | `myclaw://thread/<id>` |
| `message:route:error` | idem | `Run failed after <durée>: <erreur>` | `myclaw://thread/<id>` |
| `session:compact:finished` (ok) | titre de session | `Context compacted in <durée>` | `myclaw://thread/<id>` |
| `session:compact:finished` (échec) | idem | `Compaction did not run: <raison>` | `myclaw://thread/<id>` |
| `cron:job:end` (succès) | nom du job | `Job finished` | `myclaw://job/<id>` |
| `cron:job:error` | nom du job | `Job failed: <erreur>` | `myclaw://job/<id>` |

Règles :

- **Job silencieux** (`[SILENT]`) : pas de notification, comme pas de livraison : la sortie est
  supprimée par choix.
- **Session ouverte au premier plan** : l'app envoie en continu son état
  (`notifications.state { foreground, threadId }` sur chaque changement AppState/thread
  actif). Le serveur **saute** la notification de run de session pour un device qui est au
  premier plan sur le thread concerné (la réponse défile déjà à l'écran). Les notifications de
  jobs ne sont jamais sautées.
- **Compaction** : même règle de premier plan. Une compaction est la seule opération longue
  sans stream derrière elle (une à deux minutes de silence, puis une seule frame de résultat),
  donc sa fin est annoncée à tous les devices qui ne la regardent pas.
- Publication **best-effort** : un endpoint mort ou un push server injoignable ne fait jamais
  échouer le run (warn dans les logs seulement).

## Files et stockage (`~/.my-claw/push/`)

- `vapid.json` : la paire de clés VAPID générée au premier boot (publique + privée). La clé
  publique part à l'app via `notifications.info` et identifie notre serveur dans la signature
  VAPID ; la privée signe chaque push.
- `endpoints.json` : endpoints UnifiedPush par device id (`notifications.register` /
  endpoint vide = désinscription).
- `foreground.json` : dernier état premier-plan par device.

## Frame du canal my-claw-app

| Sens | Frame | Contenu |
| --- | --- | --- |
| serveur → app | `notifications.info` | `{ vapidPublicKey }`, envoyé à la connexion |
| app → serveur | `notifications.register` | `{ endpoint, pubKey?, auth? }` ; endpoint vide = désinscription |
| app → serveur | `notifications.state` | `{ foreground, threadId? }` |

## Tap → ouverture

Le rendu natif d'expo-unified-push met le champ `url` dans le PendingIntent d'ouverture :
un tap ouvre le deep link (schéma `myclaw://`, intent-filter déclaré dans l'AndroidManifest).
L'app résout au démarrage (`Linking.getInitialURL`) ou en direct (listener) :
- `myclaw://thread/<threadId>` → ouvre la session ;
- `myclaw://job/<jobId>` → ouvre la page Jobs.

Limitation connue : le rendu natif relance l'activité avec `FLAG_ACTIVITY_CLEAR_TASK`, donc un
tap alors que l'app est déjà ouverte **recharge** l'écran (état de navigation perdu). À
corriger dans le module natif si ça dérange.

## Limites (à connaître avant de brancher)

- **Android uniquement** : UnifiedPush est un standard Android. Un futur build iOS ne pourra
  pas recevoir de push sans passer par APNs (donc Firebase/Expo push pour iOS) ; les
  notifications locales restent possibles app vivante. Un futur build web utiliserait la
  Notification API/Web Push (VAPID), que ntfy supporte côté serveur.
- **Force-stop** : si l'utilisateur force l'arrêt de l'app dans les paramètres Android, plus
  rien ne peut être délivré (limite Android officielle, même avec FCM) : l'app doit être
  rouverte une fois.
- **App tuée par swipe** : couvert (le distributeur reçoit et l'app affiche via le service
  natif), tant que le distributeur (app ntfy) est autorisé en arrière-plan.
- **Émulateur** : les notifications UP ne fonctionnent pas sur émulateur (l'API de la lib le
  refuse explicitement).

## Setup d'une installation neuve

1. **Serveur ntfy** sur le VPS (docker `binwiederhier/ntfy`, port 80/443, volume de données).
   Pas de configuration particulière pour UnifiedPush.
2. **Téléphone** : installer l'app **ntfy** (F-Droid ou Play), l'ouvrir une fois, l'autoriser
   en arrière-plan (paramètres → batterie → non optimisée).
3. **L'app my-claw-app** : au premier démarrage connecté au serveur, la frame
   `notifications.info` arrive, l'app demande la permission notification, détecte le
   distributeur ntfy et s'enregistre (`registerDevice`). L'endpoint part au serveur via
   `notifications.register`. Vérifiable dans les logs serveur (`push publish …`) et en
   envoyant un message depuis une session.
4. VAPID : généré automatiquement au premier boot serveur, rien à faire.

## Implémentation

- Serveur : `src/notifications/push.ts` (clés, stores, publication Web Push chiffrée via `web-push`), frames dans
  `src/channels/my-claw-app/{types,adapter}.ts`, câblage des hooks dans `src/index.ts`.
- App : `expo-unified-push` (enregistrement + rendu natif), voir `docs/notifications.md`
  dans le dépôt my-claw-app pour le côté client.
