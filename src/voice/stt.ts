import { stat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { VoiceManager } from "./manager.ts";
import type { STTResult, TranscriptionResult } from "./types.ts";

export class SttPipeline {
  constructor(private voiceManager: VoiceManager) {}

  /** language is passed in rather than read from config: forcing a language is right for the
   *  owner dictating a voice note and wrong for an arbitrary audio file, where Whisper would
   *  invent plausible text instead of failing. Callers decide; undefined means auto-detect. */
  async transcribe(filePath: string, language?: string): Promise<STTResult> {
    const mode = this.voiceManager.resolveMode("stt");
    try {
      return mode === "cloud"
        ? await this.transcribeGroq(filePath, language)
        : await this.transcribeLocal(filePath, language);
    } catch (err) {
      throw new Error(`STT ${mode} failed: ${err}`);
    }
  }

  /** Language configured for the owner's own voice notes. Deliberately NOT applied to other
   *  audio: see transcribe(). */
  voiceNoteLanguage(): string | undefined {
    return this.voiceManager.getVoiceConfig()?.stt?.language;
  }

  async transcribeWithFallback(filePath: string, language?: string): Promise<TranscriptionResult> {
    try {
      const result = await this.transcribe(filePath, language);
      return { text: result.text };
    } catch (err) {
      return { text: "", error: String(err) };
    }
  }

  private async transcribeGroq(filePath: string, language?: string): Promise<STTResult> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY not set");
    }

    const fileStat = await stat(filePath);
    if (fileStat.size === 0) {
      throw new Error("Audio file is empty (0 bytes)");
    }
    const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
    if (fileStat.size > MAX_AUDIO_SIZE) {
      throw new Error(`Audio file too large (${Math.round(fileStat.size / 1024 / 1024)}MB, max 25MB)`);
    }

    const buffer = await readFile(filePath);

    const formData = new FormData();
    const originalName = basename(filePath);
    const uploadName = originalName.replace(/\.oga$/i, ".ogg");
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = { ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4" };
    const mimeType = mimeMap[ext] ?? "audio/ogg";
    const file = new File([buffer], uploadName, { type: mimeType });
    formData.append("file", file);
    formData.append("model", "whisper-large-v3");
    if (language) formData.append("language", language);

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error ${response.status}: ${error}`);
    }

    const data = await response.json() as { text: string; language?: string };
    return {
      text: data.text,
      language: data.language,
    };
  }

  private async transcribeLocal(filePath: string, language?: string): Promise<STTResult> {
    const endpoint = process.env.FASTER_WHISPER_ENDPOINT ?? "http://127.0.0.1:8000";

    const fileStat = await stat(filePath);
    const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
    if (fileStat.size > MAX_AUDIO_SIZE) {
      throw new Error(`Audio file too large (${Math.round(fileStat.size / 1024 / 1024)}MB, max 25MB)`);
    }

    const formData = new FormData();
    formData.append("file", Bun.file(filePath));
    // The local backend used to ignore the language entirely, so stt.language silently did
    // nothing in local mode.
    if (language) formData.append("language", language);

    const response = await fetch(`${endpoint}/transcribe`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Local whisper error ${response.status}: ${error}`);
    }

    const data = await response.json() as { text: string; language?: string };
    return {
      text: data.text,
      language: data.language,
    };
  }
}
