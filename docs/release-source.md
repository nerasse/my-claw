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

The key never reaches a command line in the shell helpers: curl reads its header from a config on
stdin (`curl -K -`), so `ps` does not show it. The TypeScript side sends it only to the source's
own origin.

### How the existing installs moved over (0.7.103 to 0.7.105)

0.7.103 and 0.7.104 kept a temporary second source, the forge itself with the `FORGEJO_TOKEN` an
install already held, and traded that token once for a key (dl-hub's `/key/exchange`) on the
timer's next tick. The owner's VM and the collaborator who had a token moved over on their own;
the two installs that never had a token (manual updates) get a key and the one-line install, which
updates an old install in place (`tests-install/no-token.sh`). With nobody left on the forge,
0.7.105 removed that source and the trade: a forge token alone is no source any more, and an
install without a key is told to run `myclaw release-key <key>`. dl-hub keeps `/key/exchange`, it
is generic and harmless.

## The registry follows the `claw` account's visibility

Measured 2026-10-08: Forgejo derives a package's visibility from its owner, not from the private
repository. While `claw` was public, `/api/v1/packages/claw` answered 200 anonymously and the
tarball downloaded in full. `claw` is now *limited* (anonymous: 403/401; any signed-in Forgejo
account can still read it). With every install on dl-hub, it can go *private*: dl-hub reads with
`claw`'s own tokens, and no install reads the forge any more.
