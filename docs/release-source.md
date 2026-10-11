# Release source

Decided 2026-10-07/08. Nothing about my-claw is public: the server tarball carries `src/` and an
image carries the code, so publishing either is publishing the code. The people who run my-claw
still install and update it without an account on git.kssimi.fr: they go through **dl-hub**
(`claw/dl-hub`, deployed at `https://dl.kssimi.fr`), a private download point in front of the
Forgejo releases, with one key per machine. The hub, its keys, its admin dashboard and its
deployment are documented in that repository's README; this page is the my-claw side.

## What a client reads

One base URL and one optional key, `~/.my-claw/.env`:

```
MY_CLAW_RELEASE_URL=https://dl.kssimi.fr/my-claw
MY_CLAW_RELEASE_KEY=dlh_...
```

| Path under the base | Content |
|---|---|
| `server/latest.json` | `{version, files: [{name, size}]}` of the newest server release |
| `server/<v>/my-claw-<v>-linux-x64.tar.gz` | the tarball |
| `app/latest.json` | `{version, publishedAt, files}`: the APK and, when present, the web bundle |
| `app/<v>/my-claw-app-v<v>.apk`, `app/<v>/dist-web.tar.gz` | the files |
| `install.sh` | the installer, at the newest server tag |

The key travels as `Authorization: Bearer <key>`, never in a URL. Files answer `Range` and `HEAD`.
Moving to a public source one day means serving these same paths from any static host and dropping
the key: the clients change their URL and nothing else.

The my-claw product in dl-hub: `server` reads the generic package registry (`claw/my-claw`), `app`
the release assets of `claw/my-claw-app`; collaborators of `claw/my-claw` make their own keys, and
the owner gives keys to anyone else.

## Clients

| Client | Reads | Where |
|---|---|---|
| `install-remote.sh` (served as `install.sh` by the hub) | `DL_HUB_URL`/`DL_HUB_KEY`, written in by the hub from the request; `--key`, `--url` or the two variables win | writes both into `.env` through `install.sh` |
| `myclaw update`, the 15-minute timer, the compose entrypoint | `.env` | `packaging/release-source.sh`, sourced |
| the app-update relay, `myclaw web install` | `process.env` (`.env` is hot-reloaded) | `src/channels/my-claw-app/release-source.ts` |

`myclaw release-key <key> [--url <url>]` tries the key on `<url>/server/latest.json` and only then
writes both lines (default URL `https://dl.kssimi.fr/my-claw`; without `<key>`, it is read from
stdin). The server picks them up at once; the shell updaters on their next run.

The credential never reaches a command line in the shell helpers: curl reads its header from a
config on stdin (`curl -K -`), so `ps` does not show it. The TypeScript side sends it only to the
source's own origin.

The one-line install is `curl -fsSL -H "Authorization: Bearer <key>" https://dl.kssimi.fr/my-claw/install.sh | sudo bash`:
the hub writes the source and that key into the script it serves, so nothing else is typed.

Transition, with nobody doing anything: the installs of collaborators (and the owner's) read
Forgejo directly with the `FORGEJO_TOKEN` they already hold (the helpers' `forge` kind). From this
release on, the timer and `myclaw update` trade it once for a key (`release_migrate`): a POST to
`<hub>/key/exchange` with that token, which dl-hub checks with Forgejo and never keeps. The key and
source are written into `.env` (600, every other line kept, `FORGEJO_TOKEN` left for the skills
that use it) and take over at once. Only an install whose `FORGEJO_URL` is the forge the hub fronts
(`https://git.kssimi.fr`) ever sends its token there; a refusal leaves the install as it was, and
the next tick asks again. `MY_CLAW_HUB_URL` and `MY_CLAW_HUB_FORGE` in the environment override the
pair, for the tests. The forge kind is a deliberate, temporary exception to "no
backward-compatibility shims", removed once dl-hub's dashboard shows every install on a key.

## The registry follows the `claw` account's visibility

Measured 2026-10-08: Forgejo derives a package's visibility from its owner, not from the private
repository. While `claw` was public, `/api/v1/packages/claw` answered 200 anonymously and the
tarball downloaded in full. `claw` is now *limited* (anonymous: 403/401; any signed-in Forgejo
account can still read it). It goes *private* once the three installs are on keys, which also
cuts the collaborators' direct path.
