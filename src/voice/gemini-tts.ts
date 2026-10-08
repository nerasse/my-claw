import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AbortedError, rethrowIfAborted, sleep } from "../core/aborted.ts";
import type { TTSResult } from "./types.ts";

const execFileAsync = promisify(execFile);

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_DEFAULT_VOICE = "fr-fr-podcaster-2";
export const GEMINI_MAX_TEXT = 40_000;
const SAMPLE_RATE = 24_000;
/**
 * About 3.5 minutes of French speech. Users report Gemini voices fading past 2 to 4 minutes of
 * continuous audio (google-gemini/cookbook #1292, 2026-07, on 3.1), so a long text is read in pieces
 * and joined; two 2m45 pieces measured on 3.8 Lite held their level and voice (2026-10-08). Each
 * piece is one request, and the free tier allows 10 per model per day: the 40 000 ceiling is ten
 * pieces, one day of free quota.
 */
const CHUNK_CHARS = 4_000;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 180_000;
const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_WAIT_MS = 20_000;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;
const ENCODE_TIMEOUT_MS = 120_000;
/** Free tier, per model and per day: the 11th request of 2026-10-08 answered 429 "limit: 10". */
export const GEMINI_DAILY_REQUESTS = 10;
export const GEMINI_MAX_SPEAKERS = 4;
/** One request voices at most two speakers ("conversational" mode). */
const SPEAKERS_PER_REQUEST = 2;
/** Between two requests only: Gemini paces the turns inside one itself. 16-bit mono, so an even count. */
const SEGMENT_GAP = Buffer.alloc(Math.round(SAMPLE_RATE * 0.35) * 2);

export interface Speaker {
  name: string;
  voice: string;
  /** Overrides the reading's `style` for this speaker's turns. */
  style?: string;
}

export interface GeminiSpeech {
  text: string;
  voice: string;
  model: string;
  speakers?: Speaker[];
  style?: string;
}

interface Turn {
  speaker?: string;
  text: string;
}

/** A failure whose message is safe to show: it never carries the text being read. */
export class GeminiTtsError extends Error {}

export interface GeminiTtsOptions {
  encode?: (pcmPath: string, mp3Path: string, signal?: AbortSignal) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  chunkChars?: number;
}

export function parseDialogue(text: string, speakers: Speaker[]): Turn[] {
  const names = new Map(speakers.map((s) => [s.name.toLowerCase(), s.name]));
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    const name = colon > 0 ? names.get(trimmed.slice(0, colon).trim().toLowerCase()) : undefined;
    if (name) {
      turns.push({ speaker: name, text: trimmed.slice(colon + 1).trim() });
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.text += ` ${trimmed}`;
    } else {
      throw new GeminiTtsError(`dialogue must start with "<speaker>: ", speakers are ${speakers.map((s) => s.name).join(", ")}`);
    }
  }
  const spoken = turns.filter((t) => t.text);
  if (spoken.length === 0) throw new GeminiTtsError("dialogue has no lines");
  return spoken;
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["»)]*\s*|[^.!?…]+$/g) ?? [text];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > max) {
      pieces.push(current.trim());
      current = "";
    }
    current += sentence;
    while (current.length > max) {
      const cut = current.lastIndexOf(" ", max) > 0 ? current.lastIndexOf(" ", max) : max;
      pieces.push(current.slice(0, cut).trim());
      current = current.slice(cut);
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/**
 * Narration packs whole paragraphs, dialogue whole turns; only an oversized one is cut, at sentences.
 * A chunk is one request, so it also holds at most two speakers: `A B A C A B` reads as
 * `[A B A] [C A] [B]`, three requests for four voices.
 */
export function chunkTurns(turns: Turn[], max: number): Turn[][] {
  const pieces = turns.flatMap((turn) => splitLong(turn.text, max).map((text) => ({ speaker: turn.speaker, text })));
  const chunks: Turn[][] = [];
  let current: Turn[] = [];
  let size = 0;
  const voices = new Set<string | undefined>();
  for (const piece of pieces) {
    const tooManyVoices = !voices.has(piece.speaker) && voices.size >= SPEAKERS_PER_REQUEST;
    if (current.length > 0 && (size + piece.text.length > max || tooManyVoices)) {
      chunks.push(current);
      current = [];
      size = 0;
      voices.clear();
    }
    current.push(piece);
    size += piece.text.length;
    voices.add(piece.speaker);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function narrationTurns(text: string): Turn[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => ({ text: p }));
}

function requestBody(chunk: Turn[], speech: GeminiSpeech): unknown {
  const byName = new Map((speech.speakers ?? []).map((s) => [s.name, s]));
  const present = [...new Set(chunk.map((t) => t.speaker))].flatMap((name) => byName.get(name ?? "") ?? []);
  const styleOf = (speaker?: Speaker): string | undefined => speaker?.style ?? speech.style;
  const style = (value: string | undefined) => (value ? { style: value } : {});
  // A chunk where one speaker talks alone is a plain reading in that speaker's voice.
  const conversational = present.length === SPEAKERS_PER_REQUEST;
  const content = conversational
    ? chunk.map((turn) => ({
        type: "text",
        text: turn.text,
        annotations: [{ type: "speech_metadata", speaker: turn.speaker, ...style(styleOf(byName.get(turn.speaker!))) }],
      }))
    : [{
        type: "text",
        text: chunk.map((t) => t.text).join("\n\n"),
        ...(styleOf(present[0]) ? { annotations: [{ type: "speech_metadata", ...style(styleOf(present[0])) }] } : {}),
      }];
  return {
    model: speech.model,
    input: [{ type: "user_input", content }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: SAMPLE_RATE },
    generation_config: {
      speech_config: conversational
        ? { mode: "conversational", speakers: present.map((s) => ({ speaker: s.name, voice: s.voice })) }
        : [{ voice: present[0]?.voice ?? speech.voice }],
    },
  };
}

interface InteractionResponse {
  steps?: { type?: string; content?: { type?: string; data?: string }[] }[];
  error?: { message?: string };
}

function audioOf(response: InteractionResponse): Uint8Array {
  const blocks = (response.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((c) => c.type === "audio" && c.data);
  const last = blocks.at(-1);
  if (!last?.data) throw new GeminiTtsError("the response carried no audio");
  return Buffer.from(last.data, "base64");
}

function errorMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as InteractionResponse).error?.message;
    if (message) return message.slice(0, 300);
  } catch {}
  return "no detail";
}

/** "retry in 4h6m13s" (the daily free quota, 2026-10-08), "retryDelay": "12s", or a Retry-After header. */
function retryDelayMs(response: Response, body: string): number {
  const header = Number(response.headers.get("retry-after"));
  if (header > 0) return header * 1000;
  const duration = /retry(?:Delay"?\s*:\s*"|\s+in\s+)([\d.hms]+)/i.exec(body)?.[1] ?? "";
  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
  let ms = 0;
  for (const [, value, unit] of duration.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) ms += Number(value) * (unitMs[unit!] ?? 0);
  return ms > 0 ? ms : RATE_LIMIT_WAIT_MS;
}

async function encodeMp3(pcmPath: string, mp3Path: string, signal?: AbortSignal): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", pcmPath,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a", "libmp3lame", "-b:a", "128k", mp3Path,
  ], { timeout: ENCODE_TIMEOUT_MS, killSignal: "SIGKILL", signal });
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class GeminiTts {
  private readonly encode: NonNullable<GeminiTtsOptions["encode"]>;
  private readonly wait: NonNullable<GeminiTtsOptions["sleep"]>;
  private readonly chunkChars: number;

  constructor(options: GeminiTtsOptions = {}) {
    this.encode = options.encode ?? encodeMp3;
    this.wait = options.sleep ?? sleep;
    this.chunkChars = options.chunkChars ?? CHUNK_CHARS;
  }

  async generate(speech: GeminiSpeech, signal?: AbortSignal): Promise<TTSResult> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new GeminiTtsError("GEMINI_API_KEY not set: add a Gemini API key to .env, or set voice.tts.provider to edge");
    const turns = speech.speakers ? parseDialogue(speech.text, speech.speakers) : narrationTurns(speech.text);
    const chunks = chunkTurns(turns, this.chunkChars);
    if (chunks.length > GEMINI_DAILY_REQUESTS) {
      throw new GeminiTtsError(
        `needs ${chunks.length} requests, the free tier allows ${GEMINI_DAILY_REQUESTS} per day: ` +
        "shorten the text or use fewer speaker changes",
      );
    }

    // One failed chunk stops the others: a reading with a hole in it is not an answer.
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const dir = await mkdtemp(join(tmpdir(), "tts-"));
    try {
      const pcm = await mapLimit(chunks, CONCURRENCY, (chunk) => this.synthesize(chunk, speech, apiKey, controller.signal))
        .catch((err: unknown) => {
          controller.abort();
          throw err;
        });
      rethrowIfAborted(undefined, signal);
      const pcmPath = join(dir, "speech.pcm");
      const mp3Path = join(dir, "output.mp3");
      await writeFile(pcmPath, Buffer.concat(pcm.flatMap((piece, i) => (i === 0 ? [piece] : [SEGMENT_GAP, piece]))));
      await this.encode(pcmPath, mp3Path, signal);
      await rm(pcmPath, { force: true });
      return { path: mp3Path, mimeType: "audio/mpeg" };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (signal?.aborted) throw new AbortedError();
      throw err;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  }

  private async synthesize(chunk: Turn[], speech: GeminiSpeech, apiKey: string, signal: AbortSignal): Promise<Uint8Array> {
    const body = JSON.stringify(requestBody(chunk, speech));
    for (let attempt = 1; ; attempt++) {
      rethrowIfAborted(undefined, signal);
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      }).catch((err: unknown) => {
        if (signal.aborted) throw new AbortedError();
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new GeminiTtsError(`no answer after ${REQUEST_TIMEOUT_MS / 1000}s`);
        }
        throw new GeminiTtsError("Gemini is not answering");
      });
      if (response.ok) return audioOf(await response.json() as InteractionResponse);
      const text = await response.text().catch(() => "");
      // A per-minute limit is waited out; a daily quota (hours away) fails now, with Google's own words.
      const delay = response.status === 429 ? retryDelayMs(response, text) : 0;
      if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS && delay <= RATE_LIMIT_MAX_WAIT_MS) {
        await this.wait(delay, signal);
        continue;
      }
      throw new GeminiTtsError(`HTTP ${response.status}: ${errorMessage(text)}`);
    }
  }
}
