import { pipeline } from "@huggingface/transformers";
import type { EmbeddingConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";

type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

const HTTP_TIMEOUT_MS = 30_000;

let ready = false;
let localFailed = false;
let localPipe: FeatureExtractor | null = null;
let localModel = "";

/** True once warm-up finished (or there is nothing to warm). */
export function isEmbeddingReady(): boolean {
  return ready;
}

/** True when a model is configured (semantic recall is possible). */
export function isEmbeddingEnabled(cfg?: EmbeddingConfig): boolean {
  return Boolean(cfg?.model);
}

/**
 * Identity of the current embedding model, stored per vector.
 * Two different models are incompatible even at equal dimensions (different vector
 * space), so cosine must only compare vectors carrying the same signature.
 */
export function embeddingSignature(cfg?: EmbeddingConfig): string | null {
  if (!cfg?.model) return null;
  return cfg.dimensions ? `${cfg.model}@${cfg.dimensions}` : cfg.model;
}

async function getLocalPipeline(model: string): Promise<FeatureExtractor> {
  if (localPipe && localModel === model) return localPipe;
  localPipe = (await pipeline("feature-extraction", model)) as unknown as FeatureExtractor;
  localModel = model;
  return localPipe;
}

/**
 * Preload the embedding backend at boot so the first recall is not slow.
 * Non-blocking by design: callers should not await this on the hot path.
 * Local models download on first use; until ready, recall falls back to FTS5.
 */
export async function warmupEmbedding(cfg?: EmbeddingConfig): Promise<void> {
  if (!cfg?.model || cfg.backend !== "local") {
    // http/none: nothing to preload (provider handles its own cold start).
    ready = true;
    return;
  }
  try {
    await getLocalPipeline(cfg.model);
    await embedLocal("warmup", cfg);
    ready = true;
    void log("info", "memory embedding ready", { backend: "local", model: cfg.model });
  } catch (err) {
    localFailed = true;
    ready = true;
    void log("warn", "memory embedding warm-up failed, falling back to FTS5", {
      model: cfg.model,
      error: String(err),
    });
  }
}

function normalizeInPlace(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
  }
  return vec;
}

function truncate(vec: Float32Array, dimensions?: number): Float32Array {
  if (!dimensions || dimensions <= 0 || dimensions >= vec.length) return vec;
  return normalizeInPlace(vec.slice(0, dimensions));
}

async function embedLocal(text: string, cfg: EmbeddingConfig): Promise<Float32Array> {
  const pipe = await getLocalPipeline(cfg.model!);
  const out = await pipe(text, { pooling: "mean", normalize: true });
  const data = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  return truncate(data, cfg.dimensions);
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

async function embedHttp(text: string, cfg: EmbeddingConfig): Promise<Float32Array | null> {
  if (!cfg.baseUrl) return null;
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  const body: Record<string, unknown> = { model: cfg.model, input: text };
  if (cfg.dimensions) body["dimensions"] = cfg.dimensions;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      void log("warn", "memory embedding http failed", { status: res.status });
      return null;
    }
    const json = (await res.json()) as EmbeddingResponse;
    const arr = json.data?.[0]?.embedding;
    if (!arr || arr.length === 0) return null;
    return truncate(new Float32Array(arr), cfg.dimensions);
  } catch (err) {
    void log("warn", "memory embedding http error", { error: String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Embed text into a normalized vector, or null if embeddings are unavailable.
 * Null triggers FTS5-only recall for that call (graceful degradation).
 */
export async function embed(text: string, cfg?: EmbeddingConfig): Promise<Float32Array | null> {
  if (!cfg?.model) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (cfg.backend === "local") {
    if (localFailed) return null;
    if (!ready && !localPipe) return null; // not warmed yet -> FTS fallback
    try {
      return await embedLocal(trimmed, cfg);
    } catch (err) {
      void log("warn", "memory embedding local error", { error: String(err) });
      return null;
    }
  }

  return embedHttp(trimmed, cfg);
}

/** Cosine similarity. Assumes finite vectors; returns 0 on shape mismatch. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Test helper: reset module state. */
export function resetEmbeddingState(): void {
  ready = false;
  localFailed = false;
  localPipe = null;
  localModel = "";
}
