import type { ResolvedLlmConfig } from "../core/config.ts";
import { AbortedError } from "../core/aborted.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";

const LLM_RETRY_ATTEMPTS = 3;
const LLM_RETRY_BASE_MS = 500;
const LLM_RETRY_MAX_MS = 30_000;
const LLM_RETRY_JITTER = 0.15;
const LLM_TIMEOUT_MS = 120_000;
const LLM_STREAM_TIMEOUT_MS = 300_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

const circuitState = {
  failures: 0,
  openedAt: 0,
};

function checkCircuitBreaker(): void {
  if (circuitState.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    const elapsed = Date.now() - circuitState.openedAt;
    if (elapsed < CIRCUIT_BREAKER_COOLDOWN_MS) {
      throw new Error(`LLM circuit breaker open (${CIRCUIT_BREAKER_THRESHOLD} consecutive failures). Retry in ${Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000)}s.`);
    }
    circuitState.failures = 0;
  }
}

function recordCircuitSuccess(): void {
  if (circuitState.failures > 0) {
    hooks.emit("llm:circuit:closed", {});
  }
  circuitState.failures = 0;
}

function recordCircuitFailure(): void {
  circuitState.failures += 1;
  if (circuitState.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitState.openedAt = Date.now();
    hooks.emit("llm:circuit:opened", { failures: circuitState.failures, cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS });
    void log("warn", `LLM circuit breaker opened after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`);
  }
}

export function resetCircuitBreaker(): void {
  circuitState.failures = 0;
  circuitState.openedAt = 0;
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
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: LlmUsage;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

function buildRequestBody(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  stream?: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
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

function normalizeUsage(raw?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number }): LlmUsage | undefined {
  if (!raw) return undefined;
  const prompt = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const completion = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const total = raw.total_tokens ?? prompt + completion;
  if (prompt === 0 && completion === 0) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
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
  checkCircuitBreaker();

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
          const err = new Error(`LLM request failed: HTTP ${response.status} — ${detail}`);

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

      recordCircuitSuccess();
      return {
        content: choice.message.content ?? "",
        toolCalls: parseToolCalls(choice.message.tool_calls),
        usage: normalizeUsage(data.usage),
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
      recordCircuitFailure();
      throw lastErr;
    } finally {
      clearTimeout(timeout);
    }
  }

  recordCircuitFailure();
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
): Promise<LlmResponse> {
  checkCircuitBreaker();

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
    const timeout = setTimeout(() => controller.abort(), LLM_STREAM_TIMEOUT_MS);
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: fetchSignal });

      if (!response.ok) {
        const detail = await readErrorBody(response);
        const err = new Error(`LLM stream request failed: HTTP ${response.status} — ${detail}`);

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
      let streamUsage: LlmUsage | undefined;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

      const handleChunk = async (payload: ChatCompletionStreamChunk): Promise<void> => {
        if (payload.usage) {
          streamUsage = normalizeUsage(payload.usage);
        }

        const delta = payload.choices?.[0]?.delta;
        if (!delta) return;

        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
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

      recordCircuitSuccess();
      return {
        content,
        toolCalls: streamedToolCalls.length > 0 ? streamedToolCalls : undefined,
        usage: streamUsage,
      };
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") {
        lastErr = new Error(`LLM stream timed out after ${LLM_STREAM_TIMEOUT_MS}ms`);
      }
      if (attempt < LLM_RETRY_ATTEMPTS && !tokensDelivered && isTransientError(err)) {
        const delay = retryDelay(attempt);
        await log("warn", `LLM stream transient error, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay);
        continue;
      }
      recordCircuitFailure();
      throw lastErr;
    } finally {
      clearTimeout(timeout);
    }
  }

  recordCircuitFailure();
  throw lastErr;
}
