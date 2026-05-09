import type { VoiceManager } from "./manager.ts";
import type { STTResult, TranscriptionResult } from "./types.ts";

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

  async transcribeWithFallback(filePath: string): Promise<TranscriptionResult> {
    try {
      const result = await this.transcribe(filePath);
      return { text: result.text };
    } catch (err) {
      return { text: "", error: String(err) };
    }
  }

  private async transcribeGroq(filePath: string): Promise<STTResult> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY not set");
    }

    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(filePath);
    if (fileStat.size === 0) {
      throw new Error("Audio file is empty (0 bytes)");
    }

    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(filePath);

    // Validate Ogg header (Telegram voice notes should start with "OggS")
    const isOgg = buffer.length >= 4 && buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53;
    if (!isOgg && buffer.length > 0) {
      throw new Error(`Audio file is not a valid Ogg/Opus file (header: ${buffer.slice(0, 4).toString("hex")})`);
    }

    const formData = new FormData();
    const { basename } = await import("node:path");
    const originalName = basename(filePath);
    // Groq doesn't accept .oga (Telegram voice note extension), normalize to .ogg
    const uploadName = originalName.replace(/\.oga$/i, ".ogg");
    // Force MIME type to audio/ogg so Groq recognises the file
    const file = new File([buffer], uploadName, { type: "audio/ogg" });
    formData.append("file", file);
    formData.append("model", "whisper-large-v3");
    formData.append("language", "fr");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
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

  private async transcribeLocal(filePath: string): Promise<STTResult> {
    const endpoint = process.env.FASTER_WHISPER_ENDPOINT ?? "http://127.0.0.1:18792";

    const formData = new FormData();
    formData.append("file", Bun.file(filePath));

    const response = await fetch(`${endpoint}/transcribe`, {
      method: "POST",
      body: formData,
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
