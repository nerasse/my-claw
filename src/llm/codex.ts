import type { ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError, sleep } from "../core/aborted.ts";
import { isRetryableStatus, retryDelayMs, parseRetryAfterMs, wallAhead } from "./retry.ts";
import { log } from "../utils/logger.ts";
import { getCodexAccessToken, CODEX_BASE_URL } from "./codex-auth.ts";
import { ReasoningSegmenter } from "./reasoning-segments.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ReasoningItem, ToolCall } from "./provider.ts";
import { checkCircuitBreaker, isToolName, recordCircuitFailure, recordCircuitSuccess, countsTowardBreaker } from "./provider.ts";
import { isQuotaSpent } from "./outage.ts";
import { CODEX_TIMEOUT_MS, llmFetchInit, requestTimeoutMs, timeoutSourceOf } from "./request-timeout.ts";

const MAX_ATTEMPTS = 3;
/**
 * A stream that dies mid-answer gets more room than a request the far side refused: the answer was
 * already being written, and re-sending it costs no new tokens. Five is what the reference client
 * gives its own stream retries.
 */
const STREAM_ATTEMPTS = 5;

/**
 * A failure the subscription backend announced from inside the stream.
 *
 * The reference client's rule, and the reason this exists: a code it does not recognise is a
 * transport fault to replay, not a verdict on the request (`codex-api/src/sse/responses_error.rs`,
 * an unknown `response.failed` code maps to `ApiError::Retryable`). my-claw turned every one of
 * them into a fatal error, and read the code from the root of the event while the backend nests it
 * under `error`: the message said "unknown", and the run died at minute 34 with 26 tool calls
 * behind it, on an error nobody could name (2026-11-05).
 *
 * What this install does with the code is the part that matters: a spent plan goes straight to the
 * caller's fallback, a rate limit and an unnamed failure are replayed, and the rest are verdicts
 * that travel with their own words.
 */
export class CodexStreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly resetInSeconds?: number;
  readonly resetAtMs?: number;

  constructor(event: Record<string, unknown>) {
    const failure = failureOf(event);
    const kind = KIND_OF_CODE.get(failure.code.toLowerCase()) ?? namedQuotaIn(failure.message);
    const code = failure.code || "unknown";
    const detail = failure.message || "the backend said nothing about why";
    super(PHRASE[kind](code, detail));
    this.name = "CodexStreamError";
    this.code = failure.code;
    this.retryable = kind === "rate_limit" || kind === "unknown";
    // `usage_limit_reached` arrives as a 429, and the quota predicates read the status: without it
    // a spent plan only trips the sentence-based half of the check. A policy refusal is only read
    // as one on a 4xx, so it gets the status that makes that true.
    if (kind === "quota") this.status = 429;
    if (kind === "policy") this.status = 400;
    if (failure.retryAfterMs !== undefined) this.retryAfterMs = failure.retryAfterMs;
    if (failure.resetInSeconds !== undefined) this.resetInSeconds = failure.resetInSeconds;
    if (failure.resetAtMs !== undefined) this.resetAtMs = failure.resetAtMs;
  }
}

type FailureKind = "quota" | "rate_limit" | "context" | "policy" | "terminal" | "unknown";

const KIND_OF_CODE = new Map<string, FailureKind>([
  ...["insufficient_quota", "usage_limit_reached", "credit_balance_exhausted", "billing_hard_limit_reached",
    "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "session_budget_exceeded", "budget_reached",
  ].map((code): [string, FailureKind] => [code, "quota"]),
  ...["rate_limit_exceeded", "rate_limit_error", "slow_down", "too_many_requests"].map((code): [string, FailureKind] => [code, "rate_limit"]),
  ...["context_length_exceeded", "context_window_exceeded"].map((code): [string, FailureKind] => [code, "context"]),
  ...["cyber_policy", "bio_policy", "misalignment_policy_violation", "content_policy_violation", "content_filter"]
    .map((code): [string, FailureKind] => [code, "policy"]),
  ...["usage_not_included", "model_not_found", "invalid_prompt", "invalid_request_error"]
    .map((code): [string, FailureKind] => [code, "terminal"]),
]);

/**
 * Each kind's first words are the ones this install already reads elsewhere: "quota exhausted" for
 * `isQuotaSpent`, "policy violation" for a refusal another provider may carry, "stream error" for
 * `isStreamFault`, and the bare code for an overflow the compactor recognises.
 */
const PHRASE: Record<FailureKind, (code: string, detail: string) => string> = {
  quota: (code, detail) => `Codex quota exhausted (${code}): ${detail}`,
  rate_limit: (code, detail) => `Codex rate limit (${code}): ${detail}`,
  context: (code, detail) => `Codex ${code}: ${detail}`,
  terminal: (code, detail) => `Codex ${code}: ${detail}`,
  policy: (code, detail) => `Codex policy violation (${code}): ${detail}`,
  unknown: (code, detail) => `Codex stream error (${code}): ${detail}`,
};

interface StreamFailure {
  code: string;
  message: string;
  retryAfterMs?: number;
  resetInSeconds?: number;
  resetAtMs?: number;
}

/**
 * What the backend said, wherever it put it.
 *
 * The error is nested under `error` for a bare `error` event and under `response.error` for
 * `response.failed`; the root carries it in neither. Reading all three is what makes the code
 * survive to the classifier instead of arriving as an empty string.
 */
function failureOf(event: Record<string, unknown>): StreamFailure {
  const response = event["response"];
  const wrapped = response && typeof response === "object" ? (response as Record<string, unknown>)["error"] : undefined;
  const nested = (event["error"] ?? wrapped ?? {}) as Record<string, unknown>;
  const field = (key: string): unknown => {
    for (const source of [nested, event]) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };
  const count = (key: string): number | undefined => {
    const value = field(key);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const retryAfter = count("retry_after");
  const resetInSeconds = count("resets_in_seconds");
  const resetsAt = count("resets_at");
  // `type` is the event's own name on the root ("error"), so it is only a code from the nested one.
  const code = field("code");
  const message = field("message");
  return {
    code: typeof code === "string" ? code : typeof nested["type"] === "string" ? nested["type"] : "",
    message: typeof message === "string" ? message : "",
    ...(retryAfter !== undefined ? { retryAfterMs: Math.max(0, retryAfter) * 1000 } : {}),
    ...(resetInSeconds !== undefined ? { resetInSeconds } : {}),
    // Epoch seconds on the wire, epoch milliseconds when a gateway already converted it.
    ...(resetsAt !== undefined ? { resetAtMs: resetsAt > 1e12 ? resetsAt : resetsAt * 1000 } : {}),
  };
}

/**
 * A code this build does not know, but a sentence that names a spent plan, is still a spent plan:
 * the vocabulary grows on the provider's side faster than on ours.
 */
function namedQuotaIn(message: string): FailureKind {
  return /quota|credit balance|usage limit/i.test(message) ? "quota" : "unknown";
}

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
  | { role: "user"; content: string | ResponsesUserPart[] }
  | { role: "assistant"; content: string; phase?: "commentary" | "final_answer" }
  | { type: "reasoning"; id: string; encrypted_content?: string; summary: [] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | ResponsesUserPart[] };

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
        const replayable = self?.replay && meta && meta.backend === self.backend && meta.model === self.model;
        if (replayable) {
          for (const item of meta.reasoning ?? []) {
            input.push({ type: "reasoning", id: item.id, summary: [], ...(item.encrypted ? { encrypted_content: item.encrypted } : {}) });
          }
        }
        // Only to the backend that labelled it: another protocol has no such field, and another
        // model's phase is a claim about a turn this model never wrote.
        if (msg.content) {
          const phase = replayable ? meta.phase : undefined;
          input.push({ role: "assistant", content: msg.content, ...(phase ? { phase } : {}) });
        }
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
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output:
            typeof msg.content === "string"
              ? msg.content
              : msg.content.map((p): ResponsesUserPart =>
                  p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", detail: "auto", image_url: p.image_url.url },
                ),
        });
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
  output_tokens_details?: { reasoning_tokens?: number };
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
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? 0;
  if (reasoning > 0) usage.reasoningTokens = reasoning;
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
  /**
   * How long each reasoning item stayed open, from `added` to `done`, in wire order.
   *
   * This is the only honest span on this backend, for two reasons that both come from the same
   * fact: the Responses API does not stream a thought, it reports one. A thought the model keeps
   * to itself (`encrypted_content`) produces no delta at all, and a thought it summarises sends its
   * summary parts **at the very end**, when the item closes -- so a span measured from the first
   * delta to the first word of the answer measures the burst of the summary, not the thinking. The
   * reader watched the wait, and the item's own lifetime is what that wait was.
   *
   * OpenAI-compatible providers and Anthropic stream their reasoning as it happens, so the
   * segmenter's span is the right one there and this list stays empty.
   */
  const itemSpans: number[] = [];
  const itemOpenedAt = new Map<string, number>();
  /**
   * The assistant message items as the backend closed them, with the `phase` it gave each one.
   * The text is read off the item and not off the deltas: what is replayed and what the reader saw
   * have to be the same thing, and the item is the backend's own account of it.
   */
  const messageItems: Array<{ id?: string; phase?: "commentary" | "final_answer"; text: string }> = [];
  /**
   * The backend declared a closing message and that closing message carried nothing.
   *
   * Measured 2026-11-26 on `gpt-6.1-sol`, effort max, a 147k-token conversation: three calls in a
   * row completed with `phase: "final_answer"` on a message item whose content was empty, 49 to
   * 72 output tokens billed as reasoning. The call happened and the model said nothing, so the
   * turn is the far side's failure, not a run with an empty answer to show.
   */
  let emptyFinalAnswerItem = false;
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
        const item = event["item"] as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "reasoning" && item.id) itemOpenedAt.set(item.id, Date.now());
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
          const openedAt = itemOpenedAt.get(item.id);
          // A span of zero is not a span: it is what the same tick looks like.
          if (openedAt !== undefined) {
            const span = Date.now() - openedAt;
            if (span > 0) itemSpans.push(span);
          }
          itemOpenedAt.delete(item.id);
        }
        if (item?.type === "function_call") {
          const slot = ensureSlot(Number(event["output_index"] ?? 0));
          if (item.call_id) slot.callId = item.call_id;
          if (item.name) slot.name = item.name;
          if (typeof item.arguments === "string" && item.arguments.length > 0) slot.args = item.arguments;
        }
        if (item?.type === "message") {
          const parts = (item as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
          const text = parts.filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
          const phase = (item as { phase?: string }).phase;
          messageItems.push({ ...(item.id ? { id: item.id } : {}), text, ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}) });
          if (phase === "final_answer" && text.trim().length === 0) emptyFinalAnswerItem = true;
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
          input_transformations?: Array<{ type?: string; id?: string; action?: string; reason?: string }>;
          output?: Array<{ type?: string; id?: string; encrypted_content?: string; phase?: string; content?: Array<{ type?: string; text?: string }> }>;
        } | undefined;
        /**
         * Every replayed item the backend threw away, and why. Silent until now: the model then runs
         * on a history shorter than the one we sent, and nothing on either side said so. Reasons
         * are `prefix_mismatch`, `turn_boundary`, `organization_mismatch`, `model_mismatch`.
         */
        const dropped = (response?.input_transformations ?? []).filter((entry) => entry.action === "removed");
        if (dropped.length > 0) {
          void log("warn", "codex dropped replayed items", {
            model: self.model,
            count: dropped.length,
            reasons: [...new Set(dropped.map((entry) => entry.reason ?? "unknown"))],
            ids: dropped.map((entry) => entry.id ?? "").slice(0, 10),
          });
        }
        // Same reading as `output_item.done`, for a backend that only fills the terminal response.
        for (const item of response?.output ?? []) {
          if (item.type !== "message") continue;
          const text = (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
          if (item.phase === "final_answer" && text.trim().length === 0) emptyFinalAnswerItem = true;
          const known = item.id ? messageItems.some((entry) => entry.id === item.id) : messageItems.some((entry) => entry.text === text);
          if (known) continue;
          if (item.phase === "commentary" || item.phase === "final_answer") {
            messageItems.push({ ...(item.id ? { id: item.id } : {}), phase: item.phase, text });
          }
        }
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
        const failure = new CodexStreamError(event);
        // The payload is the only evidence of why the backend gave up, and it is small on this
        // event: without it a run dies on a sentence that names nothing (measured 2026-11-05).
        void log("warn", "codex stream failure event", {
          code: failure.code,
          message: failure.message.slice(0, 500),
          retryable: failure.retryable,
          event: JSON.stringify(event).slice(0, 2000),
        });
        throw failure;
      }
      case "response.failed": {
        const failure = new CodexStreamError(event);
        void log("warn", "codex response failed", {
          code: failure.code,
          message: failure.message.slice(0, 500),
          retryable: failure.retryable,
        });
        throw failure;
      }
    }
  }

  const toolCalls: ToolCall[] = order
    .map((i) => slots.get(i)!)
    .filter((s) => s.callId)
    .flatMap((s) => {
      // A name the model mangled is not a call. Codex refuses a replayed one with HTTP 400, which
      // broke a whole conversation that had one in its log -- docs/model-identity.md.
      if (!isToolName(s.name)) {
        if (s.name) void log("warn", "dropped a Codex tool call whose name is not an identifier", { name: String(s.name).slice(0, 120) });
        return [];
      }
      return [{ id: s.callId, name: s.name, arguments: safeJson(s.args || "{}") }];
    });

  const segments = segmenter.list();
  // The span of a thought, from the item that held it -- never from the deltas, which on this
  // backend are a burst at the close. Each phase takes its own item's lifetime, paired from the
  // end like the bubbles are (`run-recorder.ts`): the last phase is the one the count rides on, so
  // it has to carry the last item's span and not the turn's total.
  const spanned = itemSpans.length > 0 ? segments?.map((segment, index) => ({
    ...segment,
    ...(itemSpans[itemSpans.length - segments.length + index] !== undefined
      ? { reasoningMs: itemSpans[itemSpans.length - segments.length + index]! }
      : {}),
  })) : segments;
  const reasoningMs = itemSpans.length > 0 ? itemSpans[itemSpans.length - 1] : segmenter.thinkingMs();
  /**
   * The label to hand back with this assistant item, when the backend gave one.
   *
   * A turn that called tools wrote a preamble, whatever the model called it: Codex labels that item
   * `commentary`. A turn with only prose carries the phase of its last message item, and nothing
   * when the backend labelled none (older models have no such field, and inventing one would be a
   * claim about a turn this model never wrote).
   */
  const lastTextPhase = messageItems.filter((item) => item.text.trim().length > 0).at(-1)?.phase;
  const phase: "commentary" | "final_answer" | undefined = !content.trim()
    ? undefined
    : toolCalls.length > 0
      ? "commentary"
      : lastTextPhase;
  const emptyFinalAnswer = finishReason === "completed" && emptyFinalAnswerItem && !content.trim() && toolCalls.length === 0;
  return {
    content,
    ...(emptyFinalAnswer ? { emptyFinalAnswer: true } : {}),
    ...(reasoningItems.length > 0 || phase
      ? {
          providerMeta: {
            backend: self.backend,
            model: self.model,
            ...(phase ? { phase } : {}),
            ...(reasoningItems.length > 0 ? { reasoning: reasoningItems } : {}),
          },
        }
      : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    incomplete: !content && toolCalls.length === 0 && finishReason !== "completed",
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningMs !== undefined ? { reasoningMs } : {}),
    ...(spanned ? { segments: spanned } : {}),
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
  // The body key alone caches nothing on the ChatGPT backend: affinity comes from the
  // `session-id` header (below), and the reference client sends both with the same value.
  // See docs/prompt-caching.md.
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
  /** Whether the attempt in flight put anything on screen, text or thinking. */
  let outputDelivered = false;
  /**
   * How a dead attempt's words are taken back before it is replayed. Provided by the channel: the
   * app replaces a bubble on a `replay` delta, so the retry writes into the same one.
   */
  const restart = reasoningSink?.onRestart;
  /** The thinking had to be counted as output too, or a replay would keep the words of the dead try. */
  const wrappedReasoning: ReasoningSink | undefined = reasoningSink?.onText
    ? {
        ...reasoningSink,
        onText: async (delta: string) => {
          outputDelivered = true;
          await reasoningSink.onText?.(delta);
        },
      }
    : reasoningSink;
  // The model's own declaration when it has one, else this transport's default -- a subscription
  // backend that thinks for minutes before answering (docs/llm-timeout.md).
  const budget = requestTimeoutMs(config, CODEX_TIMEOUT_MS);

  for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    // Each ChatGPT provider is its own account: the run signs with the one it was routed to.
    if (!config.provider) throw new Error("A ChatGPT model reached the transport without its provider");
    const { accessToken, accountId } = await getCodexAccessToken(config.provider, signal);
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
          ...(config.cacheKey ? { "session-id": config.cacheKey } : {}),
          ...config.headers,
        },
        body: payload,
        signal: fetchSignal,
      }));

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        const err = new Error(`Codex request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
        err.status = response.status;
        // A spent quota is a 429 too, and no backoff refills it: straight to the caller's fallback.
        if (attempt < MAX_ATTEMPTS && !tokensDelivered && !isQuotaSpent(err) && !(await wallAhead(config, err)) && isRetryableStatus(response.status)) {
          const delay = retryDelayMs(attempt, parseRetryAfterMs(response));
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
            outputDelivered = true;
            await onToken(t);
          }
        : undefined;
      recordCircuitSuccess(base);
      return await processStream(response.body, wrappedOnToken, wrappedReasoning, self, keepAlive);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      // Our own wall: not retried, and not counted against the endpoint (docs/llm-timeout.md).
      if (timedOut) {
        throw new Error(`Codex request timed out after ${budget}ms (${timeoutSourceOf(config)})`);
      }
      if (err instanceof CodexStreamError) {
        // The stream died mid-answer: replay the request, before anything else in the chain gets a
        // say. The reference client gives this five attempts; three is what every other retryable
        // condition in this install gets, and the escalation here is a real one -- the run's
        // fallback can use another account, which that client does not have.
        //
        // Replaying after the first visible word is only safe when the channel can take that word
        // back: the bubble is replaced, not appended to. Without that hook the old rule holds, since
        // a retry nobody can erase would print the answer twice.
        if (err.retryable && attempt < STREAM_ATTEMPTS && (!outputDelivered || restart !== undefined)) {
          if (outputDelivered) await restart?.();
          outputDelivered = false;
          tokensDelivered = false;
          const delay = retryDelayMs(attempt, err.retryAfterMs);
          await log("warn", `Codex stream failed mid-answer, replaying in ${delay}ms (${attempt}/${STREAM_ATTEMPTS})`, {
            code: err.code,
          });
          await sleep(delay, signal);
          continue;
        }
        // Never counted against the endpoint: the breaker is keyed on a base URL every subscription
        // in this install shares, so one account's dead stream would darken the other two.
        throw err;
      }
      if (attempt < MAX_ATTEMPTS && !tokensDelivered && err instanceof TypeError) {
        const delay = retryDelayMs(attempt);
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
