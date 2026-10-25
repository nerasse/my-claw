import type * as Transformers from "@huggingface/transformers";
import type { EmbeddingConfig, LlmProviderConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { TRANSFORMERS_CACHE, transformersRuntime } from "../services/local-engines.ts";
import { providerBaseUrl } from "../llm/resolver.ts";

/**
 * transformers.js, imported the first time local embeddings run: the one dynamic import of the
 * server, by the owner's exception (2026-10-05, docs/services.md "Local engines"). It is not in
 * the release at all -- 440 MB with onnxruntime -- and a top-level import loaded it into every
 * server at boot, embeddings on or off.
 */
let transformers: Promise<typeof Transformers> | null = null;

function loadTransformers(): Promise<typeof Transformers> {
  const entry = transformersRuntime.entry();
  if (!entry) return Promise.reject(new Error("transformers.js is not installed"));
  transformers ??= import(entry).then((module: typeof Transformers) => {
    // Its default is inside its own node_modules: every update downloaded the model again.
    module.env.cacheDir = TRANSFORMERS_CACHE;
    return module;
  });
  return transformers;
}

type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

const HTTP_TIMEOUT_MS = 30_000;
/**
 * How many texts one `/embeddings` call carries. OpenAI-compatible endpoints take an array, and a
 * first-time backfill of a real store is hundreds of entries: one request each made switching model
 * a two-minute wait on 435 round trips (measuring 2026-10-25). Chunked rather than unbounded --
 * Gemini caps a batch by total input size, and a store can hold a single 40 kB entry.
 */
const EMBED_BATCH = 40;

/**
 * The live provider table, published the way the price table is: recall sits on the hot path of
 * every message and holds no config of its own. Read through the closure so a provider renamed,
 * disabled or given a new key applies on the next call, with no re-wiring.
 */
let providersOf: () => Record<string, LlmProviderConfig> = () => ({});

export function setEmbeddingProviders(read: () => Record<string, LlmProviderConfig>): void {
  providersOf = read;
}

/**
 * Where an embedding call goes, and what signs it.
 *
 * `from` is the whole point: a model the owner already pays for on a configured provider needs no
 * second URL and no second copy of the key. `baseUrl` stays for a server that is not a chat
 * provider of this install (a bare llama.cpp, an Ollama box).
 */
function endpointOf(cfg: EmbeddingConfig): { baseUrl?: string; apiKey?: string } {
  if (!cfg.from) {
    return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined };
  }
  const provider = providersOf()[cfg.from];
  if (!provider) return {};
  return {
    baseUrl: providerBaseUrl(provider) || undefined,
    apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined,
  };
}

let ready = false;
let localFailed = false;
let localPipe: FeatureExtractor | null = null;
let localModel = "";

/** True once warm-up finished (or there is nothing to warm). */
export function isEmbeddingReady(): boolean {
  return ready;
}

/**
 * Whether this config embeds at all: a model and not switched off. One check, in `embed` itself,
 * so no caller can forget it and so a consumer turned off keeps its model for when it is turned
 * back on.
 */
function usable(cfg?: EmbeddingConfig): boolean {
  return Boolean(cfg?.model) && cfg?.enabled !== false;
}

/** True when a model is configured (semantic recall is possible). */
export function isEmbeddingEnabled(cfg?: EmbeddingConfig): boolean {
  return usable(cfg);
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
  const { pipeline } = await loadTransformers();
  localPipe = (await pipeline("feature-extraction", model)) as unknown as FeatureExtractor;
  localModel = model;
  return localPipe;
}

/**
 * Preload the embedding backend at boot so the first recall is not slow.
 * Non-blocking by design: callers should not await this on the hot path.
 * Local models download on first use; until ready, recall falls back to FTS5.
 */
export async function warmupEmbedding(
  cfg?: EmbeddingConfig,
  runtime: Pick<typeof transformersRuntime, "prepare"> = transformersRuntime,
): Promise<void> {
  if (!cfg?.model || cfg.backend !== "local") {
    // http/none: nothing to preload (provider handles its own cold start).
    ready = true;
    return;
  }
  // Not installed yet: the install starts, recall stays on FTS5, and its end warms up again.
  if (!(await runtime.prepare())) {
    ready = false;
    return;
  }
  try {
    await getLocalPipeline(cfg.model);
    await embedLocal("warmup", cfg);
    ready = true;
    // A warm-up that works clears an earlier failure: the model was missing, or the download was
    // interrupted, and leaving the flag set would keep local embeddings dead until a restart.
    localFailed = false;
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
  data?: Array<{ embedding?: number[]; index?: number }>;
}

/**
 * One `/embeddings` call for a batch of texts, in order. The response carries an `index` per row
 * and providers do not promise to return them sorted, so ordering is read rather than assumed:
 * a misplaced vector indexes the wrong text forever, and nothing downstream could notice.
 */
async function requestEmbeddings(texts: string[], cfg: EmbeddingConfig): Promise<Float32Array[] | null> {
  const { baseUrl, apiKey } = endpointOf(cfg);
  if (!baseUrl) return null;
  const body: Record<string, unknown> = { model: cfg.model, input: texts };
  if (cfg.dimensions) body["dimensions"] = cfg.dimensions;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      void log("warn", "memory embedding http failed", { status: res.status, model: cfg.model, from: cfg.from });
      return null;
    }
    const json = (await res.json()) as EmbeddingResponse;
    const rows = json.data ?? [];
    if (rows.length === 0) return null;
    const out: Float32Array[] = new Array(rows.length);
    for (const [fallback, row] of rows.entries()) {
      const at = row.index ?? fallback;
      if (!row.embedding || row.embedding.length === 0 || at < 0 || at >= out.length) return null;
      out[at] = truncate(new Float32Array(row.embedding), cfg.dimensions);
    }
    // A hole means the endpoint answered fewer rows than it was asked for: refuse rather than
    // pair a text with somebody else's vector.
    return out.every((vec) => vec !== undefined) ? out : null;
  } catch (err) {
    void log("warn", "memory embedding http error", { error: String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function embedHttp(text: string, cfg: EmbeddingConfig): Promise<Float32Array | null> {
  const out = await requestEmbeddings([text], cfg);
  return out?.[0] ?? null;
}

/**
 * Embed text into a normalized vector, or null if embeddings are unavailable.
 * Null triggers FTS5-only recall for that call (graceful degradation).
 */
export async function embed(text: string, cfg?: EmbeddingConfig): Promise<Float32Array | null> {
  if (!usable(cfg)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const active = cfg as EmbeddingConfig;

  if (active.backend === "local") {
    if (localFailed) return null;
    if (!ready && !localPipe) return null; // not warmed yet -> FTS fallback
    try {
      return await embedLocal(trimmed, active);
    } catch (err) {
      void log("warn", "memory embedding local error", { error: String(err) });
      return null;
    }
  }

  return embedHttp(trimmed, active);
}

/**
 * Embed many texts at once, in order, with `null` under any text that could not be embedded. The
 * backfill is the caller that matters: hundreds of entries through one call per batch instead of
 * one call per entry. A batch the endpoint refuses falls back to asking one text at a time, so a
 * provider that only accepts a single input still works -- just as slowly as before.
 *
 * Local embeddings stay per-text: there is no network round trip to save, and the ONNX pipeline
 * already answers one call at a time.
 */
export async function embedMany(texts: string[], cfg?: EmbeddingConfig): Promise<Array<Float32Array | null>> {
  if (!usable(cfg)) return texts.map(() => null);
  const active = cfg as EmbeddingConfig;
  const trimmed = texts.map((t) => t.trim());
  if (active.backend === "local") {
    const out: Array<Float32Array | null> = [];
    for (const text of trimmed) out.push(await embed(text, active));
    return out;
  }
  const out: Array<Float32Array | null> = new Array(texts.length).fill(null);
  for (let start = 0; start < trimmed.length; start += EMBED_BATCH) {
    const slice = trimmed.slice(start, start + EMBED_BATCH);
    // An empty entry is not a question the endpoint can answer, and sending it would misalign the
    // indices of everything after it: it is skipped in place, never compacted away.
    const asked: number[] = [];
    const payload: string[] = [];
    for (const [offset, text] of slice.entries()) {
      if (!text) continue;
      asked.push(start + offset);
      payload.push(text);
    }
    if (payload.length === 0) continue;
    const vectors = payload.length === 1
      ? [await embedHttp(payload[0]!, active)]
      : await requestEmbeddings(payload, active) ?? await Promise.all(payload.map((text) => embedHttp(text, active)));
    for (const [offset, vec] of vectors.entries()) {
      const at = asked[offset];
      if (at !== undefined && vec) out[at] = vec;
    }
  }
  return out;
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
