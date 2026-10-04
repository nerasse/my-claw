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

TTS is **never automatic**. The agent must call the `audio` tool (`action="speak"`)
when the user asks for audio. The file it makes is **not sent by itself**: put
`MEDIA:<path>` in the answer to send it. Listening to it (`action="transcribe"`) and making it
again is fine; only the take the answer names is delivered.

```tool
audio(action="speak", text="Hello")                     # Effective mode; forceCloud/forceLocal=true per call
```

**Text first.** Show the useful written answer in a commentary message before calling
`audio(action="speak")`, so the user can read it while audio is generated. Send the chosen
`MEDIA:<path>` in the final answer; do not duplicate the whole written answer there.

Prefer a short spoken summary (about 30–60 seconds), unless the user explicitly requests
the full reading. The **5000-character limit** is a ceiling, not a target.

Cloud generation is killed once **no audio arrives for 20 seconds** (a long reading is fine
while it progresses); Stop cancels it too. If it fails, finish with the written answer and a
brief audio error: no automatic retry, no silent engine change, no partial file. A new attempt
or a different engine needs the user's choice.

## Manual STT

```tool
audio(action="transcribe", filePath="/tmp/audio.ogg")                 # Auto-detect the language
audio(action="transcribe", filePath="/tmp/audio.ogg", language="en")  # Force a language you are sure of
```

Limit: **25 MB max** per audio file — compress/split longer recordings first.

Only pass `language` when you actually know it (the user told you, or the surrounding
conversation makes it certain). Guessing is worse than omitting it: auto-detection is
reliable, whereas a wrong forced language yields plausible nonsense with no error.

## Mode Switch (runtime)

```tool
audio(action="mode", mode="cloud", feature="all")     # Everything cloud
audio(action="mode", mode="local", feature="stt")     # STT local only
audio(action="mode", mode="local", feature="tts")     # TTS local only
```

The change applies at runtime, no reboot.

## Modes

| Mode | STT | TTS |
|---|---|---|
| Cloud | Groq whisper-large-v3 (~1-2s) | Edge TTS MP3 |
| Local | faster-whisper :8000 (~5-7s) | Piper WAV |

No automatic fallback anywhere: a failed STT is a visible error to the user, a failed TTS an
error returned to the tool.

## Overrides (priority)

1. `forceCloud` / `forceLocal` in the tool call (per-call)
2. `voice.<stt|tts>.mode` (per-feature)
3. `voice.mode` (global)
4. `"auto"` -> STT: cloud if GROQ_API_KEY is set, else local. TTS: always cloud (edge-tts needs no credentials).
