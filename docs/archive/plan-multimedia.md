# Plan Multimédia pour my-claw

## Vision

my-claw supporte images, audio, vidéo en entrée et audio en sortie (TTS). Le gateway reçoit des voice notes, photos, vidéos via Telegram et Matrix. Le LLM les "comprend" sans jamais recevoir de bytes bruts audio/vidéo.

## Philosophie

- **Audio entrée** : jamais de bytes audio au LLM. STT automatique en amont → texte injecté dans le prompt. La transcription est **envoyée comme message visible** à l'utilisateur.
- **Audio sortie** (TTS) : **génération manuelle uniquement via tool `tts`**. L'agent appelle l'outil quand l'utilisateur demande un audio. Pas de TTS automatique post-réponse. Pas de service démon — appels API/CLI ponctuels, fichiers temporaires dans `/tmp/`.
- **Pas de fallback** : si le mode choisi échoue (cloud down, local absent), erreur explicite. Pas de bascule automatique cloud ↔ local.
- **Images** : ffmpeg pour resize + base64. Pas de sharp.
- **Vidéo** : ffmpeg extrait des frames → images traitées normalement.
- **Config minimaliste** : un seul objet `voice` avec `mode` global + overrides optionnels par feature.
- **Runtime sans reboot** : `VoiceManager` mutable, partagé. Changement de mode = immédiat.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Message reçu (Telegram/Matrix)                             │
│  └── Attachment audio (.ogg)                                │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  AgentBridge.handle() — Pré-traitement automatique         │
│                                                              │
│  1. STT AUTO (inbound audio):                                │
│     ┌─────────────┐    ┌─────────────────┐                 │
│     │ Voice note  │───▶│ VoiceManager    │                 │
│     │ .ogg / .mp3 │    │ resolveMode()   │                 │
│     └─────────────┘    └────────┬────────┘                 │
│                                 │ "cloud" ou "local"        │
│                                 ▼                          │
│                        ┌─────────────────┐                 │
│                        │ SttPipeline     │                 │
│                        │ - Cloud: Groq   │                 │
│                        │ - Local: faster-│                 │
│                        │   whisper :18792│                 │
│                        └────────┬────────┘                 │
│                                 │ texte transcrit          │
│                                 ▼                          │
│                        a. Injection dans prompt:            │
│                           "[Audio]: \"...\""                │
│                        b. Envoi message visible user:       │
│                           "📝 \"...\""                      │
│                                                              │
│  2. VIDEO → FRAMES:                                          │
│     ┌─────────────┐    ┌─────────────────┐                 │
│     │ Vidéo .mp4  │───▶│ VideoPipeline   │                 │
│     │             │    │ ffmpeg fps=1/5  │                 │
│     └─────────────┘    │ frame_%03d.jpg  │                 │
│                        └────────┬────────┘                 │
│                                 │ N images                 │
│                                 ▼                          │
│                        Traitement comme IMAGES            │
│                                                              │
│  3. IMAGE → BASE64:                                          │
│     ┌─────────────┐    ┌─────────────────┐                 │
│     │ Photo .jpg  │───▶│ ImagePipeline   │                 │
│     │             │    │ ffmpeg resize   │                 │
│     └─────────────┘    │ + base64        │                 │
│                        └────────┬────────┘                 │
│                                 │ data:image/...             │
│                                 ▼                          │
│                        "image_url" dans content array       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  LLM reçoit texte (pas de bytes audio/vidéo)               │
│  └── Génère réponse texte                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  TTS MANUEL (tool call uniquement)                         │
│                                                              │
│  L'agent appelle `tts(text="...")` quand l'utilisateur     │
│  demande un audio. Pas de TTS automatique post-réponse.      │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ Tool tts        │───▶│ VoiceManager    │                │
│  │                 │    │ resolveMode()   │                │
│  └─────────────────┘    └────────┬────────┘                │
│                                 │ "cloud" ou "local"        │
│                                 ▼                          │
│                        ┌─────────────────┐                 │
│                        │ TtsPipeline     │                 │
│                        │ - Cloud: edge-tts│                │
│                        │ - Local: piper   │                │
│                        └────────┬────────┘                 │
│                                 │ fichier audio /tmp/       │
│                                 ▼                          │
│                        ┌─────────────────┐                 │
│                        │ Channel.send()  │                 │
│                        │ - Telegram:     │                 │
│                        │   sendVoice     │                 │
│                        │ - Matrix:       │                 │
│                        │   msc3245.voice │                 │
│                        └─────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Config Minimaliste

```json
{
  "voice": {
    "mode": "cloud",
    "stt": { "mode": "auto" },
    "tts": {
      "mode": "auto",
      "voice": "fr-FR-RemyMultilingualNeural"
    }
  }
}
```

**Règles de résolution (ordre de priorité) :**

1. **Per-call override** (`forceCloud`, `forceLocal` dans l'appel tool)
2. **Feature-level config** (`voice.stt.mode`, `voice.tts.mode`)
3. **Global mode** (`voice.mode`)
4. **`"auto"`** → cloud si clé API présente, sinon local

Si `voice.stt.mode` n'est pas défini → hérite de `voice.mode`. Même chose pour `tts`.

---

## VoiceManager — Runtime Mutable

**Fichier** : `src/voice/manager.ts`

```typescript
export class VoiceManager {
  constructor(private config: MyClawConfig) {}

  resolveMode(
    feature: "stt" | "tts",
    overrides?: { forceCloud?: boolean; forceLocal?: boolean }
  ): "cloud" | "local" {
    // 1. Per-call override
    if (overrides?.forceCloud) return "cloud";
    if (overrides?.forceLocal) return "local";

    // 2. Feature-level
    const featureMode = this.config.voice?.[feature]?.mode;
    if (featureMode && featureMode !== "auto") return featureMode;

    // 3. Global mode
    const globalMode = this.config.voice?.mode ?? "auto";
    if (globalMode !== "auto") return globalMode;

    // 4. Auto-detect: cloud if API key present, else local
    return this.hasCloudCredentials(feature) ? "cloud" : "local";
  }

  // Runtime mutation — no reboot needed
  setGlobalMode(mode: "cloud" | "local" | "auto"): void;
  setFeatureMode(feature: "stt" | "tts", mode: "cloud" | "local" | "auto"): void;

  private hasCloudCredentials(feature: "stt" | "tts"): boolean {
    return feature === "stt"
      ? !!process.env.GROQ_API_KEY
      : true; // edge-tts requires no API key
  }
}
```

---

## Phase 1 : STT Automatique + Echo Transcript — PRIORITÉ MAX

### 1.1 Pipeline STT

**Quand** : Un message contient `attachment.type === "audio"` (voice note, audio file).

**Quoi** (automatique, pas de tool call) :
1. Téléchargement local ✅ (déjà fait par channels)
2. `VoiceManager.resolveMode("stt")` → "cloud" ou "local"
3. `SttPipeline.transcribe(path, mode)` :
   - **Cloud** : POST Groq API (`whisper-large-v3`)
   - **Local** : POST `localhost:18792` (`faster-whisper` server)
4. Si échec → **erreur explicite** (pas de fallback). Message d'erreur envoyé au user.
5. **Echo transcript** : envoyer la transcription comme message texte visible au user (`📝 "transcription"`)
6. **Injection** : `"\n\n[Audio]: \"...\""` dans le prompt

### 1.2 Implémentation

**Fichier** : `src/voice/stt.ts`

```typescript
export interface STTResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export class SttPipeline {
  constructor(private voiceManager: VoiceManager) {}

  async transcribe(filePath: string): Promise<STTResult> {
    const mode = this.voiceManager.resolveMode("stt");
    try {
      return mode === "cloud"
        ? await this.transcribeGroq(filePath)
        : await this.transcribeLocal(filePath);
    } catch (err) {
      throw new Error(`STT ${mode} failed: ${err}`);
    }
  }

  private async transcribeGroq(filePath: string): Promise<STTResult> {
    // POST https://api.groq.com/openai/v1/audio/transcriptions
    // form-data: file, model=whisper-large-v3, language=fr
  }

  private async transcribeLocal(filePath: string): Promise<STTResult> {
    // POST http://127.0.0.1:18792/transcribe
    // multipart/form-data: file
  }
}
```

### 1.3 Intégration Bridge — STT Auto

**Fichier** : `src/agent/bridge.ts`

```typescript
private async preprocessAudio(message: UnifiedMessage): Promise<{ transcription?: string; error?: string }> {
  const audioAttachments = message.attachments.filter(a => a.type === "audio");
  if (audioAttachments.length === 0) return {};

  const att = audioAttachments[0]; // Premier audio uniquement
  if (!att.path) return {};

  try {
    const result = await this.sttPipeline.transcribe(att.path);
    message.text += `\n\n[Audio]: "${result.text}"`;
    return { transcription: result.text };
  } catch (err) {
    const errorMsg = String(err);
    message.text += `\n\n[Audio]: [Transcription failed: ${errorMsg}]`;
    return { error: errorMsg };
  }
}
```

### 1.4 Echo Transcript

**Envoyé comme message séparé** au user avant que l'agent ne traite la requête.

```typescript
// Dans AgentBridge.handle(), après preprocessAudio
if (preprocessResult.transcription) {
  await this.sendToChannel({
    text: `📝 "${preprocessResult.transcription}"`,
    channelId: message.channelId,
    threadId: message.threadId,
  });
}

if (preprocessResult.error) {
  await this.sendToChannel({
    text: `⚠️ STT failed: ${preprocessResult.error}`,
    channelId: message.channelId,
    threadId: message.threadId,
  });
}
```

Format configurable via `voice.stt.echoFormat` (défaut: `📝 "{transcript}"`).

---

## Phase 2 : TTS Manuel — Tool Call uniquement

### 2.1 Pipeline TTS

**Quand** : L'agent appelle le tool natif `tts` avec un texte. **Jamais automatiquement.**

**Quoi** :
1. Tool `tts` appelé par l'agent
2. `VoiceManager.resolveMode("tts")` → "cloud" ou "local"
3. `TtsPipeline.generate(text, mode)` :
   - **Cloud** : `edge-tts` CLI → MP3 dans `/tmp/`
   - **Local** : `piper` CLI → WAV dans `/tmp/`
4. Fichier audio retourné au tool
5. L'agent envoie le fichier comme pièce jointe via le channel
6. Nettoyage auto du fichier temporaire après envoi

**Pas de service démon.** Appel CLI ponctuel, fichier temporaire, nettoyage après envoi.

### 2.2 Implémentation

**Fichier** : `src/voice/tts.ts`

```typescript
export interface TTSResult {
  path: string;
  mimeType: string;
  durationMs?: number;
}

export class TtsPipeline {
  constructor(private voiceManager: VoiceManager) {}

  async generate(
    text: string,
    overrides?: { forceCloud?: boolean; forceLocal?: boolean; voice?: string }
  ): Promise<TTSResult> {
    const mode = this.voiceManager.resolveMode("tts", overrides);
    try {
      return mode === "cloud"
        ? await this.generateEdgeTTS(text, overrides?.voice)
        : await this.generatePiper(text, overrides?.voice);
    } catch (err) {
      throw new Error(`TTS ${mode} failed: ${err}`);
    }
  }

  private async generateEdgeTTS(text: string, voice?: string): Promise<TTSResult> {
    // edge-tts --text "..." --voice fr-FR-RemyMultilingualNeural --write-media /tmp/tts-XXXX.mp3
    // Retourne chemin + mimeType audio/mpeg
  }

  private async generatePiper(text: string, model?: string): Promise<TTSResult> {
    // piper --model fr_FR-siwis-medium.onnx --output_file /tmp/tts-XXXX.wav <<< "..."
    // Retourne chemin + mimeType audio/wav
  }
}
```

### 2.3 Tool natif `tts`

**Fichier** : `src/tools/tts.ts`

```typescript
export function createTtsTool(pipeline: TtsPipeline): Tool {
  return {
    name: "tts",
    description: "Generate audio from text using the configured voice engine (cloud or local). Returns the path to the generated audio file.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        voice: { type: "string", description: "Voice ID override (optional)" },
        forceCloud: { type: "boolean" },
        forceLocal: { type: "boolean" }
      },
      required: ["text"]
    },
    async execute(args): Promise<ToolResult> {
      const result = await pipeline.generate(args.text as string, {
        voice: args.voice as string | undefined,
        forceCloud: args.forceCloud as boolean | undefined,
        forceLocal: args.forceLocal as boolean | undefined
      });
      return { success: true, output: result.path };
    }
  };
}
```

L'agent reçoit le chemin du fichier audio et doit l'envoyer comme pièce jointe via le channel.

### 2.4 Envoi Audio aux Channels

**Telegram** (`src/channels/telegram/send.ts`) :
```typescript
if (attachment.type === "audio" && attachment.audioAsVoice) {
  // sendVoice (voice note circulaire)
  await bot.api.sendVoice(chatId, createReadStream(attachment.path), {
    reply_parameters: replyToId ? { message_id: replyToId } : undefined,
  });
} else if (attachment.type === "audio") {
  // sendAudio (fichier audio classique)
  await bot.api.sendAudio(chatId, createReadStream(attachment.path), {
    reply_parameters: replyToId ? { message_id: replyToId } : undefined,
  });
}
```

**Matrix** (`src/channels/matrix/send.ts`) :
```typescript
if (attachment.type === "audio" && attachment.audioAsVoice) {
  // Ajouter flag MSC3245 voice
  content["org.matrix.msc3245.voice"] = {};
  content["org.matrix.msc1767.audio"] = { duration: attachment.durationMs };
}
```

### 2.5 Nettoyage Temporaire

```typescript
// Après envoi réussi
for (const att of outgoing.attachments) {
  if (att.path?.startsWith("/tmp/tts-")) {
    await unlink(att.path).catch(() => {});
  }
}
```

---

## Phase 3 : Images (Vision) — COMPLETE

### 3.1 Pipeline Images

**Quand** : `attachment.type === "image"`.

**Quoi** :
1. ffmpeg resize si nécessaire (> 2000px ou > 2MB)
2. Encode base64
3. Si `llm.vision === true` → `image_url` dans content array
4. Sinon → texte `[image: /tmp/photo.jpg]` dans le prompt

### 3.2 Implémentation

**Fichier** : `src/media/image.ts`

```typescript
export async function imageToBase64(
  path: string,
  options?: { maxWidth?: number; maxHeight?: number; maxBytes?: number }
): Promise<{ dataUrl: string; wasResized: boolean }> {
  // ffmpeg -i input.jpg -vf "scale=2000:-1" -q:v 2 output.jpg
  // Puis readFile + base64
  // Retourne data:image/jpeg;base64,...
}
```

### 3.3 Modification Provider

**Fichier** : `src/llm/provider.ts`

```typescript
export type ChatMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatMessageContent[] }
  | { role: "assistant"; content: string; tool_calls?: Array<...> }
  | { role: "tool"; tool_call_id: string; content: string };
```

### 3.4 Intégration Bridge

```typescript
// Dans handle(), si vision supportée
if (this.config.llm.vision && message.attachments.some(a => a.type === "image" && a.path)) {
  const lastIdx = chatMessages.length - 1;
  if (chatMessages[lastIdx]?.role === "user") {
    chatMessages[lastIdx] = {
      role: "user",
      content: await this.buildImageContent(message),
    };
  }
}
```

---

## Phase 4 : Vidéo

### 4.1 Pipeline Vidéo

**Quand** : `attachment.type === "video"`.

**Quoi** :
1. ffmpeg extrait des frames (1 frame toutes les 5 secondes, max 10 frames)
2. Frames converties en attachments `image`
3. Traitement standard des images (Phase 3)

**Commande** :
```bash
ffmpeg -i video.mp4 -vf "fps=1/5,scale=1920:-1:flags=lanczos" -frames:v 10 /tmp/frames/frame_%03d.jpg
```

### 4.2 Implémentation

**Fichier** : `src/media/video.ts`

```typescript
export async function extractVideoFrames(
  videoPath: string,
  options?: { fps?: number; maxFrames?: number }
): Promise<string[]> {
  // Retourne liste de chemins d'images extraites
}
```

### 4.3 Intégration Bridge

Les vidéos deviennent des images :
```typescript
if (message.attachments.some(a => a.type === "video")) {
  for (const video of videoAttachments) {
    const frames = await extractVideoFrames(video.path!);
    message.attachments.push(...frames.map(path => ({
      type: "image" as const,
      path,
      mimeType: "image/jpeg"
    })));
  }
  // Supprimer les attachments vidéo originales
  message.attachments = message.attachments.filter(a => a.type !== "video");
}
```

---

## Tools Natifs Voice

Ces tools sont pour les cas **explicites** (ex: "transcris ce fichier", "lis-moi ce poème"). Le STT inbound ne passe **pas** par ces tools — il est automatique.

### `stt` — Transcription manuelle

```typescript
{
  name: "stt",
  description: "Transcribe an audio file to text. Respects voice mode configuration.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      language: { type: "string" },
      forceCloud: { type: "boolean" },
      forceLocal: { type: "boolean" }
    },
    required: ["filePath"]
  }
}
```

### `tts` — Génération audio manuelle

```typescript
{
  name: "tts",
  description: "Generate audio from text. Respects voice mode configuration.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      voice: { type: "string" },
      forceCloud: { type: "boolean" },
      forceLocal: { type: "boolean" }
    },
    required: ["text"]
  }
}
```

### `voice_mode` — Gestion du mode

```typescript
{
  name: "voice_mode",
  description: "Configure voice mode (cloud/local/auto) for STT/TTS. Runtime, no reboot.",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["cloud", "local", "auto"] },
      feature: { type: "string", enum: ["stt", "tts", "all"], default: "all" }
    },
    required: ["mode"]
  }
}
```

---

## Skill Voice Built-In

**Fichier** : `src/skills/voice/SKILL.md`

```markdown
---
name: voice
description: |
  Gestion du mode voix cloud/local pour STT et TTS.
  Intégré dans l'orchestrateur — pas de scripts externes.
---

# Voice Skill

## STT Automatique (inbound)

Les voice notes sont transcrits automatiquement avant traitement par l'agent. La transcription est envoyée comme message visible à l'utilisateur.

Pas de tool call nécessaire pour l'inbound STT.

## TTS Manuel (outbound)

Le TTS n'est **jamais automatique**. L'agent doit appeler le tool `tts` quand l'utilisateur demande un audio.

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

Le changement est **runtime** — pas besoin de redémarrer.

## Modes

| Mode | STT | TTS |
|---|---|---|
| Cloud | Groq whisper-large-v3 (~1-2s) | Edge TTS MP3 |
| Local | faster-whisper :18792 (~5-7s) | Piper WAV |

## Erreurs

Pas de fallback automatique. Si le mode choisi échoue, l'erreur est remontée explicitement :
- STT : message d'erreur visible au user
- TTS : erreur retournée au tool, l'agent gère la réponse

## Overrides (priorité)

1. `forceCloud` / `forceLocal` dans l'appel tool (per-call)
2. `voice.features.<stt|tts>.mode` (per-feature)
3. `voice.mode` (global)
4. `"auto"` → cloud si credentials dispo, sinon local
```

---

## Fichiers à créer

| Fichier | Description |
|---|---|
| `src/voice/manager.ts` | `VoiceManager` — résolution de mode runtime |
| `src/voice/stt.ts` | `SttPipeline` — transcription Groq + local |
| `src/voice/tts.ts` | `TtsPipeline` — génération Edge TTS + Piper |
| `src/voice/index.ts` | Export central |
| `src/media/image.ts` | Encode/resize images via ffmpeg + base64 ✅ |
| `src/media/video.ts` | Extract frames via ffmpeg ✅ |
| `src/media/index.ts` | Export central média ✅ |
| `src/tools/stt.ts` | Tool natif `stt` (manuel) |
| `src/tools/tts.ts` | Tool natif `tts` (manuel) |
| `src/tools/voice-mode.ts` | Tool natif `voice_mode` |
| `src/skills/voice/SKILL.md` | Skill built-in voice |

## Fichiers à modifier

| Fichier | Changements |
|---|---|
| `src/core/config.ts` | Ajouter `VoiceConfig` dans `MyClawConfig`. Ajouter `vision?: boolean` dans `llm`. ✅ |
| `src/agent/bridge.ts` | Injecter `VoiceManager`, `SttPipeline`, `TtsPipeline`. Pré-traitement audio inbound auto + echo transcript. Injection images conditionnelle. ✅ |
| `src/index.ts` | Instancier `VoiceManager`, `SttPipeline`, `TtsPipeline`. Register les 3 tools. ✅ |
| `src/llm/provider.ts` | Support `content` array (text + image_url) ✅ |
| `src/channels/telegram/send.ts` | Support `sendVoice` / `sendAudio` pour pièces jointes audio ✅ |
| `src/channels/matrix/send.ts` | Support `org.matrix.msc3245.voice` pour pièces jointes audio ✅ |
| `src/channels/types.ts` | Ajouter `audioAsVoice?: boolean` et `durationMs?: number` à `Attachment` ✅ |

## Tests

### Stratégie

- **TDD** : écrire les tests avant ou en parallèle de l'implémentation
- **Framework** : `bun:test` (built-in, zero deps)
- **Mocking** : pas de lib externe. Fonctions mockées manuellement via injection de dépendances.
- **Couverture** : unitaires pour la logique dense (VoiceManager, pipelines), intégration pour les flows complets.

### Tests unitaires

#### `tests/media/image.test.ts`

| Test | Setup | Expected |
|---|---|---|
| returns base64 data URL for small image | 1x1 JPEG | `wasResized: false`, `dataUrl` starts with `data:image/jpeg;base64,` |
| resizes image when file exceeds maxBytes | 4000x4000 JPEG, maxBytes=50KB | `wasResized: true`, valid data URL |
| throws for nonexistent file | `/tmp/nonexistent` | throws Error |
| infers PNG mime type from extension | 2x2 PNG | `dataUrl` starts with `data:image/png;base64,` |

#### `tests/llm/provider-content.test.ts`

| Test | Setup | Expected |
|---|---|---|
| serializes array content with image_url | user message with `content: [{type:"text"}, {type:"image_url"}]` | request body contains array with both entries |

#### `tests/voice/manager.test.ts`

| Test | Setup | Expected |
|---|---|---|
| resolve global cloud | `voice.mode: "cloud"` | `"cloud"` pour stt et tts |
| resolve global local | `voice.mode: "local"` | `"local"` pour stt et tts |
| resolve feature override | `voice.mode: "cloud"`, `voice.stt.mode: "local"` | STT `"local"`, TTS `"cloud"` |
| resolve per-call override | `voice.mode: "cloud"`, appel avec `forceLocal: true` | `"local"` |
| resolve auto with credentials | `voice.mode: "auto"`, `GROQ_API_KEY` set | STT `"cloud"`, TTS `"cloud"` |
| resolve auto without credentials | `voice.mode: "auto"`, `GROQ_API_KEY` absent | STT `"local"`, TTS `"cloud"` |
| runtime mutation global | `setGlobalMode("local")` | subsequent calls return `"local"` |
| runtime mutation feature | `setFeatureMode("stt", "cloud")` | STT `"cloud"`, TTS inherits global |

#### `tests/voice/stt.test.ts`

| Test | Setup | Expected |
|---|---|---|
| transcribe cloud success | Mock Groq API returns transcript | `{ text: "hello", language: "fr" }` |
| transcribe cloud failure | Mock Groq API throws 500 | throws `Error("STT cloud failed: ...")` |
| transcribe local success | Mock local endpoint returns transcript | `{ text: "hello" }` |
| transcribe local failure | Local endpoint unreachable | throws `Error("STT local failed: ...")` |
| mode resolution respects VoiceManager | VoiceManager returns `"cloud"` | calls cloud provider, not local |

#### `tests/voice/tts.test.ts`

| Test | Setup | Expected |
|---|---|---|
| generate cloud success | Mock edge-tts writes file | `{ path: "/tmp/tts-...mp3", mimeType: "audio/mpeg" }` |
| generate cloud failure | edge-tts not installed | throws `Error("TTS cloud failed: ...")` |
| generate local success | Mock piper writes file | `{ path: "/tmp/tts-...wav", mimeType: "audio/wav" }` |
| generate local failure | piper not installed | throws `Error("TTS local failed: ...")` |
| per-call voice override | `voice: "en-US-JennyNeural"` | passed to edge-tts command |

#### `tests/tools/voice-mode.test.ts`

| Test | Setup | Expected |
|---|---|---|
| set global mode | `voice_mode(mode="local", feature="all")` | `VoiceManager.setGlobalMode("local")` called |
| set feature mode | `voice_mode(mode="cloud", feature="stt")` | `VoiceManager.setFeatureMode("stt", "cloud")` called |
| invalid mode rejected | `voice_mode(mode="invalid")` | `success: false`, error message |

#### `tests/tools/tts.test.ts`

| Test | Setup | Expected |
|---|---|---|
| execute success | `tts(text="hello")` | `success: true`, output is file path |
| execute with forceCloud | `tts(text="hello", forceCloud=true)` | `VoiceManager.resolveMode("tts", { forceCloud: true })` called |
| execute failure | TtsPipeline throws | `success: false`, error message |

### Tests d'intégration / E2E

#### `tests/agent/bridge-voice.test.ts`

| Test | Setup | Expected |
|---|---|---|
| inbound audio triggers STT | Message with audio attachment | `SttPipeline.transcribe()` called, transcript injected in message.text |
| echo transcript sent | STT returns "hello" | Channel send called with `📝 "hello"` |
| STT failure sends error | STT throws "Groq down" | Channel send called with `⚠️ STT failed: Groq down`, message.text contains `[Audio]: [Transcription failed: ...]` |
| no audio → no STT | Message with text only | `SttPipeline.transcribe()` not called |
| audio + existing text | Message text "check this" + audio | message.text becomes `"check this\n\n[Audio]: \"hello\""` |
| tool tts invoked by agent | LLM returns tool_call `tts("hello")` | `TtsPipeline.generate("hello")` called, file path returned to agent |

#### `tests/e2e/telegram-voice.test.ts`

| Test | Setup | Expected |
|---|---|---|
| full flow voice note | User sends voice note to Telegram bot | 1. Echo transcript sent, 2. Agent receives text, 3. Agent responds text. No TTS auto. |
| user asks for audio | User sends "read me this poem" | Agent calls `tts` tool, audio file sent back |

#### `tests/e2e/matrix-voice.test.ts`

| Test | Setup | Expected |
|---|---|---|
| full flow voice note | User sends m.audio to Matrix room | 1. Echo transcript sent, 2. Agent receives text, 3. Agent responds text. |

### Stratégie de mocking

**VoiceManager mock** :
```typescript
function createMockVoiceManager(overrides?: Partial<VoiceManager>) {
  return {
    resolveMode: () => "cloud" as const,
    setGlobalMode: () => {},
    setFeatureMode: () => {},
    ...overrides,
  } as unknown as VoiceManager;
}
```

**SttPipeline mock** :
```typescript
function createMockSttPipeline(result?: { text: string }) {
  return {
    transcribe: async () => result ?? { text: "mock transcript", language: "fr" },
  } as unknown as SttPipeline;
}
```

**TtsPipeline mock** :
```typescript
function createMockTtsPipeline() {
  return {
    generate: async () => ({ path: "/tmp/tts-mock.mp3", mimeType: "audio/mpeg" }),
  } as unknown as TtsPipeline;
}
```

**Channel send mock** :
```typescript
const sentMessages: Array<{ text: string; attachments: Attachment[] }> = [];
const mockSend = async (msg: OutgoingMessage) => {
  sentMessages.push(msg);
};
```

### Ordre de rédaction des tests

1. **Avant implémentation** : tests `voice/manager.test.ts` (spécifie le comportement attendu)
2. **Pendant implémentation** : tests `voice/stt.test.ts`, `voice/tts.test.ts` (mock des providers)
3. **Après implémentation** : tests `agent/bridge-voice.test.ts` (vérifie le wiring)
4. **En dernier** : tests E2E `e2e/telegram-voice.test.ts`, `e2e/matrix-voice.test.ts` (nécessitent le full stack)

### Running tests

```bash
# Tous les tests
bun test

# Tests voice uniquement
bun test tests/voice/

# Watch mode
bun test --watch

# Un test spécifique
bun test tests/voice/manager.test.ts
```

---

## Ordre d'implémentation

### Étape 1 : Voice Foundation (1-2 jours)
1. `src/core/config.ts` — types `VoiceConfig`
2. `src/voice/manager.ts` — `VoiceManager`
3. `src/voice/stt.ts` — `SttPipeline` (Groq + local)
4. `src/voice/tts.ts` — `TtsPipeline` (Edge TTS + Piper)
5. `src/tools/stt.ts`, `src/tools/tts.ts`, `src/tools/voice-mode.ts`
6. `src/agent/bridge.ts` — pré-traitement audio inbound + echo transcript
7. `src/index.ts` — wiring
8. `src/channels/types.ts` — ajouter champs audio
9. **Tests** : `tests/voice/manager.test.ts`, `tests/voice/stt.test.ts`, `tests/voice/tts.test.ts`, `tests/tools/tts.test.ts`, `tests/tools/voice-mode.test.ts`
10. **Tests intégration** : `tests/agent/bridge-voice.test.ts`

### Étape 2 : Images + Provider (1 jour) — COMPLETE ✅
1. `src/llm/provider.ts` — `content` array ✅
2. `src/media/image.ts` — ffmpeg resize + base64 ✅
3. `src/agent/bridge.ts` — injection images conditionnelle ✅
4. **Tests** : `tests/media/image.test.ts`, `tests/llm/provider-content.test.ts` ✅

### Étape 3 : Vidéo (0.5 jour) — COMPLETE ✅
1. `src/media/video.ts` — ffmpeg frames (1/3s, max 20, scale 1920px) ✅
2. `src/agent/bridge.ts` — conversion vidéo → images ✅
3. **Tests** : `tests/media/video.test.ts` ✅

## Dépendances système

| Dépendance | Phase | Installation |
|---|---|---|
| `faster-whisper` | STT local | `pip install faster-whisper` ou `pip install whisper-ctranslate2` |
| `ffmpeg` | Vidéo + image resize | `apt install ffmpeg` |
| `edge-tts` | TTS cloud | `pip install edge-tts` |
| `piper-tts` | TTS local | Binaire + modèle `fr_FR-siwis-medium` |

## Questions fermées

1. **Fallback** : ❌ Pas de fallback. Erreur explicite.
2. **TTS** : ❌ **Pas de TTS automatique.** TTS manuel uniquement via tool `tts`.
3. **Echo transcript** : ✅ Transcription envoyée comme message texte visible (`📝 "..."`).
4. **Service/démon** : ❌ Pas de service. Appels CLI/API ponctuels, fichiers temporaires `/tmp/tts-*/`.
5. **Resize images** : ✅ ffmpeg uniquement. Pas de sharp.
6. **Pas de reboot** : ✅ `VoiceManager` runtime mutable.
