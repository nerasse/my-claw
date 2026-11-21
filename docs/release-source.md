# Release source

Decided 2026-10-07/08, moved to GitHub 2026-11-21. Both repositories are public, so the tarball,
the APK and the web bundle need no key, no account and no API: a client reads the newest tag off
`/releases/latest` and builds the asset URL from it.

## What a client reads

One URL, `~/.my-claw/.env`:

```
MY_CLAW_RELEASE_URL=https://github.com/nerasse/my-claw
```

| What | Where |
|---|---|
| newest server tag | the `302` from `<url>/releases/latest`; `Location` ends in `/tag/v<version>` |
| tarball | `<url>/releases/download/v<v>/my-claw-<v>-linux-x64.tar.gz` |
| node clients | `<url>/releases/download/v<v>/my-claw-node-<v>-<target>[.exe]` |
| app APK | `<app>/releases/download/v<v>/my-claw-app-v<v>.apk` |
| web bundle | `<app>/releases/download/v<v>/dist-web.tar.gz` |

The app repository is the server one with `-app` appended (`nerasse/my-claw` gives
`nerasse/my-claw-app`). `MY_CLAW_APP_RELEASE_URL` overrides it when a fork split them.

No token and no rate limit: the redirect is plain HTML, and the assets are served by the release
CDN. `HEAD` answers with `Content-Length`, which is what the updater sizes its temp space with.

## The old hub is the same source

`https://dl.kssimi.fr/my-claw` maps to the GitHub repository in the client, so an install that
still carries it in `.env` starts reading GitHub on its next check. The key line is ignored, and
`myclaw release-key` removes it. dl-hub is retired once every install has passed through a release
that carries this mapping.

## A key is still possible

Anything that is not a GitHub repository keeps the neutral layout a self-hosted hub serves:
`<url>/server/latest.json`, `<url>/server/<v>/<file>`, `<url>/app/latest.json`,
`<url>/app/<v>/<file>`. That layout takes an optional `MY_CLAW_RELEASE_KEY`, sent as
`Authorization: Bearer`, never in a URL, and only to the source's own origin. GitHub never
receives it.

## Clients

| Client | Reads | Where |
|---|---|---|
| `install-remote.sh` | `MY_CLAW_RELEASE_URL`/`MY_CLAW_RELEASE_KEY`, `--url`, `--key` | writes them into `.env` through `install.sh` |
| `myclaw update`, the 15-minute timer, the compose entrypoint | `.env` | `packaging/release-source.sh`, sourced |
| the app-update relay, `myclaw web install`, node downloads | `process.env` (`.env` is hot-reloaded) | `src/core/release-source.ts`, `src/channels/my-claw-app/release-source.ts` |

`myclaw release-key --url <url>` checks the source before writing anything: a GitHub repository
must answer its `/releases/latest` redirect, a layout must answer `<url>/server/latest.json` with
the key. With no `--url`, it sets the GitHub repository and drops any key line, because that source
needs none.

The key never reaches a command line in the shell helpers: curl reads its header from a config on
stdin (`curl -K -`), so `ps` does not show it.

## History

Two things explain what the code still carries. Until 2026-11-21 the product lived behind dl-hub
because nothing was public: 0.7.103 and 0.7.104 moved the installs that held a Forgejo token over
to a hub key through `/key/exchange`, and 0.7.105 removed that path. The measurement behind the
hub, kept because it is why the layout never trusted repository visibility: Forgejo derives a
package's visibility from its owner's account, not from the private repository, so `claw` had to be
limited before the registry stopped answering anonymously.
