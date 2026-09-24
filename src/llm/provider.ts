import type { ReasoningField, ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError, sleep } from "../core/aborted.ts";
import { isRetryableStatus, retryDelayMs, parseRetryAfterMs } from "./retry.ts";
import { ReasoningSegmenter, type ReasoningSegment } from "./reasoning-segments.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { openRouterEndpoints, openRouterEndpointLimits } from "./openrouter-endpoints.ts";
import { cacheDialectOf } from "./cache-policy.ts";
import { sessionAffinityHeaders, userAgent } from "./session-headers.ts";
import { OPENAI_TIMEOUT_MS, llmFetchInit, requestTimeoutMs, timeoutSourceOf } from "./request-timeout.ts";

const LLM_RETRY_ATTEMPTS = 3;
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

/**
 * Milliseconds this run may go without a byte. Silence, not duration: on the streaming path the
 * timer is re-armed at every token, so a reasoning model still writing at five minutes is never
 * cut off, while a connection that stopped producing is. On the non-streaming path nothing arrives
 * before the end, so the same budget is the total wall.
 *
 * Read from the run's own config, because 120 s is generous for a hosted endpoint and short for a
 * local model whose prefill on a long prompt is measured in minutes. `0` means no timer at all
 * and hands the wall to the owner's Stop -- docs/llm-timeout.md.
 */
function timeoutBudget(config: ResolvedLlmConfig): number {
  return requestTimeoutMs(config, OPENAI_TIMEOUT_MS);
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

/**
 * A reasoning item as the provider wants it handed back, opaque to us.
 *
 * The Responses API keeps the model's chain of thought server-side between calls only when
 * `store: true`. We send `store: false`, so unless the encrypted state is asked for and replayed,
 * every tool iteration arrives with the tool outputs and no memory of why the calls were made --
 * the model re-derives its plan from scratch on each of them. That is the shape of the wandering
 * measured here: a 142-iteration median against 19 for a model on a transport that does replay.
 * See docs/reasoning-replay.md.
 */
export interface ReasoningItem {
  id: string;
  /** Provider-encrypted thinking state. Never inspected, never logged, replayed verbatim. */
  encrypted?: string;
}

/**
 * Provider-scoped state attached to an assistant turn so the next call can hand it back.
 *
 * Tagged with the transport and model that produced it because these blobs are neither portable
 * nor forgeable: a `rs_` item from one model replayed to another is a 400. Prompt-side only --
 * this never reaches a session file, see docs/reasoning-replay.md.
 */
/**
 * An Anthropic thinking block, kept exactly as it arrived.
 *
 * The signature covers the model's full original thinking, not the summarized text shown here, so
 * the block is only valid replayed verbatim: Anthropic answers 400 to one that has been edited,
 * reordered or partially filtered.
 */
export interface ThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  /** The opaque payload of a `redacted_thinking` block, which carries no readable text. */
  data?: string;
}

export interface ProviderMeta {
  backend: string;
  model: string;
  /** OpenAI Responses reasoning items. */
  reasoning?: ReasoningItem[];
  /** Anthropic thinking blocks, in the order the model emitted them. */
  thinking?: ThinkingBlock[];
  /**
   * OpenAI-compatible chat: the prior reasoning in the shape this model declared it wants back.
   * `reasoning_content` takes the text; `reasoning_details` takes the structured array verbatim,
   * because that form exists precisely to carry encrypted and summarized blocks a string cannot.
   * Only ever one of the two, and only when the model published a field.
   */
  chat?: { field: ReasoningField; text?: string; details?: unknown[] };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatMessageContent[] }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      /**
       * Opaque provider state for the next call on the same transport. `toWireMessage` builds the
       * chat-completions payload field by field and does not copy it, so it cannot leak to a
       * protocol that has no slot for it.
       */
      providerMeta?: ProviderMeta;
    }
  // Content parts on a tool message are how a tool's images reach the model (a `read` of a PNG,
  // a screenshot). Each transport places them where its protocol allows: inside the tool_result
  // block on Anthropic, in function_call_output on Responses, and in a user turn after the tool
  // results on chat completions, whose tool message takes text only (`liftToolImages`).
  | { role: "tool"; tool_call_id: string; content: string | ChatMessageContent[] };

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
  /** Provider terminal state, when the wire protocol exposes one (stop, length, incomplete...). */
  finishReason?: string;
  /** The provider ended the turn before producing a final answer. */
  incomplete?: boolean;
  usage?: LlmUsage;
  /** What the model thought, when the endpoint reports it. Display only -- docs/reasoning-visibility.md. */
  reasoning?: string;
  /**
   * How long that thinking lasted.
   *
   * Set beside `reasoning`, for the single-phase turn: `segments` carries one duration per phase
   * when there is more than one, and `list()` stays `undefined` for a single segment so the log
   * does not double what `content` and `reasoning` already say.
   */
  reasoningMs?: number;
  /**
   * The same answer cut where the thinking restarted, set only when there is more than one phase.
   * The live stream splits its bubbles there, so the replay has to know where the cuts were or a
   * reopened conversation glues them back into one -- docs/reasoning-visibility.md.
   */
  segments?: ReasoningSegment[];
  // What the thing that billed us says this call cost: a proxy's response header, or the cost an
  // aggregator declares on `usage` in its own body. Preferred over any price table when positive.
  proxyCostUsd?: number;
  // The endpoint the proxy actually forwarded to, which is what determines the real tariff.
  upstreamApiBase?: string;
  /** Opaque state to hand back on the next call of the same run -- docs/reasoning-replay.md. */
  providerMeta?: ProviderMeta;
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
  /**
   * What the aggregator charged for this call, in USD. OpenRouter declares it here and nowhere
   * else: no response header carries it, and the per-generation route does not keep these ids.
   */
  cost?: number;
  /**
   * The call was served on the owner's own key at the upstream provider. OpenRouter then charges
   * nothing, so `cost` is 0 while the money was still spent -- `upstream_inference_cost` is where
   * it is.
   */
  is_byok?: boolean;
  cost_details?: {
    upstream_inference_cost?: number;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    finish_reason?: string | null;
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
    finish_reason?: string | null;
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

/**
 * The reasoning this turn produced, packaged for the next call, or nothing.
 *
 * Three conditions, all required: the provider's replay switch is on, the model published which
 * field it wants (`interleaved.field` on models.dev -- guessing one is how you send a body a strict
 * endpoint rejects), and the turn actually produced reasoning. See docs/reasoning-replay.md.
 */
function chatProviderMeta(
  config: ResolvedLlmConfig,
  message: Record<string, unknown> | undefined,
  text: string,
): ProviderMeta | undefined {
  if (config.reasoningReplay === false) return undefined;
  const field = config.reasoningField;
  if (!field) return undefined;
  const model = config.apiModel ?? config.model;
  if (field === "reasoning_details") {
    const details = message?.["reasoning_details"];
    // No string fallback: `reasoning` and `reasoning_content` are aliases of each other, but a
    // model asking for `reasoning_details` wants the structured array, which is the only form that
    // survives an encrypted or summarized block.
    return Array.isArray(details) && details.length > 0
      ? { backend: "openai", model, chat: { field, details } }
      : undefined;
  }
  // DeepSeek returns an empty `reasoning_content` on turns it did not think through, and that
  // empty string still has to go back, so the test is "did the turn reason at all", not "is it
  // non-empty".
  return text.length > 0 ? { backend: "openai", model, chat: { field, text } } : undefined;
}

function chatIdentity(config: ResolvedLlmConfig): { backend: string; model: string } {
  return { backend: "openai", model: config.apiModel ?? config.model };
}

const EPHEMERAL_CACHE = { type: "ephemeral" as const };

type WireMessage = Record<string, unknown>;

/**
 * A tool's images, moved to where chat completions can carry them -- docs/tool-images.md.
 *
 * The spec types a tool message's content as `string | Array<text part>`, never an image. A
 * tolerant upstream takes one anyway, a strict one answers 422: OpenCode Go routes each session to
 * one upstream, so the same model worked in one conversation and failed every retry in another
 * (`messages.3.tool.content.str: Input should be a valid string`, measured 2026-09-24).
 *
 * So each tool message keeps its text, and the images of one turn follow its last tool result in a
 * single user turn, naming the call each came from. The tool results stay contiguous after the
 * assistant that asked for them, which is what every endpoint checks. Derived from the history on
 * every call, so the same history always sends the same prefix and the prompt cache holds.
 */
function liftToolImages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const names = new Map<string, string>();
  let lifted: ChatMessageContent[] = [];
  const flush = (): void => {
    if (lifted.length === 0) return;
    out.push({ role: "user", content: [{ type: "text", text: "Images returned by the tool calls above:" }, ...lifted] });
    lifted = [];
  };
  for (const msg of messages) {
    if (msg.role !== "tool") flush();
    if (msg.role === "assistant") for (const tc of msg.tool_calls ?? []) names.set(tc.id, tc.function.name);
    if (msg.role !== "tool" || typeof msg.content === "string") {
      out.push(msg);
      continue;
    }
    const images = msg.content.filter((part) => part.type === "image_url");
    const text = msg.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
    if (images.length > 0) {
      const name = names.get(msg.tool_call_id) ?? "tool";
      lifted.push({ type: "text", text: `${name} (call ${msg.tool_call_id}):` }, ...images);
    }
    out.push({ role: "tool", tool_call_id: msg.tool_call_id, content: text || "The image is in the next message." });
  }
  flush();
  return out;
}

/**
 * Flatten a ChatMessage to the wire object, preserving role-specific fields.
 *
 * Field by field, never a spread: `ChatMessage` carries `providerMeta`, which is internal state and
 * must not reach any endpoint except through the one branch below that knows the shape it wants.
 */
function toWireMessage(msg: ChatMessage, self?: { backend: string; model: string }): WireMessage {
  const w: WireMessage = { role: msg.role, content: msg.content };
  if (msg.role === "tool") w["tool_call_id"] = msg.tool_call_id;
  if (msg.role === "assistant" && msg.tool_calls) w["tool_calls"] = msg.tool_calls;
  if (msg.role === "assistant") {
    const meta = msg.providerMeta;
    // Same model, same transport, as on the other two: reasoning state belongs to the model that
    // produced it. DeepSeek answers 400 without the field when tools are present; GLM and Kimi
    // degrade quietly. Self-gating beyond that -- nothing is captured for a model that publishes
    // no field, so nothing is sent.
    const chat = meta && self && meta.backend === self.backend && meta.model === self.model ? meta.chat : undefined;
    if (chat?.field === "reasoning_details" && chat.details) w["reasoning_details"] = chat.details;
    else if (chat?.field === "reasoning_content" && chat.text !== undefined) w["reasoning_content"] = chat.text;
  }
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
export function applyPromptCache(messages: ChatMessage[], self?: { backend: string; model: string }): WireMessage[] {
  const wire = messages.map((m) => toWireMessage(m, self));
  const sysIdx = wire.findIndex((m) => m["role"] === "system");
  if (sysIdx >= 0) markCacheBreakpoint(wire[sysIdx]!);
  const lastIdx = wire.length - 1;
  if (lastIdx >= 0 && lastIdx !== sysIdx) markCacheBreakpoint(wire[lastIdx]!);
  return wire;
}

/**
 * Endpoints that refused the content-part form, per model.
 *
 * `promptCache` promotes a message's content to `[{type:"text", text, cache_control}]`, because a
 * cache breakpoint lives on a part. Some upstreams validate the shape strictly and answer 400 --
 * "Input should be a valid string, field: 'messages[0].content.str'" -- which is what a research
 * pass died on four times on 2026-09-21 (`opencode_go/glm-5.3`), while the same provider's
 * deepseek models take the same request happily.
 *
 * The refusal is a fact about that model, so it is remembered and the hints stop being sent for
 * it: one failed round trip ever, instead of one per call. The memo is per process on purpose --
 * it is a compatibility fact about a remote endpoint, not state worth persisting.
 */
const cacheHintsRefused = new Set<string>();

function cacheKeyOf(config: ResolvedLlmConfig): string {
  return `${config.baseUrl}|${config.apiModel ?? config.model}`;
}

/** Test seam: the memo is process-wide, and one file's refusal must not reach the next. */
export function resetCacheHintRefusals(): void {
  cacheHintsRefused.clear();
}

/** A 400 saying our content shape is wrong: the form the cache hints chose, not the request. */
export function isContentShapeRefusal(status: number, detail: string): boolean {
  if (status !== 400) return false;
  return /content\.str|should be a valid string|is not of type 'string'|messages\[\d+\]\.content/i.test(detail);
}

function buildRequestBody(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  stream?: boolean,
  cacheHints: boolean = config.promptCache === true,
): Record<string, unknown> {
  const sent = liftToolImages(messages);
  const body: Record<string, unknown> = {
    model: config.apiModel ?? config.model,
    // Always through `toWireMessage`, cache or no cache. Handing the raw `ChatMessage[]` to
    // JSON.stringify was putting `providerMeta` on the wire whenever prompt caching was off.
    messages: cacheHints
      ? applyPromptCache(sent, chatIdentity(config))
      : sent.map((m) => toWireMessage(m, chatIdentity(config))),
  };

  // An OpenAI-family engine ignores the `cache_control` breakpoints above and keys its implicit
  // prefix cache on this instead, whichever provider resells it. Gated on the same per-provider
  // opt-in as the breakpoints: it is an extra top-level field, and the opt-in is precisely the
  // owner stating this endpoint tolerates cache hints. See docs/prompt-caching.md.
  if (cacheHints && config.cacheKey && cacheDialectOf(config.apiModel ?? config.model) === "openai") {
    body["prompt_cache_key"] = config.cacheKey;
  }

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

/**
 * Clamp the output ask to what the pinned endpoint itself accepts.
 *
 * OpenRouter publishes, at the model level, the output ceiling of its *best* endpoint. Discovery
 * reads that number, so a run pinned to a lesser endpoint asks for more than the endpoint accepts:
 * OpenRouter drops it from the pool and, since a pin sets allow_fallbacks:false, reports the empty
 * pool as "404 No endpoints found" naming the model rather than the parameter that emptied it.
 * Measured live on deepseek-v4-flash pinned to streamlake/fp8: 384000 answers 200, 393216 (the
 * model-level figure) answers 404, everything else in the request being equal.
 *
 * Only ever lowers the ask, and only with evidence: no listing, or an endpoint that publishes no
 * ceiling, leaves the request exactly as it was.
 */
async function clampOutputToPinnedEndpoint(config: ResolvedLlmConfig, body: Record<string, unknown>): Promise<void> {
  const route = config.providerRoute;
  if (!route) return;

  // Awaited even when there is no ask to clamp: this is also what warms the endpoints cache for
  // the synchronous readers (window resolution, and the per-endpoint price a usage row is billed
  // at). A pinned run that never reached this call would be priced from the model-level table.
  const limits = await openRouterEndpointLimits(config.apiModel ?? config.model, route);

  const asked = body["max_tokens"];
  if (typeof asked !== "number") return;
  const ceiling = limits?.maxOutput;
  if (ceiling === undefined || asked <= ceiling) return;

  body["max_tokens"] = ceiling;
  void log("info", "clamped max_tokens to the pinned endpoint ceiling", {
    route,
    apiModel: config.apiModel ?? config.model,
    asked,
    ceiling,
  });
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

/**
 * OpenRouter uses the same 404 both for a removed pin and for an endpoint it temporarily excludes
 * from routing. Only the endpoint catalogue can separate them. An empty catalogue is inconclusive
 * because that helper deliberately degrades to [] when OpenRouter's metadata API is unavailable.
 */
async function pinnedRoute404(
  config: ResolvedLlmConfig,
  status: number,
  detail: string,
  body?: Record<string, unknown>,
): Promise<{ message: string; retryable: boolean } | undefined> {
  const route = config.providerRoute;
  if (!route || status !== 404 || !/no endpoints found|no allowed providers/i.test(detail)) return undefined;

  const endpoints = await openRouterEndpoints(config.apiModel ?? config.model);
  const routeIsListed = endpoints.some((endpoint) => endpoint.tag === route);
  const catalogueIsInconclusive = endpoints.length === 0;

  // OpenRouter drops an endpoint that cannot honour a requested parameter, then reports the empty
  // pool as a 404 naming the model -- never the parameter that emptied it. Only the request that
  // actually failed can name it, so the body's own shape is logged here. Values only, no content:
  // messages and tool schemas never reach the log.
  void log("warn", "pinned OpenRouter endpoint answered 404", {
    route,
    apiModel: config.apiModel ?? config.model,
    routeIsListed,
    listedTags: endpoints.map((endpoint) => endpoint.tag),
    detail,
    requestParams: Object.keys(body ?? {}),
    maxTokens: body?.["max_tokens"],
    reasoningEffort: body?.["reasoning_effort"],
    stream: body?.["stream"],
    promptCache: config.promptCache === true,
    toolCount: Array.isArray(body?.["tools"]) ? (body["tools"] as unknown[]).length : 0,
    messageCount: Array.isArray(body?.["messages"]) ? (body["messages"] as unknown[]).length : 0,
  });

  return {
    message:
      `the pinned OpenRouter endpoint "${route}" is not serving this model right now ` +
      `(either it was removed, or OpenRouter temporarily excluded it from the pool, e.g. for capacity). ` +
      `Retry, pick another route, or remove the @${route} suffix from the model reference to let OpenRouter route it`,
    retryable: routeIsListed || catalogueIsInconclusive,
  };
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

/**
 * The charge an aggregator states in the body of its own answer, when it states one.
 *
 * OpenRouter puts it on `usage` and nowhere else. `is_byok` decides which of the two figures is
 * the money: on a BYOK route OpenRouter bills nothing and the upstream provider debits the owner's
 * own account, so `cost` is 0 while `cost_details.upstream_inference_cost` holds what was spent.
 * Reading `cost` alone there would erase the whole expense -- measured on
 * `google/gemini-3.7-flash` via Google AI Studio: `is_byok true, cost 0, upstream 4.5e-06`.
 *
 * Off a BYOK route the two agree and `cost` is the charge, so an aggregator that declares a cost
 * and no `is_byok` at all is taken at its word.
 *
 * Carried only when positive, for the same reason the header is: a zero means both "free" and
 * "nothing priced", and the price tables answer that better than a fabricated 0.00.
 */
function declaredCostOf(usage: RawUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const declared = usage.is_byok === true ? usage.cost_details?.upstream_inference_cost ?? usage.cost : usage.cost;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? declared : undefined;
}

/**
 * What this call cost according to whatever served it: the proxy's header first, the body second.
 *
 * A positive header is LiteLLM's own billing line for the call it just forwarded, so it outranks a
 * body figure that can only describe the leg the aggregator itself sold. A header that says
 * nothing leaves the body to answer, and the upstream it names is carried either way.
 */
function readDeclaredCost(response: Response, usage: RawUsage | undefined): { proxyCostUsd?: number; upstreamApiBase?: string } {
  const headers = readProxyHeaders(response);
  if (headers.proxyCostUsd !== undefined) return headers;
  const body = declaredCostOf(usage);
  return body === undefined ? headers : { ...headers, proxyCostUsd: body };
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
    // The conversation this call belongs to, and who we are. The config comes last on purpose:
    // an owner overriding either of them has a reason we do not know -- docs/session-affinity.md.
    ...sessionAffinityHeaders(config.baseUrl, config.cacheKey, await userAgent()),
    ...config.headers,
  };
  let cacheHints = config.promptCache === true && !cacheHintsRefused.has(cacheKeyOf(config));
  let bodyObject = buildRequestBody(config, messages, tools, false, cacheHints);
  await clampOutputToPinnedEndpoint(config, bodyObject);
  let body = JSON.stringify(bodyObject);
  const url = `${config.baseUrl}/chat/completions`;

  let lastErr: unknown;
  const budget = timeoutBudget(config);

  for (let attempt = 1; attempt <= LLM_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const controller = new AbortController();
    // Our own wall, told apart from every other abort by this flag rather than by the shape of the
    // error: a `DOMException: AbortError` is what a dead socket raises too, and treating the two
    // alike is what made a timeout retryable and breaker-worthy (docs/llm-timeout.md).
    let timedOut = false;
    const timeout = budget > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budget)
      : undefined;
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, llmFetchInit({ method: "POST", headers, body, signal: fetchSignal }));

        if (!response.ok) {
          const detail = await readErrorBody(response);
          const pinned404 = await pinnedRoute404(config, response.status, detail, bodyObject);
          const err = new Error(
            pinned404?.message ?? `LLM request failed: HTTP ${response.status} — ${detail}`,
          ) as Error & { status?: number; stalePin?: boolean };
          err.status = response.status;
          if (pinned404) err.stalePin = true;

          if (cacheHints && isContentShapeRefusal(response.status, detail)) {
            cacheHints = false;
            cacheHintsRefused.add(cacheKeyOf(config));
            bodyObject = buildRequestBody(config, messages, tools, false, false);
            body = JSON.stringify(bodyObject);
            void log("warn", "endpoint refused the cached content shape; resending without cache hints", {
              model: config.apiModel ?? config.model,
              baseUrl: config.baseUrl,
            });
            lastErr = err;
            continue;
          }

          if (attempt < LLM_RETRY_ATTEMPTS && (isRetryableStatus(response.status) || pinned404?.retryable)) {
            const delay = retryDelayMs(attempt, parseRetryAfterMs(response));
            hooks.emit("llm:call:error", { model: config.model, error: err, attempt, willRetry: true });
            await log("warn", `LLM ${response.status}, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS})`);
            await sleep(delay, signal);
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
      const providerMeta = chatProviderMeta(config, choice.message as Record<string, unknown>, reasoning);
      return {
        content: choice.message.content ?? "",
        toolCalls: parseToolCalls(choice.message.tool_calls),
        finishReason: choice.finish_reason ?? undefined,
        incomplete: !choice.message.content && !choice.message.tool_calls?.length && choice.finish_reason !== "stop",
        usage: normalizeUsage(data.usage),
        ...(reasoning ? { reasoning } : {}),
        ...(providerMeta ? { providerMeta } : {}),
        ...readDeclaredCost(response, data.usage),
      };
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      // A wall we chose is neither a transient fault nor evidence that the endpoint is down:
      // replaying the same prompt on the same machine cannot be faster, and it tripled the load
      // on the box that was already too slow to answer once.
      if (timedOut) {
        throw new Error(`LLM request timed out after ${budget}ms (${timeoutSourceOf(config)})`);
      }
      if (attempt < LLM_RETRY_ATTEMPTS && isTransientError(err)) {
        const delay = retryDelayMs(attempt);
        await log("warn", `LLM transient error, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay, signal);
        continue;
      }
      if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
      throw lastErr;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
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
    // The conversation this call belongs to, and who we are. The config comes last on purpose:
    // an owner overriding either of them has a reason we do not know -- docs/session-affinity.md.
    ...sessionAffinityHeaders(config.baseUrl, config.cacheKey, await userAgent()),
    ...config.headers,
  };
  let cacheHints = config.promptCache === true && !cacheHintsRefused.has(cacheKeyOf(config));
  let bodyObject = buildRequestBody(config, messages, tools, true, cacheHints);
  await clampOutputToPinnedEndpoint(config, bodyObject);
  let body = JSON.stringify(bodyObject);
  const url = `${config.baseUrl}/chat/completions`;

  let lastErr: unknown;
  let tokensDelivered = false;
  const budget = timeoutBudget(config);

  for (let attempt = 1; attempt <= LLM_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const controller = new AbortController();
    let timedOut = false;
    const arm = (): ReturnType<typeof setTimeout> | undefined =>
      budget > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, budget)
        : undefined;
    let timeout = arm();
    const keepAlive = (): void => {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = arm();
    };
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, llmFetchInit({ method: "POST", headers, body, signal: fetchSignal }));

      if (!response.ok) {
        const detail = await readErrorBody(response);
        const pinned404 = await pinnedRoute404(config, response.status, detail, bodyObject);
        const err = new Error(
          pinned404?.message ?? `LLM stream request failed: HTTP ${response.status} — ${detail}`,
        ) as Error & { status?: number; stalePin?: boolean };
        err.status = response.status;
        if (pinned404) err.stalePin = true;

        if (cacheHints && isContentShapeRefusal(response.status, detail)) {
          cacheHints = false;
          cacheHintsRefused.add(cacheKeyOf(config));
          bodyObject = buildRequestBody(config, messages, tools, true, false);
          body = JSON.stringify(bodyObject);
          void log("warn", "endpoint refused the cached content shape; resending without cache hints", {
            model: config.apiModel ?? config.model,
            baseUrl: config.baseUrl,
          });
          lastErr = err;
          continue;
        }

        if (attempt < LLM_RETRY_ATTEMPTS && !tokensDelivered && (isRetryableStatus(response.status) || pinned404?.retryable)) {
          const delay = retryDelayMs(attempt, parseRetryAfterMs(response));
          await log("warn", `LLM stream ${response.status}, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS})`);
          await sleep(delay, signal);
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
      /**
       * `reasoning_details` accumulated off the stream. Streamed as whole blocks on a delta rather
       * than as text fragments, so they are concatenated, not stitched -- the array is opaque and
       * has to go back exactly as it came.
       */
      let streamedReasoningDetails: Record<string, unknown> | undefined;
      const segmenter = new ReasoningSegmenter();
      let streamUsage: LlmUsage | undefined;
      // Kept beside the normalised tokens because `normalizeUsage` drops everything that is not a
      // token count, and the declared cost rides on that same object.
      let streamRawUsage: RawUsage | undefined;
      let finishReason: string | undefined;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

      const handleChunk = async (payload: ChatCompletionStreamChunk): Promise<void> => {
        if (payload.usage) {
          streamUsage = normalizeUsage(payload.usage);
          streamRawUsage = payload.usage;
        }

        const choice = payload.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) return;

        const details = (delta as Record<string, unknown>)["reasoning_details"];
        if (Array.isArray(details) && details.length > 0) {
          const previous = (streamedReasoningDetails?.["reasoning_details"] as unknown[] | undefined) ?? [];
          streamedReasoningDetails = { reasoning_details: [...previous, ...details] };
        }

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
                // Here, and not once per chunk read: the budget measures how long the provider has
                // produced nothing, so only a frame that parses counts. A `: keep-alive` comment
                // keeps a socket warm and says nothing about the model -- opencode zen sends one
                // every twelve seconds behind a dead model, which re-armed a 120 s wall five times
                // a minute and hung a run until the gateway gave up (docs/llm-timeout.md).
                keepAlive();
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
      const reasoningMs = segmenter.thinkingMs();
      const providerMeta = chatProviderMeta(config, streamedReasoningDetails, reasoning);
      // A provider that never said why it stopped did not answer, and silence read as a valid
      // empty turn is how a dead endpoint froze a conversation for half an hour without one error
      // (2026-09-14, deepseek-flash behind opencode zen: HTTP 200, event-stream, zero bytes). The
      // wording matters: `isOutageClass` matches it, which is what makes the route fall through to
      // its next model instead of retrying the same silence -- docs/llm-timeout.md.
      if (!content && streamedToolCalls.length === 0 && !reasoning && finishReason === undefined && streamUsage === undefined) {
        const err = new Error("LLM stream closed without sending anything") as Error & { status?: number };
        recordCircuitFailure(config.baseUrl);
        throw err;
      }
      return {
        content,
        toolCalls: streamedToolCalls.length > 0 ? streamedToolCalls : undefined,
        finishReason,
        incomplete: !content && streamedToolCalls.length === 0 && finishReason !== "stop",
        usage: streamUsage,
        ...(reasoning ? { reasoning } : {}),
        ...(reasoningMs !== undefined ? { reasoningMs } : {}),
        ...(providerMeta ? { providerMeta } : {}),
        ...(segments ? { segments } : {}),
        ...readDeclaredCost(response, streamRawUsage),
      };
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      if (timedOut) {
        throw new Error(`LLM stream stalled for ${budget}ms (${timeoutSourceOf(config)})`);
      }
      if (attempt < LLM_RETRY_ATTEMPTS && !tokensDelivered && isTransientError(err)) {
        const delay = retryDelayMs(attempt);
        await log("warn", `LLM stream transient error, retrying in ${Math.round(delay)}ms (${attempt}/${LLM_RETRY_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay, signal);
        continue;
      }
      if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
      throw lastErr;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  if (countsTowardBreaker(lastErr)) recordCircuitFailure(config.baseUrl);
  throw lastErr;
}
