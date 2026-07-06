---
name: voice
description: Manage cloud/local voice mode for STT and TTS, integrated into the orchestrator.
---

# Voice Skill

## Automatic STT (inbound)

Voice notes are transcribed automatically before agent processing.
The transcript is sent as a visible message to the user.

No tool call needed for inbound STT.

## Manual TTS (outbound)

TTS is **never automatic**. The agent must call the `tts` tool
when the user asks for audio.

```tool
tts(text="Hello")                     # Effective mode
tts(text="Hello", forceCloud=true)    # Force cloud
tts(text="Hello", forceLocal=true)    # Force local
```

## Manual STT

```tool
stt(filePath="/tmp/audio.ogg")           # Transcribe a file
```

## Mode Switch (runtime)

```tool
voice_mode(mode="cloud", feature="all")     # Everything cloud
voice_mode(mode="local", feature="stt")     # STT local only
voice_mode(mode="local", feature="tts")     # TTS local only
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
4. `"auto"` -> cloud if credentials available, else local
