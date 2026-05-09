export interface STTResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface TTSResult {
  path: string;
  mimeType: string;
  durationMs?: number;
}

export type VoiceMode = "cloud" | "local";

export interface TranscriptionResult {
  text: string;
  error?: string;
}
