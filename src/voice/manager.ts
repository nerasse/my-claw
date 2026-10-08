import type { MyClawConfig } from "../core/config.ts";
import type { VoiceMode } from "./types.ts";

export class VoiceManager {
  constructor(private config: MyClawConfig) {}

  resolveMode(
    feature: "stt" | "tts",
    overrides?: { forceCloud?: boolean; forceLocal?: boolean },
  ): VoiceMode {
    if (overrides?.forceCloud) return "cloud";
    if (overrides?.forceLocal) return "local";

    const featureMode = this.config.voice?.[feature]?.mode;
    if (featureMode && featureMode !== "auto") return featureMode;

    const globalMode = this.config.voice?.mode ?? "auto";
    if (globalMode !== "auto") return globalMode;

    return this.hasCloudCredentials(feature) ? "cloud" : "local";
  }

  getEchoConfig(): { enabled: boolean; format: string } {
    const stt = this.config.voice?.stt;
    return {
      enabled: stt?.echoTranscript !== false,
      format: stt?.echoFormat ?? '📝 "{transcript}"',
    };
  }

  formatEcho(transcript: string): string {
    const { format } = this.getEchoConfig();
    return format.replace("{transcript}", () => transcript);
  }

  setGlobalMode(mode: "cloud" | "local" | "auto"): void {
    if (!this.config.voice) {
      this.config.voice = {};
    }
    this.config.voice.mode = mode;
  }

  setFeatureMode(feature: "stt" | "tts", mode: "cloud" | "local" | "auto"): void {
    if (!this.config.voice) {
      this.config.voice = {};
    }
    if (!this.config.voice[feature]) {
      this.config.voice[feature] = {};
    }
    this.config.voice[feature]!.mode = mode;
  }

  getVoiceConfig(): MyClawConfig["voice"] {
    return this.config.voice;
  }

  ttsProvider(): "edge" | "gemini" {
    return this.config.voice?.tts?.provider === "gemini" ? "gemini" : "edge";
  }

  private hasCloudCredentials(feature: "stt" | "tts"): boolean {
    if (feature === "stt") {
      return !!process.env.GROQ_API_KEY;
    }
    return this.ttsProvider() === "gemini" ? !!process.env.GEMINI_API_KEY?.trim() : true;
  }
}
