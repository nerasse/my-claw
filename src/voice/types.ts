export interface STTResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface TTSResult {
  path: string;
  mimeType: string;
  durationMs?: number;
  /** An engine or model other than the configured one read it: the owner is told. */
  notice?: string;
}

export type VoiceMode = "cloud" | "local";

export interface TranscriptionResult {
  text: string;
  error?: string;
}
