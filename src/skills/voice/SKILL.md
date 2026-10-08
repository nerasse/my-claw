---
name: voice
description: Manage cloud/local voice mode for STT and TTS, integrated into the orchestrator.
---

# Voice Skill

## Automatic STT (inbound)

Voice notes are transcribed automatically before agent processing.
The transcript is sent as a visible message to the user; no tool call is needed.

**Language.** `voice.stt.language` applies to the owner's **voice notes only**. Any other
audio (a forwarded recording, a shared mp3) is auto-detected instead, because a forced
language does not make the transcriber fail — it makes it produce fluent, confident text
that is simply wrong.

## Manual TTS (outbound)

TTS is **never automatic**: call `audio(action="speak")` when the user asks for audio. The file
is **not sent by itself**: put `MEDIA:<path>` in the answer. Only the take the answer names is
delivered, so listening to it (`transcribe`) and making it again is fine.

```tool
audio(action="speak", text="Hello")                     # Effective mode; forceCloud/forceLocal=true per call
```

**Text first.** Show the useful written answer in a commentary message before calling
`audio(action="speak")`, so the user can read it while audio is generated. Send the chosen
`MEDIA:<path>` in the final answer; do not duplicate the whole written answer there.

Prefer a short spoken summary (about 30–60 seconds), unless the user explicitly requests
the full reading or an audio report / podcast. Ceilings: **5000 characters** on Edge and Piper,
**40 000** on Gemini (read in ~4000-character pieces, joined into one MP3). A ceiling is not a target.

### Gemini (`voice.tts.provider: "gemini"`)

The quality engine for audio reports and podcasts: Gemini voice ids, a `style`, dialogues and
podcasts of **up to 4 voices** (`speakers`). Voices, examples, podcast writing and quota:
read `references/gemini.md` before a Gemini reading.

With Gemini, the fallback is automatic: the next Gemini model, then Edge. When the result has a
`Fallback:` line, **tell the user** (which engine or model read it, and why). Edge is killed once
**no audio arrives for 20 seconds**; Stop cancels any engine. If it still fails, finish with the
written answer and a brief audio error: no retry of your own, no partial file.

## Manual STT

```tool
audio(action="transcribe", filePath="/tmp/audio.ogg")                 # Auto-detect the language
audio(action="transcribe", filePath="/tmp/audio.ogg", language="en")  # Force a language you are sure of
```
Limit: **25 MB** per file, compress or split longer recordings.

Pass `language` only when you know it: a wrong forced language yields plausible nonsense with
no error, auto-detection is reliable.

## Mode Switch (runtime)

```tool
audio(action="mode", mode="cloud", feature="all")     # Everything cloud
audio(action="mode", mode="local", feature="stt")     # STT local only
audio(action="mode", mode="local", feature="tts")     # TTS local only
```

## Modes

| Mode | STT | TTS |
|---|---|---|
| Cloud | Groq whisper-large-v3 (~1-2s) | Gemini or Edge TTS (per `voice.tts.provider`), MP3 |
| Local | faster-whisper :8000 (~5-7s) | Piper WAV |

No STT fallback. TTS falls back only from Gemini (other models, then Edge), never from Edge or Piper.

## Overrides (priority)

1. `forceCloud` / `forceLocal` in the tool call (per-call)
2. `voice.<stt|tts>.mode` (per-feature)
3. `voice.mode` (global)
4. `"auto"` -> STT: cloud if GROQ_API_KEY is set, else local. TTS: cloud, except with provider gemini and no GEMINI_API_KEY (then local).
