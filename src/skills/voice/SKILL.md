---
name: voice
description: |
  Gestion du mode voix cloud/local pour STT et TTS.
  Integre dans l'orchestrateur — pas de scripts externes.
---

# Voice Skill

## STT Automatique (inbound)

Les voice notes sont transcrits automatiquement avant traitement par l'agent.
La transcription est envoyee comme message visible a l'utilisateur.

Pas de tool call necessaire pour l'inbound STT.

## TTS Manuel (outbound)

Le TTS n'est **jamais automatique**. L'agent doit appeler le tool `tts`
quand l'utilisateur demande un audio.

```tool
tts(text="Bonjour")                     # Mode effectif
tts(text="Bonjour", forceCloud=true)    # Forcer cloud
tts(text="Bonjour", forceLocal=true)    # Forcer local
```

## STT Manuel

```tool
stt(filePath="/tmp/audio.ogg")           # Transcrire un fichier
```

## Changement de mode (runtime)

```tool
voice_mode(mode="cloud", feature="all")     # Tout en cloud
voice_mode(mode="local", feature="stt")     # STT local uniquement
voice_mode(mode="local", feature="tts")     # TTS local uniquement
```

Le changement est **runtime** — pas besoin de redemarrer.

## Modes

| Mode | STT | TTS |
|---|---|---|
| Cloud | Groq whisper-large-v3 (~1-2s) | Edge TTS MP3 |
| Local | faster-whisper :18792 (~5-7s) | Piper WAV |

## Erreurs

Pas de fallback automatique. Si le mode choisi echoue, l'erreur est remontee
explicitement :
- STT : message d'erreur visible au user
- TTS : erreur retournee au tool, l'agent gere la reponse

## Overrides (priorite)

1. `forceCloud` / `forceLocal` dans l'appel tool (per-call)
2. `voice.features.<stt|tts>.mode` (per-feature)
3. `voice.mode` (global)
4. `"auto"` -> cloud si credentials dispo, sinon local
