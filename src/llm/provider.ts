import type { ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError } from "../core/aborted.ts";
import { ReasoningSegmenter, type ReasoningSegment } from "./reasoning-segments.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";

const LLM_RETRY_ATTEMPTS = 3;
const LLM_RETRY_BASE_MS = 500;
const LLM_RETRY_MAX_MS = 30_000;
const LLM_RETRY_JITTER = 0.15;
const LLM_TIMEOUT_MS = 120_000;
/**
 * Silence, not duration. The old budget covered the whole stream, so a reasoning model still
 * writing at five minutes was cut off mid-answer, and nothing retries once tokens have shipped.
 * What has to be caught is a connection that stopped producing, which this timer measures.
 */
const LLM_STREAM_IDLE_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

/**
 * One breaker per endpoint, not one for the whole process. A single llama.cpp that died used to
 * open the only breaker there was and refuse every chat, including the ones pinned on a cloud
 * provider that was answering perfectly, for a full minute.
 */
const circuits = new Map<string, { failures: number; openedAt: number }>();

function circuitFor(baseUrl: string): { failures: number; openedAt: number } {
  let state = circuits.get(baseUrl);
  if (!state) {
    state = { failures: 0, openedAt: 0 };
    circuits.set(baseUrl, state);
  }
  return state;
}

/**
 * Exported because the breaker is per endpoint, not per transport: the Codex and Anthropic
 * transports call the same three helpers so that one dead endpoint stops being hammered whichever
 * wire protocol reaches it. Keeping them private meant a subscription outage retried on every turn
 * for as long as it lasted.
 */
export function checkCircuitBreaker(baseUrl: string): void {
  const circuitState = circuitFor(baseUrl);
  if (circuitState.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    const elapsed = Date.now() - circuitState.openedAt;
    if (elapsed < CIRCUIT_BREAKER_COOLDOWN_MS) {
      throw new Error(`LLM circuit breaker open (${CIRCUIT_BREAKER_THRESHOLD} consecutive failures). Retry in ${Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000)}s.`);
    }
    circuitState.failures = 0;
  }
}

export function recordCircuitSuccess(baseUrl: string): void {
  const circuitState = circuitFor(baseUrl);
  if (circuitState.failures > 0) {
    hooks.emit("llm:circuit:closed", { baseUrl });
  }
  circuitState.failures = 0;
}

export function recordCircuitFailure(baseUrl: string): void {
  const circuitState = circuitFor(baseUrl);
  circuitState.failures += 1;
  if (circuitState.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitState.openedAt = Date.now();
    hooks.emit("llm:circuit:opened", { failures: circuitState.failures, cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS, baseUrl });
    void log("warn", `LLM circuit breaker opened after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`, { baseUrl });
  }
}

export function resetCircuitBreaker(): void {
  circuits.clear();
}

// A non-retryable 4xx (e.g. one malformed request) is request-specific, not a provider outage:
// counting it would let a single bad call push the breaker toward opening for ALL traffic.
export function countsTowardBreaker(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function* readStream(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isTransientError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const code = (err as { code?: string })?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = (err as Error)?.message ?? "";
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg);
}

export type ChatMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatMessageContent[] }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmUsage {
  // Every input token, cached ones included. Providers disagree on whether their own prompt
  // counter includes the cache buckets, so this field is normalised to always include them:
  // fresh input is promptTokens - cacheReadTokens - cacheWriteTokens.
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: LlmUsage;
  /** What the model thought, when the endpoint reports it. Display only -- docs/reasoning-visibility.md. */
  reasoning?: string;
  /**
   * The same answer cut where the thinking restarted, set only when there is more than one phase.
   * The live stream splits its bubbles there, so the replay has to know where the cuts were or a
   * reopened conversation glues them back into one -- docs/reasoning-visibility.md.
   */
  segments?: ReasoningSegment[];
  // A proxy that bills us can report the authoritative figure for the call it just served.
  // Preferred over any price table when present and positive.
  proxyCostUsd?: number;
  // The endpoint the proxy actually forwarded to, which is what determines the real tariff.
  upstreamApiBase?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The union of every usage shape the OpenAI-compatible endpoints in use actually emit. The cache
 * fields are the reason this type exists: they were previously undeclared, so `normalizeUsage`
 * could not see them and prompt caching had no instrumentation at all.
 */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  // Anthropic-style, passed straight through by some proxies instead of being folded into
  // prompt_tokens_details.
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // DeepSeek names it differently again.
  prompt_cache_hit_tokens?: number;
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: RawUsage;
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: RawUsage;
}

/**
 * The names an OpenAI-compatible endpoint may use for reasoning, most specific first. Only the
 * first non-empty one is read: some proxies send two of them carrying the same text, and
 * concatenating both would double every thought. `opencode-go` is on record returning `reasoning`
 * rather than `reasoning_content` for some models, so the fallback is not theoretical.
 * See docs/reasoning-visibility.md.
 */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** The reasoning carried by one delta or message object, or "" when it carries none. */
export function readReasoning(source: Record<string, unknown> | undefined): string {
  if (!source) return "";
  for (const field of REASONING_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

const EPHEMERAL_CACHE = { type: "ephemeral" as const };

type WireMessage = Record<string, unknown>;

// Flatten a ChatMessage to the wire object, preserving role-specific fields.
function toWireMessage(msg: ChatMessage): WireMessage {
  const w: WireMessage = { role: msg.role, content: msg.content };
  if (msg.role === "tool") w["tool_call_id"] = msg.tool_call_id;
  if (msg.role === "assistant" && msg.tool_calls) w["tool_calls"] = msg.tool_calls;
  return w;
}

// Attach a cache breakpoint to a message's content. cache_control lives on a content *part*,
// so a string is promoted to a single text part; an array gets the marker on its last part.
// An empty string cannot carry a breakpoint (no block to cache) — left untouched.
function markCacheBreakpoint(w: WireMessage): void {
  const content = w["content"];
  if (typeof content === "string") {
    if (content.length === 0) return;
    w["content"] = [{ type: "text", text: content, cache_control: EPHEMERAL_CACHE }];
    return;
  }
  if (Array.isArray(content) && content.length > 0) {
    const parts = content.map((p) => ({ ...(p as Record<string, unknown>) }));
    parts[parts.length - 1]!["cache_control"] = EPHEMERAL_CACHE;
    w["content"] = parts;
  }
}

/**
 * Add Anthropic-style prompt-cache breakpoints for proxies that honor them (LiteLLM, OpenRouter).
 * Two breakpoints (well under Anthropic's max of 4): the first system message — the big stable
 * prefix (core + skills + tool list), built once per run so it is identical across every tool
 * iteration — and the last message, so the growing conversation is cached incrementally. Endpoints
 * that don't support caching ignore the extra `cache_control` field; gate it per provider because
 * some strict ones reject unknown fields in content.
 */
export function applyPromptCache(messages: ChatMessage[]): WireMessage[] {
  const wire = messages.map(toWireMessage);
  const sysIdx = wire.findIndex((m) => m["role"] === "system");
  if (sysIdx >= 0) markCacheBreakpoint(wire[sysIdx]!);
  const lastIdx = wire.length - 1;
  if (lastIdx >= 0 && lastIdx !== sysIdx) markCacheBreakpoint(wire[lastIdx]!);
  return wire;
}

function buildRequestBody(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  stream?: boolean,
): Record<string, unknown> {
const body: Record<string, unknown> = {
  model: config.apiModel ?? config.model,
    messages: config.promptCache ? applyPromptCache(messages) : messages,
  };

  if (tools && tools.length > 0) {
    body["tools"] = tools;
  }
  if (stream) {
    body["stream"] = true;
    body["stream_options"] = { include_usage: true };
  }
  if (config.limit?.output) {
    body["max_tokens"] = config.limit.output;
  }
  // Only set when the resolver decided this model should receive it (see supportsEffort).
  if (config.effort) {
    body["reasoning_effort"] = config.effort;
  }
  // An endpoint the owner pinned in the picker (docs/model-identity.md). Fallbacks are off on
  // purpose: the point of pinning is the price and the data policy of that one endpoint, and a
  // silent reroute to another would defeat both. Only ever set for OpenRouter.
  if (config.providerRoute) {
    body["provider"] = { order: [config.providerRoute], allow_fallbacks: false };
  }

  return body;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    const trimmed = body.slice(0, 500);
    try {
      const json = JSON.parse(trimmed);
      return json?.error?.message ?? json?.message ?? trimmed;
    } catch {
      return trimmed;
    }
  } catch {
    return "(unreadable)";
  }
}

function retryDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, LLM_RETRY_MAX_MS);
  const base = LLM_RETRY_BASE_MS * Math.pow(2, attempt - 1);
  const clamped = Math.min(base, LLM_RETRY_MAX_MS);
  return clamped * (1 + (Math.random() * 2 - 1) * LLM_RETRY_JITTER);
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function safeJsonParse(raw: string, label: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    log("warn", `Failed to parse ${label} JSON: ${(err as Error).message}`, { raw: raw.slice(0, 200) }).catch(() => {});
    return {};
  }
}

function normalizeUsage(raw?: RawUsage): LlmUsage | undefined {
  if (!raw) return undefined;
  const completion = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = raw.prompt_tokens_details?.cache_creation_tokens ?? raw.cache_creation_input_tokens ?? 0;

  // OpenAI-style prompt_tokens already counts the cached tokens; Anthropic-style input_tokens
  // counts only the fresh ones and reports the cache buckets alongside. Normalise to "all input".
  const declared = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const prompt = raw.prompt_tokens !== undefined ? declared : declared + cacheRead + cacheWrite;

  if (prompt === 0 && completion === 0) return undefined;
  const usage: LlmUsage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: raw.total_tokens ?? prompt + completion,
  };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

/**
 * LiteLLM reports what it billed, and which endpoint it forwarded to, as response headers on the
 * completion route itself -- reachable with a virtual key that is denied the admin routes.
 * A cost of 0 is ambiguous (free plan, or no price configured), so it is only carried when positive.
 */
function readProxyHeaders(response: Response): { proxyCostUsd?: number; upstreamApiBase?: string } {
  const out: { proxyCostUsd?: number; upstreamApiBase?: string } = {};
  const cost = Number(response.headers.get("x-litellm-response-cost-original") ?? response.headers.get("x-litellm-response-cost"));
  if (Number.isFinite(cost) && cost > 0) out.proxyCostUsd = cost;
  const upstream = response.headers.get("x-litellm-model-api-base");
  if (upstream) out.upstreamApiBase = upstream;
  return out;
}

function parseToolCalls(
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>,
): ToolCall[] | undefined {
  return toolCalls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeJsonParse(tc.function.arguments, "tool_call.arguments"),
  }));
}

export async function chatCompletion(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  checkCircuitBreaker(config.baseUrl);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  };
  const body = JSON.stringify(buildRequestBody(config, messages, tools));
  const url = `${config.baseUrl}/chat/completions`;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= LLM_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: fetchSignal });

        if (!response.ok) {
          const detail = await readErrorBody(response);
          const err = new Error(`LLM request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
          err.status = response.status;

          if (attempt < LLM_RETRY_ATTEMPTS && RETRYABLE_STATUS.has(response.status)) {
            const delay = retryDelay(attempt, parseRetryAfterMs(response));
            hooks.emit("llm:call:error", { model: config.model, error: err, attempt, willRetry: true });
            await log("warn", `LLM ${response.status}, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS})`);
            await sleep(delay);
            lastErr = err;
            continue;
          }
          hooks.emit("llm:call:error", { model: config.model, error: err, attempt, willRetry: false });
          throw err;
        }

      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices[0];
      if (!choice?.message) throw new Error("No response from LLM");

      recordCircuitSuccess(config.baseUrl);
      const reasoning = readReasoning(choice.message as Record<string, unknown>);
      return {
        content: choice.message.content ?? "",
        toolCalls: parseToolCalls(choice.message.tool_calls),
        usage: normalizeUsage(data.usage),
        ...(reasoning ? { reasoning } : {}),
        ...readProxyHeaders(response),
      };
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") {
        lastErr = new Error(`LLM request timed out after ${LLM_TIMEOUT_MS}ms`);
      }
      if (attempt < LLM_RETRY_ATTEMPTS && isTransientError(err)) {
        const delay = retryDelay(attempt);
        await log("warn", `LLM transient error, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay);
        continue;
      }
      if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
      throw lastErr;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
  throw lastErr;
}

function idToIndex(id: string, existing: Map<number, unknown>): number {
  for (const [idx, entry] of existing) {
    if ((entry as { id?: string }).id === id) return idx;
  }
  let next = 0;
  while (existing.has(next)) next++;
  return next;
}

export async function chatCompletionStream(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  checkCircuitBreaker(config.baseUrl);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  };
  const body = JSON.stringify(buildRequestBody(config, messages, tools, true));
  const url = `${config.baseUrl}/chat/completions`;

  let lastErr: unknown;
  let tokensDelivered = false;

  for (let attempt = 1; attempt <= LLM_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), LLM_STREAM_IDLE_TIMEOUT_MS);
    const keepAlive = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), LLM_STREAM_IDLE_TIMEOUT_MS);
    };
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: fetchSignal });

      if (!response.ok) {
        const detail = await readErrorBody(response);
        const err = new Error(`LLM stream request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
        err.status = response.status;

        if (attempt < LLM_RETRY_ATTEMPTS && !tokensDelivered && RETRYABLE_STATUS.has(response.status)) {
          const delay = retryDelay(attempt, parseRetryAfterMs(response));
          await log("warn", `LLM stream ${response.status}, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS})`);
          await sleep(delay);
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (!response.body) {
        throw new Error("LLM stream response has no body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      const segmenter = new ReasoningSegmenter();
      let streamUsage: LlmUsage | undefined;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

      const handleChunk = async (payload: ChatCompletionStreamChunk): Promise<void> => {
        if (payload.usage) {
          streamUsage = normalizeUsage(payload.usage);
        }

        const delta = payload.choices?.[0]?.delta;
        if (!delta) return;

        const reasoningDelta = readReasoning(delta as Record<string, unknown>);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          segmenter.reasoning(reasoningDelta);
          if (reasoningSink?.onText) await reasoningSink.onText(reasoningDelta);
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          segmenter.text(delta.content);
          tokensDelivered = true;
          await onToken(delta.content);
        }

        for (const toolCall of delta.tool_calls ?? []) {
          const index = toolCall.index ?? (typeof toolCall.id === "string" ? idToIndex(toolCall.id, toolCalls) : 0);
          const entry = toolCalls.get(index) ?? { id: `call_${index}`, name: "", arguments: "" };
          if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
            entry.id = toolCall.id;
          }
          if (typeof toolCall.function?.name === "string" && toolCall.function.name.length > 0) {
            entry.name += toolCall.function.name;
          }
          if (typeof toolCall.function?.arguments === "string" && toolCall.function.arguments.length > 0) {
            entry.arguments += toolCall.function.arguments;
          }
          toolCalls.set(index, entry);
        }
      };

      for await (const chunk of readStream(response.body)) {
        keepAlive();
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);

          if (rawLine.startsWith("data: ")) {
            const data = rawLine.slice(6);
            if (data === "[DONE]") {
              buffer = "";
              break;
            }
            if (data) {
              const parsed = safeJsonParse(data, "SSE chunk");
              if (Object.keys(parsed).length > 0) {
                await handleChunk(parsed as ChatCompletionStreamChunk);
              }
            }
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }

      if (buffer.trim().startsWith("data: ")) {
        const remaining = buffer.trim().slice(6);
        if (remaining && remaining !== "[DONE]") {
          const parsed = safeJsonParse(remaining, "SSE tail");
          if (Object.keys(parsed).length > 0) {
            await handleChunk(parsed as ChatCompletionStreamChunk);
          }
        }
      }

      const streamedToolCalls = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, toolCall]) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: safeJsonParse(toolCall.arguments, "streamed tool_call.arguments"),
        }));

      recordCircuitSuccess(config.baseUrl);
      const segments = segmenter.list();
      return {
        content,
        toolCalls: streamedToolCalls.length > 0 ? streamedToolCalls : undefined,
        usage: streamUsage,
        ...(reasoning ? { reasoning } : {}),
        ...(segments ? { segments } : {}),
        ...readProxyHeaders(response),
      };
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") {
        lastErr = new Error(`LLM stream stalled for ${LLM_STREAM_IDLE_TIMEOUT_MS}ms`);
      }
      if (attempt < LLM_RETRY_ATTEMPTS && !tokensDelivered && isTransientError(err)) {
        const delay = retryDelay(attempt);
        await log("warn", `LLM stream transient error, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay);
        continue;
      }
      if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
      throw lastErr;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
  throw lastErr;
}
