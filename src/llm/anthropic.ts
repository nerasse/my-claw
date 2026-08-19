import { createHash, randomUUID } from "node:crypto";
import type { ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError } from "../core/aborted.ts";
import { log } from "../utils/logger.ts";
import { loadClaudeToken } from "./claude-auth.ts";
import { OWNER_STEERING_NOTE } from "../agent/owner-steering.ts";
import { ReasoningSegmenter } from "./reasoning-segments.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ToolCall } from "./provider.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_TIMEOUT_MS = 600_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;
const MAX_TOKENS = 32_000;

/**
 * The three values a subscription request claims about the client it pretends to be. They ship
 * together in one CLI release, so they are pinned together: a user-agent from one release beside
 * a stainless package version from another is an inconsistency the account does not need to
 * advertise. Re-derive the whole tuple from a fresh capture (scripts/capture-anthropic-proxy.ts),
 * never one field at a time. Node version is the runtime the CLI bundles, not the one we run.
 */
const CLI_RELEASE = {
  version: process.env["ANTHROPIC_CLI_VERSION"] || "2.1.217",
  stainlessPackage: "0.94.0",
  nodeVersion: "v26.3.0",
} as const;

const USER_AGENT = process.env["ANTHROPIC_USER_AGENT"] || `claude-cli/${CLI_RELEASE.version} (external, sdk-cli)`;

// Order matters: reproduced verbatim from docs/captures/claude-cli-2.1.206.json.
const BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "claude-code-20250219",
  "advisor-tool-2026-03-01",
  "extended-cache-ttl-2025-04-11",
].join(",");

const IDENTITY_BLOCK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// The real client sends `display: "omitted"`, which is why a redacted engine can only report a
// thinking token count. Flip this to stream the reasoning text instead, at the cost of being the
// one field where we knowingly differ from the capture.
const STREAM_THINKING = false;

// One id per process, exactly like the CLI: it is a client-side correlation handle, and a fresh
// one per request would be the anomaly.
const SESSION_ID = randomUUID();

const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;

// ============================================================================
// Billing header
// ============================================================================

const BILLING_SALT = "59cf53e54c78";
const SAMPLED_POSITIONS = [4, 7, 20];

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * `x-anthropic-billing-header`, injected as system[0] rather than an HTTP header.
 *
 * Transcribed from the CLI's own bundle (`WLn`/`qxu`/`OHg`/`OYi` in claude 2.1.206), not from a
 * community reimplementation: the four plugins agree on the salt and the sampled positions but
 * invent a `cch=<sha256 of the text>` field. The real `cch` is the literal `00000` and only ships
 * on the first-party and vertex paths, so a subscription request carries no `cch` at all.
 *
 * The header is always emitted, even with no text to sample: `OYi` defaults each missing character
 * to "0", so an empty prompt yields a real suffix rather than a missing header.
 */
function billingSuffix(sampleText: string, version: string): string {
  const sampled = SAMPLED_POSITIONS.map((i) => sampleText[i] || "0").join("");
  return sha256(BILLING_SALT + sampled + version).slice(0, 3);
}

function billingHeader(sampleText: string): string {
  const suffix = billingSuffix(sampleText, CLI_RELEASE.version);
  return `x-anthropic-billing-header: cc_version=${CLI_RELEASE.version}.${suffix}; cc_entrypoint=sdk-cli;`;
}

// `<system-reminder>` blocks are the wire form of what the CLI's transcript flags `isMeta`, and
// `OHg` skips those entries before sampling. Sampling the first reminder instead of the first real
// turn yields a valid-looking header with the wrong suffix, which is worse than no header.
const META_BLOCK_RE = /^\s*<system-reminder>/;

/** The text `OHg` would sample: the first non-meta user turn's first text block. */
function billingSampleText(messages: ChatMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      if (!META_BLOCK_RE.test(msg.content)) return msg.content;
      continue;
    }
    for (const part of msg.content) {
      if (part.type === "text" && !META_BLOCK_RE.test(part.text)) return part.text;
    }
  }
  return "";
}

// ============================================================================
// Tool naming, transport boundary only
// ============================================================================

// my-claw's tools reach the Claude SDK through an in-process MCP server named `myclaw`, so this
// is the shape with a track record on the account. A name that already carries an `mcp__<server>__`
// prefix comes from a real MCP server and is left alone.
const MYCLAW_PREFIX = "mcp__myclaw__";

function wireToolName(name: string): string {
  return name.startsWith("mcp__") ? name : MYCLAW_PREFIX + name;
}

function localToolName(name: string): string {
  return name.startsWith(MYCLAW_PREFIX) ? name.slice(MYCLAW_PREFIX.length) : name;
}

// ============================================================================
// Request mapping: my-claw ChatMessage[] -> Anthropic Messages
// ============================================================================

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: typeof CACHE_1H;
}
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function convertTools(tools?: unknown[]): AnthropicTool[] {
  if (!tools?.length) return [];
  // No cache_control on any tool: the tools ride inside the prefix the system breakpoints cover,
  // and a fifth breakpoint would exceed Anthropic's cap of four.
  return (tools as ChatToolDefinition[]).map((t) => ({
    name: wireToolName(t.function.name),
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function imageBlock(url: string): AnthropicImageBlock {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) return { type: "image", source: { type: "base64", media_type: match[1]!, data: match[2]! } };
  return { type: "image", source: { type: "url", url } };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Split the prompt into the `system` blocks and the `messages` array.
 *
 * Two Anthropic rules shape this: roles must alternate, and the tool_result blocks answering one
 * assistant turn belong in a single user message. The home loop emits one `tool` message per call,
 * so consecutive same-role messages are merged rather than sent as-is.
 */
function buildRequest(messages: ChatMessage[]): { system: string; turns: AnthropicMessage[] } {
  let system = "";
  const turns: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // Anthropic has a single system slot, so a later system message (the iteration-limit
        // prompt) becomes a user turn, as on the Codex transport.
        if (!system) system = msg.content;
        else push("user", [{ type: "text", text: msg.content }]);
        break;
      case "user":
        if (typeof msg.content === "string") {
          push("user", [{ type: "text", text: msg.content }]);
        } else {
          push(
            "user",
            msg.content.map((p): AnthropicBlock => (p.type === "text" ? { type: "text", text: p.text } : imageBlock(p.image_url.url))),
          );
        }
        break;
      case "assistant": {
        const blocks: AnthropicBlock[] = [];
        if (msg.content) blocks.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: wireToolName(tc.function.name),
            input: safeJson(tc.function.arguments || "{}"),
          });
        }
        push("assistant", blocks);
        break;
      }
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content }]);
        break;
    }
  }

  return { system, turns };
}

/**
 * The three system blocks, in the capture's order. The billing header never carries a breakpoint;
 * the other two always do, because on this transport caching is not optional (docs/anthropic-backend.md).
 */
function buildSystem(system: string, sampleText: string): AnthropicTextBlock[] {
  const blocks: AnthropicTextBlock[] = [{ type: "text", text: billingHeader(sampleText) }];
  blocks.push({ type: "text", text: IDENTITY_BLOCK, cache_control: CACHE_1H });
  if (system) blocks.push({ type: "text", text: system, cache_control: CACHE_1H });
  return blocks;
}

// ============================================================================
// SSE stream processing
// ============================================================================

interface ToolUseSlot {
  id: string;
  name: string;
  json: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * `input_tokens` excludes the cache buckets on this API, while `LlmUsage.promptTokens` is
 * normalised to include them. Adding them here is what keeps cost and context maths comparable
 * across transports.
 */
function normalizeUsage(raw: AnthropicUsage | undefined, outputTokens: number): LlmUsage | undefined {
  if (!raw) return undefined;
  const fresh = raw.input_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  const prompt = fresh + cacheRead + cacheWrite;
  const completion = outputTokens || raw.output_tokens || 0;
  if (prompt === 0 && completion === 0) return undefined;
  const usage: LlmUsage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  return usage;
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
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  let content = "";
  let reasoning = "";
  const segmenter = new ReasoningSegmenter();
  let rawUsage: AnthropicUsage | undefined;
  let outputTokens = 0;
  const slots = new Map<number, ToolUseSlot>();
  const order: number[] = [];

  for await (const line of readLines(body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    const event = safeJson(data);
    const type = event["type"];
    if (typeof type !== "string") continue;

    switch (type) {
      case "message_start": {
        // Final input counts land here, before a single output token, which makes this the
        // earliest point a turn's prompt can be measured.
        const message = event["message"] as { usage?: AnthropicUsage } | undefined;
        rawUsage = message?.usage;
        break;
      }
      case "content_block_start": {
        const block = event["content_block"] as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use") {
          const index = Number(event["index"] ?? 0);
          slots.set(index, { id: block.id ?? "", name: block.name ?? "", json: "" });
          order.push(index);
        }
        break;
      }
      case "content_block_delta": {
        const delta = event["delta"] as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          content += delta.text;
          segmenter.text(delta.text);
          if (onToken) await onToken(delta.text);
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          reasoning += delta.thinking;
          segmenter.reasoning(delta.thinking);
          if (reasoningSink?.onText) await reasoningSink.onText(delta.thinking);
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const slot = slots.get(Number(event["index"] ?? 0));
          if (slot) slot.json += delta.partial_json;
        }
        break;
      }
      case "message_delta": {
        const usage = event["usage"] as AnthropicUsage | undefined;
        if (usage?.output_tokens) outputTokens = usage.output_tokens;
        break;
      }
      case "error": {
        const err = event["error"] as { type?: string; message?: string } | undefined;
        throw new Error(`Anthropic stream error ${err?.type ?? "unknown"}: ${err?.message ?? "no message"}`);
      }
    }
  }

  const toolCalls: ToolCall[] = order
    .map((i) => slots.get(i)!)
    .filter((s) => s.id && s.name)
    .map((s) => ({ id: s.id, name: localToolName(s.name), arguments: safeJson(s.json || "{}") }));

  const segments = segmenter.list();
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: normalizeUsage(rawUsage, outputTokens),
    ...(reasoning ? { reasoning } : {}),
    ...(segments ? { segments } : {}),
  };
}

// ============================================================================
// Transport
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

// Effort maps to a thinking budget rather than a level: `budget_tokens` must stay below
// `max_tokens`, and the capture's 31999 against a 32000 cap is the ceiling of that range.
const EFFORT_BUDGET: Record<string, number> = {
  minimal: 2_000,
  low: 6_000,
  medium: 16_000,
  high: MAX_TOKENS - 1,
  xhigh: MAX_TOKENS - 1,
  max: MAX_TOKENS - 1,
};

/** The whole request body, pure so P2 can diff it against the capture without a network call. */
function buildBody(config: Partial<ResolvedLlmConfig>, messages: ChatMessage[] = [], tools?: unknown[]): Record<string, unknown> {
  const { system, turns } = buildRequest(messages);
  const anthropicTools = convertTools(tools);

  // Appended here rather than by the prompt builder, for the same reason the SDK appends it after
  // composition: it must be the last thing the model reads, and it is a property of talking to a
  // Claude model, not of any workspace's prompt. Static, so it stays inside the cached prefix.
  const withNote = system + OWNER_STEERING_NOTE;

  const body: Record<string, unknown> = {
    model: config.apiModel ?? config.model ?? "",
    max_tokens: MAX_TOKENS,
    system: buildSystem(withNote, billingSampleText(messages)),
    messages: turns,
    stream: true,
  };
  if (anthropicTools.length > 0) body["tools"] = anthropicTools;

  const budget = config.effort ? EFFORT_BUDGET[config.effort] : undefined;
  if (budget) {
    body["thinking"] = {
      type: "enabled",
      budget_tokens: budget,
      ...(STREAM_THINKING ? {} : { display: "omitted" }),
    };
    // Server-side thinking pruning is only legal next to an enabled thinking block: sending it
    // alone is a 400, `clear_thinking_20251015 strategy requires thinking to be enabled`. The real
    // client never hits this because it always thinks; a model with no effort level does.
    body["context_management"] = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  }
  return body;
}

async function runAnthropic(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  onToken: ((token: string) => Promise<void> | void) | undefined,
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  const body = buildBody(config, messages, tools);

  const base = config.baseUrl && config.baseUrl.startsWith("http") ? config.baseUrl : ANTHROPIC_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/v1/messages?beta=true`;
  const payload = JSON.stringify(body);

  let lastErr: unknown;
  let tokensDelivered = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const token = await loadClaudeToken();
    if (!token) throw new Error("No Claude subscription token. Run /claude login to mint one.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
    const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          // x-api-key is never sent beside a bearer token.
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": BETAS,
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": USER_AGENT,
          "x-app": "cli",
          "x-claude-code-session-id": SESSION_ID,
          "x-stainless-arch": "x64",
          "x-stainless-lang": "js",
          "x-stainless-os": "Linux",
          "x-stainless-package-version": CLI_RELEASE.stainlessPackage,
          "x-stainless-retry-count": String(attempt - 1),
          "x-stainless-runtime": "node",
          "x-stainless-runtime-version": CLI_RELEASE.nodeVersion,
          "x-stainless-timeout": String(ANTHROPIC_TIMEOUT_MS / 1000),
          ...config.headers,
        },
        body: payload,
        signal: fetchSignal,
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        const err = new Error(`Anthropic request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
        err.status = response.status;
        if (attempt < MAX_ATTEMPTS && !tokensDelivered && RETRYABLE_STATUS.has(response.status)) {
          const delay = retryDelay(response, attempt);
          await log("warn", `Anthropic ${response.status}, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS})`);
          await sleep(delay);
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (!response.body) throw new Error("Anthropic response has no body");

      const wrappedOnToken = onToken
        ? async (t: string) => {
            tokensDelivered = true;
            await onToken(t);
          }
        : undefined;
      return await processStream(response.body, wrappedOnToken, reasoningSink);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") {
        lastErr = new Error(`Anthropic request timed out after ${ANTHROPIC_TIMEOUT_MS}ms`);
      }
      if (attempt < MAX_ATTEMPTS && !tokensDelivered && err instanceof TypeError) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        await log("warn", `Anthropic transient error, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message}`);
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

export function anthropicResponse(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return runAnthropic(config, messages, tools, undefined, signal);
}

export function anthropicResponseStream(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  return runAnthropic(config, messages, tools, onToken, signal, reasoningSink);
}

export const __testing = { billingHeader, billingSuffix, billingSampleText, buildBody, buildRequest, buildSystem, wireToolName, localToolName, normalizeUsage };
