import type { ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError, sleep } from "../core/aborted.ts";
import { log } from "../utils/logger.ts";
import { getCodexAccessToken, CODEX_BASE_URL } from "./codex-auth.ts";
import { ReasoningSegmenter } from "./reasoning-segments.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ReasoningItem, ToolCall } from "./provider.ts";
import { checkCircuitBreaker, recordCircuitFailure, recordCircuitSuccess, countsTowardBreaker } from "./provider.ts";
import { CODEX_TIMEOUT_MS, llmFetchInit, requestTimeoutMs, timeoutSourceOf } from "./request-timeout.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;

// Cloudflare in front of the Codex backend challenges non first-party originators with a 403
// cf-mitigated response; mirroring the real codex client's originator/User-Agent avoids it.
const ORIGINATOR = "codex_cli_rs";
const USER_AGENT = "codex_cli_rs/0.0.0 (my-claw)";

// ============================================================================
// Request mapping: my-claw ChatMessage[] -> OpenAI Responses input items
// ============================================================================

interface ResponsesTextPart {
  type: "input_text";
  text: string;
}
interface ResponsesImagePart {
  type: "input_image";
  detail: "auto";
  image_url: string;
}
type ResponsesUserPart = ResponsesTextPart | ResponsesImagePart;

type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string | ResponsesUserPart[] }
  | { type: "reasoning"; id: string; encrypted_content?: string; summary: [] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function convertTools(tools?: unknown[]): ResponsesTool[] {
  if (!tools?.length) return [];
  return (tools as ChatToolDefinition[]).map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: false,
  }));
}

/**
 * Split messages into the request `instructions` (first system prompt) and the Responses `input`
 * list. Later system messages (e.g. the iteration-limit summary prompt) become user turns since
 * the Responses API has a single instructions slot.
 */
interface ReplayIdentity {
  backend: string;
  model: string;
  replay: boolean;
}

function buildInput(
  messages: ChatMessage[],
  self?: ReplayIdentity,
): { instructions: string; input: ResponsesInputItem[] } {
  let instructions = "";
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        if (!instructions) instructions = msg.content;
        else input.push({ role: "user", content: msg.content });
        break;
      case "user":
        if (typeof msg.content === "string") {
          input.push({ role: "user", content: msg.content });
        } else {
          const parts: ResponsesUserPart[] = msg.content.map((p) =>
            p.type === "text"
              ? { type: "input_text", text: p.text }
              : { type: "input_image", detail: "auto", image_url: p.image_url.url },
          );
          input.push({ role: "user", content: parts });
        }
        break;
      case "assistant": {
        /**
         * Ahead of the calls, because that is the order the model emitted them in and the API
         * rejects a `reasoning` item that does not precede the `function_call` it produced.
         *
         * Only replayed to the transport and model that produced it: these blobs are signed for
         * one model and a mismatch is a 400, so a run that switched engines drops them rather
         * than failing the call.
         */
        const meta = msg.providerMeta;
        if (self?.replay && meta && meta.backend === self.backend && meta.model === self.model) {
          for (const item of meta.reasoning ?? []) {
            input.push({ type: "reasoning", id: item.id, summary: [], ...(item.encrypted ? { encrypted_content: item.encrypted } : {}) });
          }
        }
        if (msg.content) input.push({ role: "assistant", content: msg.content });
        for (const tc of msg.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        break;
      }
      case "tool":
        input.push({ type: "function_call_output", call_id: msg.tool_call_id, output: msg.content });
        break;
    }
  }

  return { instructions: instructions || "You are a helpful assistant.", input };
}

// ============================================================================
// SSE stream processing
// ============================================================================

interface FunctionCallSlot {
  callId: string;
  name: string;
  args: string;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

function normalizeUsage(raw?: ResponsesUsage): LlmUsage | undefined {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? 0;
  const completion = raw.output_tokens ?? 0;
  const total = raw.total_tokens ?? prompt + completion;
  if (prompt === 0 && completion === 0) return undefined;
  const usage: LlmUsage = { promptTokens: prompt, completionTokens: completion, totalTokens: total };
  // The Responses API reports cache hits as a subset of input_tokens, like chat completions.
  const cacheRead = raw.input_tokens_details?.cached_tokens ?? 0;
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  return usage;
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        yield buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

async function processStream(
  body: ReadableStream<Uint8Array>,
  onToken: ((token: string) => Promise<void> | void) | undefined,
  reasoningSink: ReasoningSink | undefined,
  self: ReplayIdentity,
  /**
   * Called on every line the stream produces, to re-arm the request timeout. The budget is silence
   * and not duration (docs/llm-timeout.md), and it is fed here rather than from the text deltas
   * because a `reasoning_summary` event or a keep-alive is a byte received all the same.
   */
  keepAlive?: () => void,
): Promise<LlmResponse> {
  let content = "";
  let reasoning = "";
  const segmenter = new ReasoningSegmenter();
  /**
   * The Responses API sends its reasoning summary in parts, each one its own `**Heading**` run,
   * and it never puts a separator between them. Appended raw they weld at the seam:
   * `**Locating user workspace directory****Inspecting git status**` -- four asterisks in the
   * middle of a line, which is neither two headings nor a rule, just broken. Measured on this
   * install: forty of them across the stored reasoning.
   *
   * A part boundary is therefore a paragraph break, held until the part actually produces text
   * so a boundary announced at the very end cannot leave a trailing blank line.
   */
  let pendingPartBreak = false;
  let summaryIndex: number | undefined;
  let usage: LlmUsage | undefined;
  let finishReason: string | undefined;
  /**
   * The reasoning items this turn produced, in wire order, to hand straight back on the next call.
   * `encrypted_content` only arrives because the request asks for it in `include`; without that
   * the item is still announced but empty, and replaying an empty one buys nothing.
   */
  const reasoningItems: ReasoningItem[] = [];
  const slots = new Map<number, FunctionCallSlot>();
  const order: number[] = [];

  const ensureSlot = (index: number, seed?: Partial<FunctionCallSlot>): FunctionCallSlot => {
    let slot = slots.get(index);
    if (!slot) {
      slot = { callId: seed?.callId ?? "", name: seed?.name ?? "", args: seed?.args ?? "" };
      slots.set(index, slot);
      order.push(index);
    }
    return slot;
  };

  for await (const line of readLines(body)) {
    keepAlive?.();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const event = safeJson(data);
    const type = event["type"];
    if (typeof type !== "string") continue;

    switch (type) {
      case "response.output_item.added": {
        const item = event["item"] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "function_call") {
          ensureSlot(Number(event["output_index"] ?? 0), {
            callId: item.call_id ?? "",
            name: item.name ?? "",
            args: item.arguments ?? "",
          });
        }
        break;
      }
      case "response.output_text.delta": {
        const delta = event["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          content += delta;
          segmenter.text(delta);
          if (onToken) await onToken(delta);
        }
        break;
      }
      // A new part of the summary begins. Read from the event itself as well as from
      // `part.added` below: the index rides on every delta, so it still separates the parts on a
      // stream that announces no part at all.
      // The request already asks for `summary: "auto"`, so the summary was arriving and being
      // dropped. `reasoning_text` is the raw variant, sent by the models that expose it.
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const index = event["summary_index"];
        if (typeof index === "number" && index !== summaryIndex) {
          if (summaryIndex !== undefined) pendingPartBreak = true;
          summaryIndex = index;
        }
        const delta = event["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          // The break goes through the same three sinks as the text: the stored reasoning, the
          // segment cuts and the live stream. Sent to fewer, the replay would read differently
          // from what the owner watched being written.
          const text = pendingPartBreak && reasoning.length > 0 ? `\n\n${delta}` : delta;
          pendingPartBreak = false;
          reasoning += text;
          segmenter.reasoning(text);
          if (reasoningSink?.onText) await reasoningSink.onText(text);
        }
        break;
      }

      case "response.reasoning_summary_part.added": {
        if (reasoning.length > 0) pendingPartBreak = true;
        break;
      }
      case "response.function_call_arguments.delta": {
        const slot = ensureSlot(Number(event["output_index"] ?? 0));
        const delta = event["delta"];
        if (typeof delta === "string") slot.args += delta;
        break;
      }
      case "response.function_call_arguments.done": {
        const slot = ensureSlot(Number(event["output_index"] ?? 0));
        const args = event["arguments"];
        if (typeof args === "string") slot.args = args;
        break;
      }
      case "response.output_item.done": {
        const item = event["item"] as { type?: string; id?: string; encrypted_content?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        // `done` and not `added`: the encrypted state is only complete once the item closes.
        if (item?.type === "reasoning" && item.id) {
          reasoningItems.push({ id: item.id, ...(item.encrypted_content ? { encrypted: item.encrypted_content } : {}) });
        }
        if (item?.type === "function_call") {
          const slot = ensureSlot(Number(event["output_index"] ?? 0));
          if (item.call_id) slot.callId = item.call_id;
          if (item.name) slot.name = item.name;
          if (typeof item.arguments === "string" && item.arguments.length > 0) slot.args = item.arguments;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        finishReason = type === "response.incomplete" ? "incomplete" : "completed";
        const response = event["response"] as {
          usage?: ResponsesUsage;
          status?: string;
          incomplete_details?: unknown;
          output?: Array<{ type?: string; id?: string; encrypted_content?: string }>;
        } | undefined;
        /**
         * Backfill the encrypted state from the terminal response.
         *
         * `output_item.done` is where it normally arrives, but it is not guaranteed there: Azure's
         * OpenAI deployments omit it from the item and supply it only in the completed response,
         * and an item replayed without it is dropped as unusable. Reading both costs one pass over
         * a short array and makes the capture independent of which of the two the endpoint fills.
         */
        for (const item of response?.output ?? []) {
          if (item.type !== "reasoning" || !item.id || !item.encrypted_content) continue;
          const known = reasoningItems.find((r) => r.id === item.id);
          if (known) known.encrypted ??= item.encrypted_content;
          else reasoningItems.push({ id: item.id, encrypted: item.encrypted_content });
        }
        // Preserve the provider's more specific status when it supplies one. `incomplete` is
        // intentionally retained for the event form: a completed response with no text/tool is
        // still abnormal and the agent loop must not silently accept it.
        if (response?.status) finishReason = response.status;
        usage = normalizeUsage(response?.usage);
        break;
      }
      case "error": {
        throw new Error(`Codex stream error ${String(event["code"] ?? "")}: ${String(event["message"] ?? "unknown")}`.trim());
      }
      case "response.failed": {
        const response = event["response"] as { error?: { code?: string; message?: string } } | undefined;
        const err = response?.error;
        throw new Error(`Codex response failed: ${err?.code ?? "unknown"}: ${err?.message ?? "no message"}`);
      }
    }
  }

  const toolCalls: ToolCall[] = order
    .map((i) => slots.get(i)!)
    .filter((s) => s.callId && s.name)
    .map((s) => ({ id: s.callId, name: s.name, arguments: safeJson(s.args || "{}") }));

  const segments = segmenter.list();
  return {
    content,
    ...(reasoningItems.length > 0 ? { providerMeta: { backend: self.backend, model: self.model, reasoning: reasoningItems } } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    incomplete: !content && toolCalls.length === 0 && finishReason !== "completed",
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(segments ? { segments } : {}),
  };
}

// ============================================================================
// Transport
// ============================================================================

async function runCodex(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  onToken: ((token: string) => Promise<void> | void) | undefined,
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  const model = config.apiModel ?? config.model;
  const self: ReplayIdentity = { backend: "codex", model, replay: config.reasoningReplay !== false };
  const { instructions, input } = buildInput(messages, self);
  const responsesTools = convertTools(tools);
  const body: Record<string, unknown> = {
    model,
    store: false,
    stream: true,
    instructions,
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (responsesTools.length > 0) body["tools"] = responsesTools;
  // Pins the implicit prefix cache to this conversation. With `store: false` nothing is kept
  // server-side, so without a key every iteration is free to land on a different cache node and
  // the stable prefix is re-read at full price -- measured at 72% cache-read where the Anthropic
  // transport, which names its breakpoints, holds 94%. See docs/prompt-caching.md.
  if (config.cacheKey) body["prompt_cache_key"] = config.cacheKey;
  if (config.effort) body["reasoning"] = { effort: config.effort, summary: "auto" };
  // The counterpart of `store: false`: nothing is kept server-side, so the encrypted thinking
  // state has to come back to us or it is lost between two tool iterations. Conditioned on the
  // same switch as the replay itself, so turning the provider's `reasoningReplay` off really does
  // take the whole feature off the wire rather than leaving the request field behind.
  if (self.replay) body["include"] = ["reasoning.encrypted_content"];

  const base = config.baseUrl || CODEX_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/codex/responses`;
  const payload = JSON.stringify(body);

  // One breaker per endpoint, shared with the chat-completions client: a subscription outage
  // must stop being retried on every turn, not only inside one call's three attempts.
  checkCircuitBreaker(base);

  let lastErr: unknown;
  let tokensDelivered = false;
  // The model's own declaration when it has one, else this transport's default -- a subscription
  // backend that thinks for minutes before answering (docs/llm-timeout.md).
  const budget = requestTimeoutMs(config, CODEX_TIMEOUT_MS);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const { accessToken, accountId } = await getCodexAccessToken(signal);
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
      const response = await fetch(url, llmFetchInit({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: ORIGINATOR,
          "User-Agent": USER_AGENT,
          accept: "text/event-stream",
          ...config.headers,
        },
        body: payload,
        signal: fetchSignal,
      }));

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        const err = new Error(`Codex request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
        err.status = response.status;
        if (attempt < MAX_ATTEMPTS && !tokensDelivered && RETRYABLE_STATUS.has(response.status)) {
          const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
          await log("warn", `Codex ${response.status}, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS})`);
          await sleep(delay, signal);
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (!response.body) throw new Error("Codex response has no body");

      const wrappedOnToken = onToken
        ? async (t: string) => {
            tokensDelivered = true;
            await onToken(t);
          }
        : undefined;
      recordCircuitSuccess(base);
      return await processStream(response.body, wrappedOnToken, reasoningSink, self, keepAlive);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      // Our own wall: not retried, and not counted against the endpoint (docs/llm-timeout.md).
      if (timedOut) {
        throw new Error(`Codex request timed out after ${budget}ms (${timeoutSourceOf(config)})`);
      }
      if (attempt < MAX_ATTEMPTS && !tokensDelivered && err instanceof TypeError) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        await log("warn", `Codex transient error, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay, signal);
        continue;
      }
      if (countsTowardBreaker(lastErr)) recordCircuitFailure(base);
      throw lastErr;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  if (countsTowardBreaker(lastErr)) recordCircuitFailure(base);
  throw lastErr;
}

export function codexResponse(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return runCodex(config, messages, tools, undefined, signal);
}

export function codexResponseStream(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  return runCodex(config, messages, tools, onToken, signal, reasoningSink);
}
