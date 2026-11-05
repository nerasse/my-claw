import { createHash, randomUUID } from "node:crypto";
import type { EffortLevel, ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError, sleep } from "../core/aborted.ts";
import { isRetryableStatus, retryDelayMs, parseRetryAfterMs, wallAhead } from "./retry.ts";
import { log } from "../utils/logger.ts";
import { anthropicAuthHeaders } from "./anthropic-auth.ts";
import { claudeRelease, claudeUserAgent } from "./anthropic-release.ts";
import { checkCircuitBreaker, recordCircuitFailure, recordCircuitSuccess, countsTowardBreaker } from "./provider.ts";
import { isQuotaSpent } from "./outage.ts";
import { OWNER_STEERING_NOTE } from "../agent/owner-steering.ts";
import { clampEffortToLadder } from "./effort-ladder.ts";
import { ReasoningSegmenter } from "./reasoning-segments.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ThinkingBlock, ToolCall } from "./provider.ts";
import { ANTHROPIC_TIMEOUT_MS, llmFetchInit, requestTimeoutMs, timeoutSourceOf } from "./request-timeout.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const MAX_ATTEMPTS = 3;
/** A stream that died mid-answer gets more room: the request was fine, and the answer was under way. */
const STREAM_ATTEMPTS = 5;

/**
 * A failure Anthropic announced from inside the message stream.
 *
 * Same rule as the Codex transport, and the same history: an `error` event was thrown as a plain
 * `Error`, so a stream that died after the first word ended the run with no retry and no reroute --
 * while the error type it carries (`overloaded_error`, `api_error`) is exactly the transient one a
 * replay is for.
 *
 * The types this install knows are the ones the Messages API documents; anything unrecognised is
 * treated as transient, because an unknown code has never meant "your request was wrong".
 */
export class AnthropicStreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(event: Record<string, unknown>) {
    const wrapped = (event["error"] ?? {}) as Record<string, unknown>;
    const code = typeof wrapped["type"] === "string" ? wrapped["type"] : "";
    const detail = (typeof wrapped["message"] === "string" && wrapped["message"]) || "the stream said nothing about why";
    const kind = KIND_OF_TYPE.get(code.toLowerCase()) ?? "unknown";
    super(
      kind === "rate_limit"
        ? `Anthropic rate limit (${code}): ${detail}`
        : kind === "terminal"
          ? `Anthropic ${code}: ${detail}`
          : `Anthropic stream error (${code || "unknown"}): ${detail}`,
    );
    this.name = "AnthropicStreamError";
    this.code = code;
    this.retryable = kind === "rate_limit" || kind === "unknown";
    // A rate limit is a 429 on the non-streaming path, and the wall oracle only answers for a 429:
    // without the status a five-hour window would be replayed three times before anyone asked.
    if (kind === "rate_limit") this.status = 429;
  }
}

type AnthropicFailureKind = "rate_limit" | "terminal" | "unknown";

const KIND_OF_TYPE = new Map<string, AnthropicFailureKind>([
  ...["overloaded_error", "api_error", "server_error", "timeout_error"].map((type): [string, AnthropicFailureKind] => [type, "unknown"]),
  ["rate_limit_error", "rate_limit"],
  ...["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "billing_error"]
    .map((type): [string, AnthropicFailureKind] => [type, "terminal"]),
]);
/**
 * Only reached when neither the provider nor models.dev declares an output limit. Taken from the
 * client's own fallback ceiling (`aph` in the 2.1.206 bundle, next to `sph = 32000`).
 */
const FALLBACK_OUTPUT_LIMIT = 128_000;

// Order matters: reproduced verbatim from docs/captures/claude-cli-2.1.280.json (identical to the
// 2.1.261 list, measured).
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

/**
 * Whether to ask for the reasoning text or only for its token count. Read per request: the lever
 * lives beside the version one in `.env`, and both must apply to the next call of a run in flight.
 *
 * `true` sends `display: "summarized"`, so thinking arrives as `thinking_delta` events and reaches
 * the reasoning sink exactly as the Codex transport's `response.reasoning_text.delta` does. That is
 * what makes this backend behave like every other model in the picker rather than like a black box.
 *
 * It is the one field where we knowingly differ from the captured client, which sends `"omitted"`.
 * Two costs, both accepted: the first text token arrives later (skipping thinking tokens is the
 * documented point of `"omitted"`), and the reasoning text crosses the wire. Nothing else changes,
 * the thinking happens and is billed either way. Measured on one prompt, same model: `"omitted"`
 * returned `{thinking_tokens: 57}` with an empty thinking block, `"summarized"` returned 54 with the
 * text. `ANTHROPIC_HIDE_THINKING=1` restores the captured shape without a rebuild.
 */
function streamThinking(): boolean {
  claudeRelease();
  return process.env["ANTHROPIC_HIDE_THINKING"] !== "1";
}


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
  const { version } = claudeRelease();
  const suffix = billingSuffix(sampleText, version);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli;`;
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
  cache_control?: typeof CACHE_1H;
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
  content: string | AnthropicBlock[];
  cache_control?: typeof CACHE_1H;
}
interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
}

type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicThinkingBlock;

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
  // and a fourth breakpoint would exceed Anthropic's cap of four (2 system + 1 final turn).
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
 * One stored thinking block, as the wire wants it -- or nothing.
 *
 * A signature is not optional on the way back in. Anthropic verifies it against the block and
 * rejects an unsigned one, so a block whose signature never arrived (an aborted stream, a provider
 * that streams the text and not the `signature_delta`) cannot be replayed as thinking. It is
 * dropped: its text must never become an assistant text block, because a model that reads its own
 * reasoning as something it said goes on writing reasoning as text -- docs/reasoning-replay.md.
 * A `redacted_thinking` block with no payload has nothing to replay and is dropped too.
 */
function thinkingBlock(t: ThinkingBlock): AnthropicBlock[] {
  if (t.type === "redacted_thinking") return t.data ? [{ type: "redacted_thinking", data: t.data }] : [];
  if (!t.signature) return [];
  return [{ type: "thinking", thinking: t.thinking ?? "", signature: t.signature }];
}

/**
 * Who this request is, and whether it may hand reasoning back.
 *
 * Anthropic documents the replay as mandatory rather than optional within a tool-use turn:
 * "pass thinking blocks back... complete and unmodified". It also says to keep sending them when
 * the conversation switches models, because the API drops the blocks the target model cannot read
 * instead of failing the request. So the transport replays every signed block of this backend and
 * lets the API filter, rather than guessing compatibility itself -- docs/reasoning-replay.md.
 *
 * `model` is the wire model (`apiModel`), the same identity the chat and Codex transports tag
 * their state with. The provider reference also names the account, and an account is not a model:
 * two subscriptions serving `claude-opus-5-5` must not invalidate each other's signatures.
 *
 * Note it is deliberately *not* tied to `streamThinking()`: the signature is identical whether the
 * display is summarized or omitted, so an omitted block round-trips exactly as well.
 */
interface ReplayIdentity {
  backend: string;
  model: string;
  replay: boolean;
}

function replayIdentity(config: Partial<ResolvedLlmConfig>): ReplayIdentity {
  return { backend: "anthropic", model: config.apiModel ?? config.model ?? "", replay: config.reasoningReplay !== false };
}

/**
 * Split the prompt into the `system` blocks and the `messages` array.
 *
 * Two Anthropic rules shape this: roles must alternate, and the tool_result blocks answering one
 * assistant turn belong in a single user message. The home loop emits one `tool` message per call,
 * so consecutive same-role messages are merged rather than sent as-is.
 */
function buildRequest(messages: ChatMessage[], self?: ReplayIdentity): { system: string; turns: AnthropicMessage[] } {
  let system = "";
  const turns: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (!last || last.role !== role) {
      turns.push({ role, content: blocks });
      return;
    }
    /**
     * Merging two assistant turns would append a second signed thinking sequence behind the first
     * one's text, giving `thinking, text, thinking, text` -- a shape the API rejects, because the
     * consecutive thinking blocks of a message must be the ones that message generated and must
     * lead it. Claude Code has this exact bug and ships a 400 with it, so the incoming thinking is
     * dropped instead: the turn keeps one valid leading sequence and loses only continuity it
     * could not legally have carried. See docs/reasoning-replay.md.
     */
    last.content.push(...blocks.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking"));
  };

  // Where the last source message starts inside the final turn. Consecutive user-role messages
  // merge (a tool_result and the owner's next text become one user turn), so a turn boundary is
  // not a message boundary; the cache anchor needs the exact block.
  let lastMessageStart: { turn: number; block: number } | undefined;
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    const turnBefore = turns.length;
    const blockBefore = turns[turns.length - 1]?.role === "user"
      ? turns[turns.length - 1]!.content.length
      : 0;
    switch (msg.role) {
      case "system":
        // Anthropic has a single system slot, so a later system message (the iteration-limit
        // prompt) becomes a user turn, as on the Codex transport.
        if (!system) system = msg.content;
        else push("user", [{ type: "text", text: msg.content }]);
        break;
      case "user":
        // An empty text block fails the whole request ("text content blocks must be non-empty"),
        // and a retry reposts the same prompt: whatever produced it upstream, it does not go on the
        // wire. A user turn left with no block at all is skipped, and `push` merges the assistant
        // turns it would have separated.
        if (typeof msg.content === "string") {
          if (msg.content.trim()) push("user", [{ type: "text", text: msg.content }]);
        } else {
          push(
            "user",
            msg.content.flatMap((p): AnthropicBlock[] =>
              p.type === "text" ? (p.text.trim() ? [{ type: "text", text: p.text }] : []) : [imageBlock(p.image_url.url)],
            ),
          );
        }
        break;
      case "assistant": {
        const blocks: AnthropicBlock[] = [];
        // First in the turn, which is where the model put them and the only position the API
        // accepts. Only state this transport produced can be a thinking block; a foreign transport
        // has no signature this API would accept.
        const meta = msg.providerMeta;
        if (self?.replay && meta?.backend === self.backend && meta.thinking?.length) {
          for (const t of meta.thinking) blocks.push(...thinkingBlock(t));
        }
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
      case "tool": {
        // A tool's images belong inside its own tool_result -- that is what the block is for --
        // mapped through the same text/image shapes a user turn uses.
        const content: string | AnthropicBlock[] =
          typeof msg.content === "string"
            ? msg.content
            : msg.content.flatMap((p): AnthropicBlock[] =>
                p.type === "text"
                  ? p.text.trim()
                    ? [{ type: "text", text: p.text }]
                    : []
                  : [imageBlock(p.image_url.url)],
              );
        push("user", [{ type: "tool_result", tool_use_id: msg.tool_call_id, content }]);
        break;
      }
    }
    if (mi === messages.length - 1) {
      lastMessageStart = turns.length > turnBefore
        ? { turn: turns.length - 1, block: 0 }
        : { turn: turns.length - 1, block: blockBefore };
    }
  }

  // Cache the whole conversation, not just the system prefix: without a breakpoint on the final
  // turn, every agent iteration re-sends the entire history as fresh input tokens. The system
  // breakpoints alone cost ~12M input tokens on one observed 54-iteration run.
  //
  // The two conversation breakpoints are the points a request can actually reuse: the last
  // user-role turn of the *previous* request, which that request cached, and the tail this one
  // adds. At a run boundary the owner's new message is the tail, so the previous request's final
  // turn is the last user-role turn before it. Marking the owner's own turn a second time moves
  // the anchor forward instead: measured on one career session, every new user message sent a
  // 283k-token prompt with 10k read and 273k written, while the same session's tool iterations
  // read normally. Inside a run the tail is a tool result, and the owner's turn stays the stable
  // anchor.
  const lastTurn = turns[turns.length - 1];
  let ownerTurn: (typeof turns)[number] | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.role !== "user") continue;
    if (!turn.content.some((block) => block.type === "text" || block.type === "image")) continue;
    ownerTurn = turn;
    break;
  }
  const markLastCacheable = (turn: (typeof turns)[number] | undefined): void => {
    if (!turn) return;
    const block = turn.content[turn.content.length - 1];
    if (block && (block.type === "text" || block.type === "image" || block.type === "tool_result")) {
      block.cache_control = CACHE_1H;
    }
  };
  if (ownerTurn && ownerTurn === lastTurn) {
    // The request ends on the new user message. The turn the previous request ended on is the
    // block just before the last message when the two merged into one user turn, and the last
    // user-role turn otherwise; never the assistant reply the previous request wrote afterwards.
    const ownerIndex = turns.indexOf(ownerTurn);
    const previousBlock = lastMessageStart && lastMessageStart.turn === ownerIndex && lastMessageStart.block > 0
      ? ownerTurn.content[lastMessageStart.block - 1]
      : undefined;
    if (previousBlock && (previousBlock.type === "text" || previousBlock.type === "image" || previousBlock.type === "tool_result")) {
      previousBlock.cache_control = CACHE_1H;
    } else {
      let previousTurn: (typeof turns)[number] | undefined;
      for (let i = ownerIndex - 1; i >= 0; i--) {
        if (turns[i]!.role === "user") {
          previousTurn = turns[i];
          break;
        }
      }
      markLastCacheable(previousTurn);
    }
    markLastCacheable(ownerTurn);
  } else {
    markLastCacheable(ownerTurn);
    markLastCacheable(lastTurn);
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
  /** How many of the billed output tokens were thinking: a subset of `output_tokens`, never added. */
  output_tokens_details?: { thinking_tokens?: number };
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
  const thinking = raw.output_tokens_details?.thinking_tokens ?? 0;
  if (thinking > 0) usage.reasoningTokens = thinking;
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
  self?: ReplayIdentity,
  /**
   * Called on every line the stream produces, to re-arm the request timeout. The budget is silence
   * and not duration (docs/llm-timeout.md): extended thinking sends `ping` and `thinking_delta`
   * for minutes before a single output token, and every one of them is a byte received.
   */
  keepAlive?: () => void,
): Promise<LlmResponse> {
  let content = "";
  let reasoning = "";
  const segmenter = new ReasoningSegmenter();
  let rawUsage: AnthropicUsage | undefined;
  let outputTokens = 0;
  let finishReason: string | undefined;
  const slots = new Map<number, ToolUseSlot>();
  const order: number[] = [];
  /**
   * Thinking blocks under construction, by block index. Text arrives as `thinking_delta` and the
   * signature separately as `signature_delta`, so a block is only complete once the stream moves
   * on. Kept in index order, because Anthropic validates the sequence and not just each block.
   */
  const thinkingBlocks = new Map<number, ThinkingBlock>();

  for await (const line of readLines(body)) {
    keepAlive?.();
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
        const block = event["content_block"] as { type?: string; id?: string; name?: string; thinking?: string; signature?: string; data?: string } | undefined;
        if (block?.type === "tool_use") {
          const index = Number(event["index"] ?? 0);
          slots.set(index, { id: block.id ?? "", name: block.name ?? "", json: "" });
          order.push(index);
        } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
          // `redacted_thinking` carries `data` and never any text: it is opaque even to the sink,
          // and replaying it is the only thing it is good for.
          thinkingBlocks.set(Number(event["index"] ?? 0), {
            type: block.type,
            thinking: block.thinking ?? "",
            ...(block.signature ? { signature: block.signature } : {}),
            ...(block.data ? { data: block.data } : {}),
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event["delta"] as { type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string } | undefined;
        if (delta?.type === "signature_delta" && delta.signature) {
          const block = thinkingBlocks.get(Number(event["index"] ?? 0));
          if (block) block.signature = (block.signature ?? "") + delta.signature;
          break;
        }
        if (delta?.type === "text_delta" && delta.text) {
          content += delta.text;
          segmenter.text(delta.text);
          if (onToken) await onToken(delta.text);
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          const block = thinkingBlocks.get(Number(event["index"] ?? 0));
          if (block) block.thinking = (block.thinking ?? "") + delta.thinking;
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
        const delta = event["delta"] as { stop_reason?: string | null } | undefined;
        if (delta?.stop_reason) finishReason = delta.stop_reason;
        const usage = event["usage"] as AnthropicUsage | undefined;
        if (usage?.output_tokens) outputTokens = usage.output_tokens;
        // The thinking count only exists once the answer is written, on this last event.
        if (usage?.output_tokens_details) rawUsage = { ...rawUsage, output_tokens_details: usage.output_tokens_details };
        break;
      }
      case "error": {
        const failure = new AnthropicStreamError(event);
        void log("warn", "anthropic stream failure event", {
          code: failure.code,
          message: failure.message.slice(0, 500),
          retryable: failure.retryable,
          event: JSON.stringify(event).slice(0, 2000),
        });
        throw failure;
      }
    }
  }

  const toolCalls: ToolCall[] = order
    .map((i) => slots.get(i)!)
    .filter((s) => s.id && s.name)
    .map((s) => ({ id: s.id, name: localToolName(s.name), arguments: safeJson(s.json || "{}") }));

  const thinking = [...thinkingBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const segments = segmenter.list();
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    ...(self && thinking.length > 0 ? { providerMeta: { backend: self.backend, model: self.model, thinking } } : {}),
    // A normal end_turn is still incomplete when Anthropic emitted only thinking. The user needs
    // an answer or a tool call; reasoning alone must not look like a successful final turn.
    incomplete: !content && toolCalls.length === 0,
    usage: normalizeUsage(rawUsage, outputTokens),
    ...(reasoning ? { reasoning } : {}),
    ...(segments ? { segments } : {}),
  };
}

// ============================================================================
// Transport
// ============================================================================

/**
 * Effort levels the Messages API accepts, in the documented ladder. `high` is the API default, so
 * naming it is identical to omitting the parameter.
 *
 * `output_config.effort` is the real mechanism, documented at
 * platform.claude.com/docs/en/build-with-claude/effort, and it needs no beta header. It is a
 * behavioural signal rather than a token budget: it shapes every token in the response, tool calls
 * included, and it works with or without thinking. An earlier version of this file mapped effort
 * onto `thinking.budget_tokens` through a share table, which was wrong in kind, not merely in
 * calibration.
 *
 * Declared as the ordered ladder rather than a set: it is also the last line of defence for a level
 * that reached here off-ladder, and dropping one silently is the worst of the three outcomes,
 * because the server then applies `high` and a request for `minimal` gets nearly the most.
 *
 * **Per model, not per family.** The union below is only the fallback for a model whose ladder we
 * never read: validation happens against the model's own list, measured on the wire as
 * `HTTP 400 This model does not support effort level 'xhigh'. Supported levels: high, low, max,
 * medium.` for Sonnet 4.6, which publishes four rungs while Opus 5 publishes five. So the ladder
 * the model declared through `/v1/models` is what clamps when it is known.
 *
 * There is no off rung. Anthropic's ladder starts at `low`, so "as little as possible" clamps to
 * `low` and thinking is governed by the model's declared types, not by effort.
 */
const API_EFFORT_LADDER: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The reply budget, resolved rather than pinned: the provider's own declared output limit first
 * (`/v1/models`, carried through the catalogue and the resolver), then the models.dev table that
 * backs every other provider, then 128000.
 *
 * 128000 is not a guess: it is the client's own fallback ceiling, `aph` in the bundle, sitting
 * beside `sph = 32000` which is its fallback *default*. We take the ceiling because a model that
 * declares nothing should not be capped below what the vendor itself allows.
 */
function maxTokensFor(config: Partial<ResolvedLlmConfig>): number {
  const declared = config.limit?.output;
  return declared && declared > 0 ? declared : FALLBACK_OUTPUT_LIMIT;
}

/**
 * The `thinking` block, chosen from what the model says it accepts rather than from its name.
 *
 * `/v1/models` reports `capabilities.thinking.types` per model, and the two are not
 * interchangeable: Opus 5 reports `enabled: false`, so an explicit `budget_tokens` request to it is
 * a 400. Adaptive carries no budget at all, which is the point of it: the server decides the depth,
 * steered by `output_config.effort`, and the docs call that the recommended control wherever
 * adaptive exists.
 *
 * Never `{ type: "disabled" }`: on Opus 5 that is a 400 at xhigh and max effort, and omitting the
 * block expresses the same thing without the failure mode.
 */
function thinkingFor(
  types: { adaptive: boolean; enabled: boolean } | undefined,
  maxTokens: number,
): { type: "adaptive" | "enabled"; budget_tokens?: number; display?: "omitted" | "summarized" } | undefined {
  if (!types?.adaptive && !types?.enabled) return undefined;
  // Named in both directions on purpose. Leaving the field out is not neutral: `omitted` is already
  // the default on Opus 5, Sonnet 5, Fable 5 and Opus 4.7/4.8, so an absent field returns empty
  // thinking blocks on exactly the models we care about.
  const display = { display: streamThinking() ? ("summarized" as const) : ("omitted" as const) };
  if (types.adaptive) return { type: "adaptive", ...display };
  // Extended-thinking-only models still need a number. The client's own formula, from the 2.1.206
  // bundle: the model's output ceiling minus one, clamped to at least 1024.
  return { type: "enabled", budget_tokens: Math.max(1024, maxTokens - 1), ...display };
}

/**
 * Models that answered 400 to `thinking: {type: "disabled"}`. Learned rather than listed: whether
 * thinking can be turned off is **not** in `/v1/models` (its `capabilities.thinking.types` reports
 * only `adaptive` and `enabled`), and the answer differs inside one generation. Measured:
 * Opus 5 accepts it, Fable 5 answers `"thinking.type.disabled" is not supported for this model`.
 * A hardcoded list would be wrong the day Anthropic ships the next model, so the first refusal per
 * model per process is what teaches this, and the request is replayed with thinking left on.
 */
const cannotDisableThinking = new Set<string>();
const DISABLE_REFUSED = /thinking\.type\.disabled/;

/**
 * With thinking off, effort is capped: Opus 5 answers `output_config.effort 'max' is not supported
 * when thinking is disabled on this model. Use effort 'high' or below.` The floor is what `none`
 * means anyway, so the two constraints agree.
 */
const THINKING_OFF_EFFORT: EffortLevel = "low";

/** Whether this request asks for no thinking at all, and the model has not already refused. */
function wantsThinkingOff(config: Partial<ResolvedLlmConfig>): boolean {
  return config.effort === "none" && !cannotDisableThinking.has(config.model ?? "");
}

const warnedThinkingOff = new Set<string>();

/**
 * Anthropic documents a failure mode that matters more here than anywhere else: with thinking off,
 * Opus 5 "can occasionally emit tool calls as plain text or include internal XML tags in its visible
 * output". In an agent loop that is silent breakage, the model narrates the tool call and nothing
 * runs, so the reason lands in the log once per model rather than being discovered from behaviour.
 */
function warnThinkingOffWithTools(model: string, toolCount: number): void {
  if (toolCount === 0 || warnedThinkingOff.has(model)) return;
  warnedThinkingOff.add(model);
  void log("warn", "thinking is off on a request carrying tools; tool calls can arrive as plain text", { model, tools: toolCount });
}

/** The whole request body, pure so P2 can diff it against the capture without a network call. */
function buildBody(config: Partial<ResolvedLlmConfig>, messages: ChatMessage[] = [], tools?: unknown[]): Record<string, unknown> {
  const { system, turns } = buildRequest(messages, replayIdentity(config));
  const anthropicTools = convertTools(tools);

  // Appended here rather than by the prompt builder, for the same reason the SDK appends it after
  // composition: it must be the last thing the model reads, and it is a property of talking to a
  // Claude model, not of any workspace's prompt. Static, so it stays inside the cached prefix.
  const withNote = system + OWNER_STEERING_NOTE;

  const maxTokens = maxTokensFor(config);
  const body: Record<string, unknown> = {
    model: config.apiModel ?? config.model ?? "",
    max_tokens: maxTokens,
    system: buildSystem(withNote, billingSampleText(messages)),
    messages: turns,
    stream: true,
  };
  if (anthropicTools.length > 0) body["tools"] = anthropicTools;

  // A request-level setting, and one that invalidates the cached prefix when it changes mid
  // conversation (the docs are explicit: effort shapes the rendered prompt). At a measured 96 %
  // cache-read ratio that makes a mid-session effort change expensive, so it is worth holding
  // constant rather than varying per turn.
  // `none` is a my-claw rung, never an API effort value: sending it is
  // `output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'`. It is
  // expressed by the thinking block below, and the effort that rides with it is the floor. That
  // holds whether the model accepted being told not to think or refused and left it on.
  const thinkingOff = wantsThinkingOff(config);
  const level = config.effort === "none" ? THINKING_OFF_EFFORT : config.effort;
  if (level) {
    const published = (config.effortLevels ?? []).filter((rung) => rung !== "none");
    const ladder = published.length > 0 ? published : API_EFFORT_LADDER;
    body["output_config"] = { effort: clampEffortToLadder(level, ladder, config.model ?? "") };
  }

  if (thinkingOff) {
    // No `display` beside it: `thinking.disabled.display: Extra inputs are not permitted`. And no
    // `context_management`, which needs thinking enabled or adaptive.
    body["thinking"] = { type: "disabled" };
    warnThinkingOffWithTools(config.model ?? "", anthropicTools.length);
    return body;
  }

  const thinking = thinkingFor(config.thinkingTypes, maxTokens);
  if (thinking) {
    body["thinking"] = thinking;
    // Server-side thinking pruning is only legal next to a thinking block: sending it alone is a
    // 400, `clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`. The real
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
  const base = config.baseUrl && config.baseUrl.startsWith("http") ? config.baseUrl : ANTHROPIC_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/v1/messages?beta=true`;
  let payload = JSON.stringify(buildBody(config, messages, tools));

  // One breaker per endpoint, shared with the chat-completions client: a subscription outage
  // must stop being retried on every turn, not only inside one call's three attempts.
  checkCircuitBreaker(base);

  let lastErr: unknown;
  let tokensDelivered = false;
  /** Whether the attempt in flight put anything on screen, text or thinking. */
  let outputDelivered = false;
  /** How a dead attempt's words are taken back before it is replayed; the channel provides it. */
  const restart = reasoningSink?.onRestart;
  const wrappedReasoning: ReasoningSink | undefined = reasoningSink?.onText
    ? {
        ...reasoningSink,
        onText: async (delta: string) => {
          outputDelivered = true;
          await reasoningSink.onText?.(delta);
        },
      }
    : reasoningSink;
  // The model's own declaration when it has one, else this transport's default -- extended
  // thinking on this backend runs far longer than a chat completion (docs/llm-timeout.md).
  const budget = requestTimeoutMs(config, ANTHROPIC_TIMEOUT_MS);

  for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    // Inside the loop, not above it: a subscription token can be refreshed between two attempts.
    const auth = await anthropicAuthHeaders({ apiKey: config.apiKey, apiKeyEnv: config.apiKeyEnv }, config.provider);
    if (!auth) throw new Error(`Provider "${config.provider ?? "anthropic"}" is not signed in to Claude. Sign in from Settings → Models.`);

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
          // Exactly one credential header, never `x-api-key` beside a bearer token.
          ...auth,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": BETAS,
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": claudeUserAgent(),
          "x-app": "cli",
          "x-claude-code-session-id": SESSION_ID,
          "x-stainless-arch": "x64",
          "x-stainless-lang": "js",
          "x-stainless-os": "Linux",
          "x-stainless-package-version": claudeRelease().stainlessPackage,
          "x-stainless-retry-count": String(attempt - 1),
          "x-stainless-runtime": "node",
          "x-stainless-runtime-version": claudeRelease().nodeVersion,
          // Announcing a wall we do not apply is worse than announcing none, so the header
          // carries the effective budget and is omitted when there is no timer at all.
          ...(budget > 0 ? { "x-stainless-timeout": String(budget / 1000) } : {}),
          ...config.headers,
        },
        body: payload,
        signal: fetchSignal,
      }));

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        const err = new Error(`Anthropic request failed: HTTP ${response.status} — ${detail}`) as Error & { status?: number };
        err.status = response.status;
        // A body this side never built: JSON.stringify cannot end a string inside a \u escape,
        // so a provider reporting one received a truncated request (network, proxy, relay).
        // Record the size made the next occurrence diagnosable (measured 13x, clustered 2026-10-02).
        if (response.status === 400 && /not valid JSON/i.test(detail) && /hex escape/i.test(detail)) {
          await log("warn", "provider rejected the request body as invalid JSON", { model: config.model, payloadChars: payload.length });
        }
        // The one 400 worth replaying: this model refuses to have thinking turned off. Remember it
        // and rebuild the body with thinking left on, so the turn answers instead of failing.
        if (response.status === 400 && DISABLE_REFUSED.test(detail) && wantsThinkingOff(config)) {
          cannotDisableThinking.add(config.model ?? "");
          await log("info", "model refuses thinking disabled, retrying with thinking on", { model: config.model });
          payload = JSON.stringify(buildBody(config, messages, tools));
          lastErr = err;
          continue;
        }
        // A spent quota is a 429 too, and no backoff refills it: straight to the caller's fallback.
        if (attempt < MAX_ATTEMPTS && !tokensDelivered && !isQuotaSpent(err) && !(await wallAhead(config, err)) && isRetryableStatus(response.status)) {
          const delay = retryDelayMs(attempt, parseRetryAfterMs(response));
          await log("warn", `Anthropic ${response.status}, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS})`);
          await sleep(delay, signal);
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (!response.body) throw new Error("Anthropic response has no body");

      const wrappedOnToken = onToken
        ? async (t: string) => {
            tokensDelivered = true;
            outputDelivered = true;
            await onToken(t);
          }
        : undefined;
      recordCircuitSuccess(base);
      return await processStream(response.body, wrappedOnToken, wrappedReasoning, replayIdentity(config), keepAlive);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = err;
      // Our own wall: not retried, and not counted against the endpoint (docs/llm-timeout.md).
      if (timedOut) {
        throw new Error(`Anthropic request timed out after ${budget}ms (${timeoutSourceOf(config)})`);
      }
      if (err instanceof AnthropicStreamError) {
        // The stream died mid-answer: replay it here, before the run's fallback gets a say. A wall
        // is the one refusal a replay cannot fix, and the oracle is what tells the two apart.
        const blocked = isQuotaSpent(err) || (await wallAhead(config, err));
        if (err.retryable && !blocked && attempt < STREAM_ATTEMPTS && (!outputDelivered || restart !== undefined)) {
          if (outputDelivered) await restart?.();
          outputDelivered = false;
          tokensDelivered = false;
          const delay = retryDelayMs(attempt);
          await log("warn", `Anthropic stream failed mid-answer, replaying in ${delay}ms (${attempt}/${STREAM_ATTEMPTS})`, {
            code: err.code,
          });
          await sleep(delay, signal);
          continue;
        }
        // Never counted against the endpoint: the breaker is keyed on a base URL a whole
        // subscription shares, and one account's dead stream says nothing about the endpoint.
        throw err;
      }
      if (attempt < MAX_ATTEMPTS && !tokensDelivered && err instanceof TypeError) {
        const delay = retryDelayMs(attempt);
        await log("warn", `Anthropic transient error, retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message}`);
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

export const __testing = {
  billingHeader,
  billingSuffix,
  billingSampleText,
  buildBody,
  buildRequest,
  buildSystem,
  maxTokensFor,
  thinkingFor,
  replayIdentity,
  wireToolName,
  localToolName,
  normalizeUsage,
  cannotDisableThinking,
  processStream,
};
