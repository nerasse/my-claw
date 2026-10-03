# Services: cloud by default, self-hosted or a URL

Decided with the owner on 2026-10-03. Installs: bare metal (systemd user units) and compose, both
kept. Images are built locally from the repo for now; published images are phase 2.

## Rule

The server reads URLs and keys. How a service is hosted never reaches the code that calls it.
Every optional service has one of four sources, derived from the config, never stored:

| Source | Meaning |
| --- | --- |
| `off` | not configured, the feature is absent |
| `cloud` | a hosted provider, a key in `.env` |
| `self-hosted` | an engine this install runs: a unit the server starts (bare metal) or a compose service (compose) |
| `url` | an engine the owner runs elsewhere, at a URL in the config |

**The default is always cloud**, or off when there is no cloud for it.

| Service | Default | Cloud | Self-hosted | URL key |
| --- | --- | --- | --- | --- |
| Speech-to-text | cloud | Groq (`GROQ_API_KEY`) | Whisper: unit `my-claw-whisper`, compose `whisper` | `voice.stt.url` |
| Text-to-speech | cloud | Edge (no key) | Piper: binary (bare metal), compose `piper` | `voice.tts.url` |
| Embeddings | off | OpenAI-compatible `/embeddings` + key | in-process model (`backend: "local"`) | `memory.embedding.baseUrl` |
| Web search | off | none (SearXNG only) | compose `searxng` | `webSearch.baseUrl` |
| Browser | self-hosted | none | units, compose `browser` | `browser.sidecarUrl` |

Local voice and local embeddings are independent: each is switched on alone, each downloads only
its own dependencies, and only when switched on.

## Where a self-hosted engine is

The install says what it is: `MY_CLAW_INSTALL=native` in the server's unit, `compose` in the image.
A self-hosted engine without a URL in the config is at the install's address for it:

| Engine | Bare metal | Compose |
| --- | --- | --- |
| Whisper | `http://127.0.0.1:8000` | `http://whisper:8000` |
| Piper | the `piper` binary | `http://piper:5000` |

On bare metal the server starts and stops the units it needs (`docs/on-demand-services.md`). In
compose it cannot: the server has no Docker socket, which would be root on the host for an agent with
a shell. The owner enables the compose profile; the server only checks the URL answers.

A URL in the config always wins, and then nothing is started on this machine.

## The catalogue

`src/services/catalog.ts` derives each service's state from the config and the environment:
`{ id, source, endpoint?, missing[] }`, where `missing` names what the chosen source still needs
(a key, a URL). `probeService` asks the endpoint once: any HTTP answer is up, a refused connection is
down. The setup assistant and the Services page read this, nothing else.

## The Services page

`services.get` answers `services.result`: the install kind and, per service, its source, the
sources this install can switch it to (`choicesOf`: self-hosted search only in compose), its
endpoint, what it still needs, and one probe. `.env` is re-read first (`refreshEnvFile`), so a key
just pasted on the page is not reported missing.

`services.set { id, source, url?, model?, keyEnv? }` writes the choice into `config.json`
(`applyServiceChoice`, one patch per service, `setService` for the file: snapshot, atomic write) and
answers every window with the state of the file as written. It never touches the live config: the
watcher applies the file, and its appliers are what re-register `web_search` and reload memory. A
live copy patched first would leave the watcher no difference to apply. Keys are not part of a
choice; the page sends them with `providers.env.set`.

| Choice | Written |
| --- | --- |
| stt / tts `cloud` | `voice.<f>.mode = "cloud"`, `url` removed |
| stt / tts `self-hosted` | `mode = "local"`, `url` removed |
| stt / tts `url` | `mode = "local"`, `url` |
| embeddings `off` | `memory.embedding` removed |
| embeddings `cloud` | `backend: "http"`, OpenAI by default (`text-embedding-3-small`, `OPENAI_API_KEY`) |
| embeddings `self-hosted` | `backend: "local"`, `Xenova/all-MiniLM-L6-v2` (downloaded on first use) |
| embeddings `url` | `backend: "http"`, the URL, no key |
| search `off` / `url` / `self-hosted` | `webSearch.baseUrl` = `""` / the URL / `http://searxng:8080` |
| browser `off` / `self-hosted` / `url` | `browser.enabled`, and `sidecarUrl` for a URL |
