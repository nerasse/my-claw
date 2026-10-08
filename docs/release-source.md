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

## Clients (lot 2, not done yet)

`install-remote.sh`, `update.sh`, `auto-update.sh`, the app-update relay
(`src/channels/my-claw-app/updates.ts`), `myclaw web` and the compose entrypoint read the two
variables. `myclaw release-key <key>` writes both lines. `FORGEJO_USER:-neras` goes away.

Transition: three installs of collaborators read Forgejo directly with their own `FORGEJO_TOKEN`.
Until each has a key, an install with no `MY_CLAW_RELEASE_URL` keeps that direct path. It is a
deliberate, temporary exception to "no backward-compatibility shims", removed by the first release
after the hub shows every install on a key.

## The registry follows the `claw` account's visibility

Measured 2026-10-08: Forgejo derives a package's visibility from its owner, not from the private
repository. While `claw` was public, `/api/v1/packages/claw` answered 200 anonymously and the
tarball downloaded in full. `claw` is now *limited* (anonymous: 403/401; any signed-in Forgejo
account can still read it). It goes *private* once the three installs are on keys, which also
cuts the collaborators' direct path.
