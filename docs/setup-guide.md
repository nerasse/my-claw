# my-claw — Guide d'installation (VPS / VM / machine Linux)

Ce guide est écrit pour être suivi pas à pas, par un humain **ou** par une IA d'agent (opencode, etc.),
sur une machine Debian/Ubuntu fraîche. Chaque étape donne la commande puis la vérification attendue.
Si une vérification échoue, la section [Dépannage](#dépannage) liste les causes connues.

> Ce guide couvre my-claw serveur `>= 0.4.71` (pairing natif unifié) et client web `>= 0.5.53`.
> Les versions antérieures ont un flow de pairing différent (copier/coller du token dans config.json).

---

## 1. Vue d'ensemble

my-claw = agent personnel single-tenant, servi depuis le navigateur ou l'app Android.
Un seul processus serveur (Bun) expose tout : le chat (WebSocket), le client web (bundle statique),
le pairing, les médias, la santé. Autour de lui, des services optionnels :

| Service | Rôle | Requis |
|---|---|---|
| `my-claw` | Le serveur (Bun) : chat, outils, mémoire | **Oui** |
| `my-claw-xvfb` | Display virtuel :99 pour le navigateur automatisé | Oui (installer) |
| `my-claw-chromium` | Chromium CDP :9222 pour la navigation | Oui (installer) |
| `my-claw-browser-sidecar` | Sidecar Node :9223 (Playwright, piloté par Bun) | Si Node installé |
| `my-claw-whisper` | STT locale (faster-whisper) :8000 | Si Python + faster-whisper |
| `my-claw-vnc` / `my-claw-novnc` | VNC :5900 / noVNC :6080 (voir le navigateur) | Oui (installer) |
| `my-claw-auto-update.timer` | Mise à jour auto toutes les 15 min | **Oui** |

**Après installation vous avez :** une CLI `myclaw` (start/stop/status/dev/update/device/web/codex/claude),
un serveur sur `:8080`, un client web pairé, des mises à jour automatiques.

---

## 2. Prérequis matériels

| Élément | Minimum | Recommandé |
|---|---|---|
| OS | Debian 12+ / Ubuntu 22.04+ (apt). Arch/DNF supportés par l'installer | Debian 12 |
| Architecture | x86_64 (linux-x64, seul tarball publié) | x86_64 |
| RAM | 4 GiB | 8 GiB+ (embeddings locaux, whisper, Chromium) |
| Disque | 5 Go libres | 10 Go+ (tarball 155 MB, extrait ~1.5 Go, mises à jour ×2, données) |
| Utilisateur | un compte non-root de service | — |

**Disque :** l'updater préflight exige ~5× la taille du tarball dans `/var/tmp` et ~4× dans le
répertoire parent de `/opt`. Un VPS de 10 Go passe, de justesse ; 20 Go est confortable.

---

## 3. Dépendances système

Prises en charge par `install.sh` (auto-install via apt/pacman/dnf) : `ffmpeg`, `chromium`,
`xvfb`, `x11vnc`, `websockify`.

À installer **avant** (l'installer vérifie leur présence) :

```bash
# Runtime + package manager (>= 1.3.13, version impliquée par la CI)
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"
export PATH="$HOME/.bun/bin:$PATH"

# Utilitaire JSON : REQUIS par update.sh / auto-update.sh (ils refusent de tourner sans)
sudo apt-get install -y jq

# Python3 : requis (utilisé par la STT locale). git/curl : quasi requis.
sudo apt-get install -y python3 git curl
```

**Optionnels mais recommandés :**

```bash
# Node >= 18 : active le browser-sidecar (browsing web automatisé). Sans lui, browsing désactivé.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs

# qrencode : affiche le QR du pairing dans le terminal (sinon seulement le code)
sudo apt-get install -y qrencode

# STT locale (utilisé par le service my-claw-whisper ; sans lui ce service crash-loope)
pip install --user faster-whisper
```

> ⚠️ `jq` est un piège classique : `auto-update.sh` fait `command -v jq || exit 1`.
> Sans jq, aucune mise à jour automatique, aucune erreur visible sauf en journal.

---

## 4. Ports

| Port | Service | Exposition conseillée |
|---|---|---|
| **8080** | my-claw (HTTP + WebSocket + bundle web) | public derrière TLS, ou VPN |
| 8000 | whisper STT | loopback (127.0.0.1) |
| 9222 | Chromium CDP | loopback |
| 9223 | sidecar (Node) | loopback |
| 5900 / 6080 | x11vnc / noVNC | loopback ou réseau contrôlé |
| 8888 | **SearXNG** (déployé par vous, voir §9) | loopback ou public |

**Sécurité :** ne jamais exposer 9222/9223/5900/6080 sur Internet (CDP et VNC sans auth).
Pour 8080 : soit VPN, soit reverse proxy TLS (voir §7.3).

---

## 5. Le token Forgejo (nécessaire pour installer et mettre à jour)

Le tarball et le bundle web vivent dans un dépôt **privé** (`git.kssimi.fr`). Un token est requis :

1. Ouvrir `<forgejo-url>/user/settings/applications`, créer un token avec le scope **`write:repository`**.
2. Le conserver. Il servira à l'installation ET sera stocké dans `/etc/my-claw/.env` pour les updates.

Aucune autre clé n'est **strictement obligatoire** à l'installation :
- clé LLM (voir §7.2) : nécessaire pour que l'agent réponde ;
- `GROQ_API_KEY` (voix cloud), `GEOAPIFY_API_KEY` (localisation) : optionnelles.

---

## 6. Installation

### 6.1 One-liner (recommandé)

```bash
FORGEJO_TOKEN=ton_token bash -c '
  curl -fsSL https://git.kssimi.fr/claw/my-claw/raw/main/packaging/install-remote.sh | bash'
```

Équivalent pas à pas (si on veut épingler une version) :

```bash
export FORGEJO_TOKEN=ton_token
export FORGEJO_USER=ton_utilisateur_forgejo   # défaut: neras
bash install-remote.sh                # OU: bash install-remote.sh 0.4.71 pour épingler
```

Si le repo forgejo n'est pas `git.kssimi.fr` (fork, autre instance) :

```bash
FORGEJO_URL=https://mon.forgejo.fr FORGEJO_TOKEN=... bash install-remote.sh
```

### 6.2 Ce que fait l'installer

Root ne fait que la partie système, une fois ; tout le reste appartient à l'utilisateur de
service et tourne sous **son** systemd (`systemctl --user`). Voir `docs/install-layout.md`.

- Paquets manquants (`ffmpeg`, `chromium`, `Xvfb`, `x11vnc`, `websockify`, `jq`, `dbus-user-session`).
- `/opt/my-claw/` (à l'utilisateur) : `releases/<version>/`, `current` → la release live,
  `.install-meta`. `/var/log/my-claw/` (à l'utilisateur).
- `~/.my-claw/` : `config.json`, `.env` (secrets, 600), puis sessions, web, workspace, logs d'app.
- `loginctl enable-linger <user>` : le manager de l'utilisateur démarre au boot sans session.
- `/usr/local/bin/myclaw` : un stub root qui redescend vers l'utilisateur avant d'exécuter quoi
  que ce soit de l'arbre (`sudo myclaw ...` marche par habitude, sans jamais exécuter de fichier
  utilisateur en root).
- Puis, **en tant que l'utilisateur** : unités rendues depuis `units/` dans
  `~/.config/systemd/user/`, `enable`, démarrage, health gate, bundle web si le token est là.
- Désactivation (best-effort) de services user conflictuels (`xvfb`, `x11vnc`, `novnc`, `chromium-cdp`).

### 6.3 Vérification

```bash
myclaw status                                      # active (running), en tant que l'utilisateur
ss -tlnp | grep 8080                               # LISTEN *:8080 bun
readlink /opt/my-claw/current && grep -m1 '"version"' /opt/my-claw/current/package.json
```

---

## 7. Configuration

Le serveur lit **`~/.my-claw/config.json`** (config de l'app) et les secrets dans
**`~/.my-claw/.env`**. Les deux sont créés par l'installer à partir des templates, et **relus à
chaud** : éditer `.env` ou `config.json` ne demande pas de redémarrage.

### 7.1 Le fichier `.env`

```bash
vim ~/.my-claw/.env     # en tant que l'utilisateur de service ; chmod 600 est déjà fait
```

Valeurs minimales pour démarrer + rester à jour :

```dotenv
# LLM : la clé du provider que vous allez utiliser (voir §7.2). Exemple :
LITELLM_API_KEY=...          # OU OPENROUTER_API_KEY / GROQ_API_KEY / COMMANDCODE_KEY / OPENCODE_GO_KEY
# Updates :
FORGEJO_URL=https://git.kssimi.fr
FORGEJO_TOKEN=ton_token_forgejo
```

Optionnel : `GROQ_API_KEY` (STT cloud), `GEOAPIFY_API_KEY` (localisation),
`CLAUDE_CODE_OAUTH_TOKEN` (backend Claude abonnement), `MY_CLAW_WEB_SEARCH_TOKEN` (SearXNG protégé).

Le daemon, `myclaw` et l'updater lisent tous le même fichier, `~/.my-claw/.env`. Une install
plus ancienne avait un second exemplaire dans `/etc/my-claw/.env` : sa migration l'a fusionné ici
et a laissé la copie root dans `/etc/my-claw.migrated/` (à supprimer quand vous êtes sûr).

### 7.2 Choisir un modèle LLM — depuis l'app (recommandé) ou à la main

Le template part sans provider (`llm.providers: {}`, `defaultProvider: ""`) : rien n'est imposé.

**Depuis l'app (zéro édition manuelle) :** Settings → Providers → ajouter :
- type `openai`, `baseUrl` de votre fournisseur, `apiKeyEnv` = nom de la variable d'env
  (ex. `LITELLM_API_KEY`), `discover: true` (le picker liste les modèles), `group` optionnel ;
- mettre la clé dans `.env` (Settings → Providers → env) ;
- puis Settings → Model → choisir le modèle par défaut.

**À la main** (équivalent) :

```json
"llm": {
  "defaultProvider": "monprovider",
  "defaultModel": "monprovider/qwen-...",
  "providers": {
    "monprovider": {
      "type": "openai",
      "baseUrl": "https://mon-gateway/v1",
      "apiKeyEnv": "MA_CLE_ENV",
      "discover": true
    }
  },
  "models": []
}
```

> Sans provider configuré, le serveur **démarre** mais le premier message échoue avec
> « Provider not found in config » (visible dans l'app). C'est le comportement voulu :
> le setup LLM se fait à l'écran, jamais imposé par un vendor par défaut.

### 7.3 Reverse proxy TLS (recommandé si exposition publique)

La config du channel est déjà prête pour ça (`web.enabled: true`), il faut déclarer le proxy :

```json
"channels": {
  "my-claw-app": {
    "enabled": true,
    "port": 8080,
    "pairing": { "enabled": true },
    "web": {
      "enabled": true,
      "trustedProxies": ["127.0.0.1", "10.0.0.0/8"]
    }
  }
}
```

`trustedProxies` = adresses IP du reverse proxy. Sans lui :
- `x-forwarded-host`/`x-forwarded-proto` sont ignorés → le claim link du pairing généré par
  `myclaw device add` pointe vers l'IP:8080 au lieu du domaine public, et le cookie
  `Secure` n'est pas posé derrière TLS.

Exemple nginx :

```nginx
server {
  listen 443 ssl;
  server_name claw.exemple.fr;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### 7.4 Les fichiers d'instructions (le cerveau de l'agent)

C'est LE point de personnalisation : **qui est l'agent, comment il communique, ce qu'il sait de vous.
Tout est dans des fichiers Markdown dans le workspace.**

**Au premier démarrage**, le serveur crée `~/.my-claw/workspace/` et y copie les templates
(shippés dans le tarball, `docs/prompt/`) si les fichiers n'existent pas déjà :

| Fichier | Rôle | Lu par le moteur ? |
|---|---|---|
| **`CORE.md`** | Directives de base : sûreté, règles non négociables | ✅ toujours (fallback hardcodé si absent) |
| **`SOUL.md`** | Personnalité, ton, style de communication | ✅ |
| **`AGENTS.md`** | Règles de développement / conventions du workspace | ✅ |
| **`USER.md`** | Ce que le serveur sait de vous (à remplir !) | ✅ |
| `SYSTEM.md` | Réflexions système, pour vous | ❌ (non lu, simple note) |
| `MEMORY.md` | Vue exportée de la mémoire longue durée | ❌ lu par la mémoire, pas en prompt |

**Que faire au setup** (5 minutes) :

```bash
cd ~/.my-claw/workspace
# Adapter au moins USER.md (qui vous êtes, timezone, contexte) et SOUL.md (ton voulu).
# AGENTS.md : règles de codage / conventions du projet si vous développez dedans.
```

> ⚠️ **C'est réversible mais pas automatique** : les templates ne sont copiés QUE si le
> fichier n'existe pas. Supprimer `SOUL.md` ne le recrée pas (le layer tombe silencieusement,
> le moteur garde le dernier contenu connu) — gardez une sauvegarde ou récupérez le template
> depuis `docs/prompt/` dans le tarball.

**Hot-reload** : le serveur relit les 4 fichiers à chaque message (cache par mtime).
Aucun redémarrage : éditez, envoyez un message, c'est actif.

**Depuis l'app** : Settings → Instructions → éditer chaque fichier (le même ladder de
résolution est utilisé, donc ce que vous voyez est ce que le moteur lit).

**Workspace et héritage** :
- `config.workspace` : le dossier de travail (défaut `~/.my-claw/workspace`).
- `config.workspaces` : workspaces nommés supplémentaires (ex. `"dev": "/home/user/dev"`).
- `config.workspacePrompts` : par workspace, par fichier, d'où vient le contenu
  (`off` = couper le layer, `inherit: "default"` = suivre le workspace par défaut,
  `"builtin"` = template). Un workspace sans fichier hérite du default, qui hérite du template.

Exemple :

```json
"workspace": "/home/user/dev",
"workspaces": { "default": "/home/user/.my-claw/workspace" },
"workspacePrompts": {
  "default": { "SOUL.md": { "inherit": "builtin" } }
}
```

> **`MEMORY.md`** est un fichier auto-généré (vue de `memory.db`) : ne l'éditez pas à la main
> pour le supprimer — les entrées sont gérées par l'outil mémoire. Il est recréé à chaque boot.

---

## 8. Le client web (bundle)

Le serveur ne porte **pas** le client web : il l'installe. Depuis le forge privé (token requis) :

```bash
myclaw web install latest        # ⚠️ n'existe PAS : il faut une version précise
```

```bash
myclaw web install 0.5.53       # la version voulue (le plus récent des tags my-claw-app)
myclaw web ls                    # versions installées + laquelle est current
myclaw web use <version>         # rollback instantané (symlink)
myclaw web rm <version>          # purge (jamais la version derrière current)
```

> **Quelle version ?** `myclaw web ls` puis ouvrir la release la plus récente de
> `claw/my-claw-app` sur le forge (ou faire confiance à l'auto-update : le timer installe le
> bundle **derrière** le serveur à jour — c'est la seule voie `latest` réellement disponible).

Vérification : `curl -fsS http://127.0.0.1:8080/ | head -5` doit renvoyer du HTML
(une 302 → `/pair` est normale tant qu'aucun device n'est pairé ; sinon c'est le bundle).

---

## 9. SearXNG (recherche web) — service externe à déployer

Le serveur parle à une instance SearXNG (JSON). Elle n'est **pas** fournie par le paquet :
vous la déployez (Docker recommandé), puis vous renseignez `webSearch.baseUrl`.

**Déploiement** (adapté de `~/dev/searxng/container/docker-compose.yml`) :

```bash
mkdir -p ~/searxng && cd ~/searxng
cat > docker-compose.yml <<'YAML'
name: searxng
services:
  core:
    image: docker.io/searxng/searxng:latest
    restart: always
    ports:
      - "8888:8080"            # ⚠️ PAS 8080 : conflit avec my-claw
    volumes:
      - ./settings.yml:/etc/searxng/settings.yml:ro
  valkey:
    image: docker.io/valkey/valkey:9-alpine
    command: valkey-server --save 30 1 --loglevel warning
    restart: always
YAML
docker compose up -d
```

`settings.yml` minimal (doit autoriser le format JSON) :

```yaml
server:
  port: 8080
  bind_address: 0.0.0.0
search:
  formats: [html, json]     # sans "json" : le tool web_search reçoit du HTML → invalid JSON
```

**Vérification :**

```bash
curl -fsS "http://127.0.0.1:8888/search?q=test&format=json" | head -c 200
# → {"query":"test","results":[...]}
```

**Config my-claw** (hot-reload : pas besoin de redémarrer) :

```json
"webSearch": {
  "baseUrl": "http://127.0.0.1:8888",
  "language": "fr"
}
```

- Derrière un domaine : `baseUrl: "https://search.exemple.fr"` + éventuellement
  `MY_CLAW_WEB_SEARCH_TOKEN` dans `.env` (Bearer) si l'instance est protégée.
- Le tool est **enregistré** seulement si `baseUrl` est non vide. `baseUrl: ""` = pas de tool.
- Piper connu : si SearXNG est sur la même machine et que vous laissez le compose sur `8080`,
  `my-claw` ne démarre pas (EADDRINUSE). D'où le `8888` ci-dessus.

---

## 10. Pairing des clients — flow unifié

Un seul mot d'ordre, quel que soit le client : **le serveur m'int, le client réclame, le serveur délivre.**

### 10.1 Client web

```bash
myclaw device add --name "Bureau" --kind web --owner ton_owner
```

Sortie (à copier telle quelle) :

```
Device  web-a3f19c22  "Bureau"  owner=ton_owner
Token   ...
Claim   http://<host>/pair#K7QW-3M2P        (valid 10 min, single use)
        or type K7QW-3M2P in the pairing page
```

Ouvrir l'URL `Claim` dans le navigateur → la page s'échange le grant contre un cookie →
rechargé → le chat apparaît. **Pas de device pré-existant requis** (chemin bootstrap).

Pour les clients web suivants : ouvrir `/pair` depuis le navigateur, scanner le QR depuis
l'app (Settings → Devices → Scan) ou taper le code. L'app affiche les 3 chiffres de
vérification + l'origine + IP avant d'approuver (anti-phishing).

### 10.2 Client Android (app)

```bash
myclaw device add --name "Phone" --kind app --owner ton_owner
```

1. Installer l'APK (release `my-claw-app-v0.5.53.apk` du forge).
2. Ouvrir l'app. Si elle ne trouve pas de credential côté serveur, **l'écran de pairing
   s'ouvre tout seul** (détection du 401). Sinon : Settings → General → **Pair**.
3. Saisir l'URL du serveur : `ws://<ip>:8080/my-claw-app` (ou `wss://<domaine>/my-claw-app`).
4. **Taper le code** affiché par `device add` (ex. `K7QW-3M2P`).
5. L'app reçoit le token minté, le stocke dans le Keystore et se reconnecte. Terminé.

**Le scan QR** : le CLI n'imprime pas de QR. Pour scanner, générez-le vous-même depuis
le claim link (si `qrencode` est installé) :

```bash
qrencode -t ANSIUTF8 "http://<host>/pair#K7QW-3M2P"
```

Puis appuyez sur **Scan the code** dans l'app. (Le QR affiché par la page `/pair` d'un
navigateur sert, lui, à approuver un **device web** depuis un device déjà pairé — pas à
inscrire ce device.)

Avant v0.5.53 : il fallait copier `device` + `token` depuis l'app vers `config.json`.
Plus maintenant.

### 10.3 Vérification

```bash
myclaw device ls
# → web-a3f19c22  web  owner=...  "Bureau"  last seen ...
myclaw device rm <deviceId>       # révoquer
myclaw device disable <deviceId>  # fermer la porte sans supprimer
```

---

## 11. Voix et localisation (optionnels)

| Feature | Clé / dépendance | En .env |
|---|---|---|
| STT cloud | `GROQ_API_KEY` | `GROQ_API_KEY=...` |
| STT locale | `faster-whisper` (pip) + service `my-claw-whisper` | — |
| TTS cloud | `edge-tts` (pip global : `pip install edge-tts`) | — |
| TTS locale | binaire `piper` + modèle | — |
| Localisation | `GEOAPIFY_API_KEY` (reverse geocoding) | `GEOAPIFY_API_KEY=...` |

`voice.mode` = `auto` | `cloud` | `local`. Le template part sur `auto` : cloud si clé présente,
sinon local. Si aucun backend n'est disponible, la fonctionnalité est simplement absente
(pas de crash). `GEOAPIFY_API_KEY` sans `.trim()` non vide ⇒ partage de localisation désactivé.

---

## 12. Mises à jour

```bash
myclaw update                   # dernier release serveur + bundle web (si "latest"), sans sudo
myclaw update 0.6.1             # épingler une version (pas de bundle)
myclaw update --file my-claw-0.6.1-linux-x64.tar.gz   # depuis un tarball local
```

Tout se passe sous l'utilisateur de service : téléchargement, vérification, staging complet,
arrêt, bascule du lien `current`, rendu des unités depuis la release, démarrage, health gate. Un
échec après la bascule rebascule sur `prev` et redémarre. Détails : `docs/install-layout.md`.

**Auto-update** : timer systemd toutes les 15 min. Il vérifie le registry, et **ne touche jamais
une run en cours** (health gate : `GET /health` répond `activeRun` ; si `true`, il temporise).
Une fois le serveur à jour, il installe le bundle web (règle : le bundle ne devance jamais le serveur).

**Rollback** : `/opt/my-claw/prev` pointe sur la release précédente jusqu'au prochain `update`.
Le plus simple : `myclaw update <version précédente>`. Hors ligne : `systemctl --user stop my-claw`,
repointer `current` sur la cible de `prev` (`ln -sfn`), `systemctl --user start my-claw`.
Pour le bundle : `myclaw web use <version>`.

---

## 13. Guide complet de vérification post-install

```bash
# 1. Services (en tant que l'utilisateur de service)
systemctl --user is-active my-claw my-claw-xvfb my-claw-chromium   # → active active active
systemctl --user is-active my-claw-browser-sidecar                 # active si Node installé
systemctl --user list-timers my-claw-auto-update.timer --no-pager  # next run dans < 15 min

# 2. Ports
ss -tlnp | grep -E '8080|9222|9223|8000'

# 3. Santé (device authentifié)
curl -fsS "http://127.0.0.1:8080/health?device=<id>&token=<token>"   # → {"activeRun":false}

# 4. Web
curl -fsS http://127.0.0.1:8080/ | grep -q "<html" && echo "bundle OK"
curl -fsS "http://127.0.0.1:8888/search?q=test&format=json" | head -c 80

# 5. Logs (boot propre)
tail -50 /var/log/my-claw/my-claw.log                   # ou: myclaw logs
journalctl --user -u my-claw --since "5 min ago" --no-pager | tail -20
tail -f ~/.my-claw/logs/my-claw-app-$(date +%F).log
```

**Test fonctionnel final :** envoyer un message depuis l'app ou le web. Le serveur doit
streamer la réponse et afficher les cartes d'outils.

---

## 14. Dépannage

| Symptôme | Cause probable | Fix |
|---|---|---|
| `my-claw.service` ne démarre pas | Port 8080 pris (SearXNG mal configuré, autre service) | `ss -tlnp | grep 8080`, libérer ou changer `channels.my-claw-app.port` (reboot-only) |
| `my-claw-whisper` crash-loop | `faster-whisper` pas installé | `pip install faster-whisper` ou `systemctl --user disable --now my-claw-whisper` |
| Auto-update ne fait rien | `jq` absent, ou `FORGEJO_TOKEN` manquant/dépassé | `apt install jq`, vérifier `~/.my-claw/.env` |
| `systemctl --user` : « Failed to connect to bus » | Shell sans session (ssh sans login, `su`) | `export XDG_RUNTIME_DIR=/run/user/$(id -u)` ; `myclaw` le fait tout seul |
| Rien ne démarre après un reboot | Linger désactivé | `sudo loginctl enable-linger <user>` |
| `myclaw web install` → 404 | Token Forgejo absent ou dépôt privé | `FORGEJO_TOKEN` dans `.env` (le token ne va qu'au forge) |
| Première page = « Unauthorized » | Normal : aucun device pairé | Ouvrir l'URL Claim de `myclaw device add` |
| L'app affiche « Pair device » à l'ouverture | Device inconnu du serveur (401) | C'est le nouveau flow : scanner le code |
| `web_search` répond « not configured » | `webSearch.baseUrl` vide | Renseigner l'URL SearXNG (§9) |
| `web_search` répond « invalid JSON » | `formats: [html]` sans `json` | `search.formats: [html, json]` |
| noVNC ne se connecte pas | x11vnc squatté sur 5900 | `systemctl --user restart my-claw-vnc my-claw-novnc` |
| Le claim link pointe vers IP:8080 au lieu du domaine | `trustedProxies` non déclaré | Ajouter l'IP du proxy dans `web.trustedProxies` |
| Message → « Provider not found » | Aucun LLM configuré | Settings → Providers (§7.2) |
| Run interrompue pendant update | Health gate : ne jamais upgrader pendant une run | Attendre ; le timer retente dans 15 min |
| Beaucoup de RAM/CPU qu'à froid | Embeddings locaux + Chromium | Prévoir 8 Go ; embeddings téléchargés au 1er usage |

---

## 15. Désinstallation

```bash
sudo /opt/my-claw/current/packaging/uninstall.sh
```

Retire `/opt/my-claw`, les unités (user et, s'il en reste, système), la CLI, `/var/log/my-claw`,
`/etc/my-claw*`. **Ne supprime pas** `~/.my-claw` (sessions, config, secrets) ni le linger de
l'utilisateur : effacez-les à la main si vous voulez tout remettre à zéro.
