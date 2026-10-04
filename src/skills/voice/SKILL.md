---
name: voice
description: Manage cloud/local voice mode for STT and TTS, integrated into the orchestrator.
---

# Voice Skill

## Automatic STT (inbound)

Voice notes are transcribed automatically before agent processing.
The transcript is sent as a visible message to the user.

No tool call needed for inbound STT.

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
audio(action="speak", text="Hello")                     # Effective mode
audio(action="speak", text="Hello", forceCloud=true)    # Force cloud
audio(action="speak", text="Hello", forceLocal=true)    # Force local
```

Limit: **5000 characters max** per call — longer text is rejected, shorten or split it.

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

The change is **runtime** — no reboot needed.

## Modes

| Mode | STT | TTS |
|---|---|---|
| Cloud | Groq whisper-large-v3 (~1-2s) | Edge TTS MP3 |
| Local | faster-whisper :8000 (~5-7s) | Piper WAV |

## Errors

No automatic fallback. If the chosen mode fails, the error is raised
explicitly:
- STT: visible error message to the user
- TTS: error returned to the tool, the agent handles the response

## Overrides (priority)

1. `forceCloud` / `forceLocal` in the tool call (per-call)
2. `voice.<stt|tts>.mode` (per-feature)
3. `voice.mode` (global)
4. `"auto"` -> STT: cloud if GROQ_API_KEY is set, else local. TTS: always cloud (edge-tts needs no credentials).
