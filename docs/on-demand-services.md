# On-demand services

## Why

Every update used to enable and start every unit it shipped. `my-claw-whisper` (local
speech-to-text) therefore ran on every install, whatever the config said:

- on the owner's box, 549 MB of RAM for weeks while speech-to-text was in the cloud;
- on a box without `faster-whisper`, a restart loop (`Restart=always`).

A light VM has better uses for that memory (the browser). Local engines are off by default, and run
only once they are asked for.

## Rule

A unit is **on demand** when a feature of the config needs it. The installed server starts it while
the config needs it and stops it otherwise. Nothing is stored: whether a unit is needed is derived
from the same config that decides which engine answers.

| Unit | Needed while | Serves |
| --- | --- | --- |
| `my-claw-whisper.service` | speech-to-text resolves to `local` (`VoiceManager.resolveMode("stt")`) | local speech-to-text |

The table is `ON_DEMAND_UNITS` in `src/services/on-demand.ts`: one entry per unit, no condition
elsewhere.

`resolveMode("stt")` is the engine choice itself: `voice.stt.mode`, then `voice.mode`, then `auto`
(cloud with a `GROQ_API_KEY`, local without). So:

- a fresh install (the template says `voice.stt.mode: "cloud"`) runs no Whisper;
- an older install on `auto` without a Groq key keeps the local engine it was using;
- switching speech-to-text to local in the app starts it, back to cloud stops it;
- on `auto`, adding a Groq key to `.env` stops it.

## Who does what

- **Release scripts** render on-demand units with the others and never enable or start them
  (`ON_DEMAND_UNITS` in `packaging/update.sh`; absent from `START_ORDER` there and in
  `scripts/myclaw.sh`, and from the dev scripts' `DEPS`). They still stop them with the rest, so a
  code change reaches them; the server starts them again at boot if they are still needed.
- **The server** reconciles at boot, on every config reload, on a bare `.env` edit (the watcher
  emits `env:refreshed` when no section changed) and when the app sets the voice mode. A pass reads
  `is-enabled` and `is-active` and acts only on a mismatch: `enable --now` or `disable --now`.
  `enable`, so a reboot brings a needed unit back before the server's first pass.
- A unit restarting after a crash (`activating`) counts as up: restarting it again would only reset
  its back-off. A unit that is not installed is skipped.
- Passes are queued, one at a time: a reload and an app toggle never race an `enable` against a
  `disable`.
- Only the installed server manages units. Its unit sets `MY_CLAW_MANAGES_UNITS=1`; a dev server on
  the same box reads the same config and must not touch the units the installed one runs on.

## Errors that say what to do

Nothing falls back silently to an engine that is not running:

- cloud without a key: `GROQ_API_KEY not set: add a Groq key to .env (Settings > Providers > env),
  or switch speech-to-text to local`;
- local while Whisper does not answer: `local Whisper is not answering at <endpoint>
  (my-claw-whisper)`, which is a unit still starting, or a missing `faster-whisper` package.

## The old `.env` template

It carried placeholder values (`GROQ_API_KEY=your_groq_key_here`) that the installer copied as the
live `.env`. Set but fake, a key reads as present: voice went to Groq with it, a provider answered 401.
The template now leaves every key commented, and the loader skips a value shaped
`your_<name>_here`, so an install made from the old template reads those keys as absent without
anyone editing its secrets.

## Next

This table is the seed of the feature catalogue (docs to come with the setup assistant): local voice
and local embeddings each enabled on their own, each downloading its dependencies only when enabled.
