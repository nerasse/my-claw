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
