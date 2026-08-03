import type { ResolvedLlmConfig } from "../core/config.ts";
import { AbortedError } from "../core/aborted.ts";
import { log } from "../utils/logger.ts";
import { getCodexAccessToken, CODEX_BASE_URL } from "./codex-auth.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ToolCall } from "./provider.ts";

const CODEX_TIMEOUT_MS = 300_000;
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
function buildInput(messages: ChatMessage[]): { instructions: string; input: ResponsesInputItem[] } {
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
      case "assistant":
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
): Promise<LlmResponse> {
  let content = "";
  let usage: LlmUsage | undefined;
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
          if (onToken) await onToken(delta);
        }
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
        const item = event["item"] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
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
        const response = event["response"] as { usage?: ResponsesUsage } | undefined;
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

  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage };
}

// ============================================================================
// Transport
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCodex(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  onToken: ((token: string) => Promise<void> | void) | undefined,
  signal?: AbortSignal,
): Promise<LlmResponse> {
  const { instructions, input } = buildInput(messages);
  const responsesTools = convertTools(tools);
  const body: Record<string, unknown> = {
    model: config.model,
    store: false,
    stream: true,
    instructions,
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (responsesTools.length > 0) body["tools"] = responsesTools;
  if (config.effort) body["reasoning"] = { effort: config.effort, summary: "auto" };

  const url = `${(config.baseUrl || CODEX_BASE_URL).replace(/\/+$/, "")}/codex/responses`;
  const payload = JSON.stringify(body);

  let lastErr: unknown;
  let tokensDelivered = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const { accessToken, accountId } = await getCodexAccessToken(signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CODEX_TIMEOUT_MS);
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, {
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
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        const err = new Error(`Codex request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
        err.status = response.status;
        if (attempt < MAX_ATTEMPTS && !tokensDelivered && RETRYABLE_STATUS.has(response.status)) {
          const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
          await log("warn", `Codex ${response.status}, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS})`);
          await sleep(delay);
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
      return await processStream(response.body, wrappedOnToken);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") {
        lastErr = new Error(`Codex request timed out after ${CODEX_TIMEOUT_MS}ms`);
      }
      if (attempt < MAX_ATTEMPTS && !tokensDelivered && err instanceof TypeError) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        await log("warn", `Codex transient error, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message}`);
        await sleep(delay);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timeout);
    }
  }

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
): Promise<LlmResponse> {
  return runCodex(config, messages, tools, onToken, signal);
}
