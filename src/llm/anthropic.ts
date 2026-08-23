import { createHash, randomUUID } from "node:crypto";
import type { EffortLevel, ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { AbortedError } from "../core/aborted.ts";
import { log } from "../utils/logger.ts";
import { loadClaudeToken } from "./claude-auth.ts";
import { CLI_RELEASE, CLAUDE_USER_AGENT } from "./anthropic-release.ts";
import { checkCircuitBreaker, recordCircuitFailure, recordCircuitSuccess, countsTowardBreaker } from "./provider.ts";
import { OWNER_STEERING_NOTE } from "../agent/owner-steering.ts";
import { clampEffortToLadder } from "./effort-ladder.ts";
import { ReasoningSegmenter } from "./reasoning-segments.ts";
import type { ChatMessage, LlmResponse, LlmUsage, ThinkingBlock, ToolCall } from "./provider.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_TIMEOUT_MS = 600_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;
/**
 * Only reached when neither the provider nor models.dev declares an output limit. Taken from the
 * client's own fallback ceiling (`aph` in the 2.1.206 bundle, next to `sph = 32000`).
 */
const FALLBACK_OUTPUT_LIMIT = 128_000;

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

/**
 * Whether to ask for the reasoning text or only for its token count.
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
const STREAM_THINKING = process.env["ANTHROPIC_HIDE_THINKING"] !== "1";


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
 * Who this request is, and whether it may hand reasoning back.
 *
 * Anthropic documents the replay as mandatory rather than optional: "within a tool-use turn, pass
 * thinking blocks back... complete and unmodified", and omitting them fails the request with
 * `thinking or redacted_thinking blocks in the latest assistant message cannot be modified`. So it
 * is on unless the owner turns the provider's `reasoningReplay` off, which is the escape hatch for
 * an endpoint that misbehaves -- and unlike the env var it replaces, that switch is hot-reloadable
 * and sits in the app. See docs/reasoning-replay.md.
 *
 * Note it is deliberately *not* tied to `STREAM_THINKING`: the signature is identical whether the
 * display is summarized or omitted, so an omitted block round-trips exactly as well.
 */
interface ReplayIdentity {
  backend: string;
  model: string;
  replay: boolean;
}

function replayIdentity(config: Partial<ResolvedLlmConfig>): ReplayIdentity {
  return { backend: "anthropic", model: config.model ?? "", replay: config.reasoningReplay !== false };
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
        // First in the turn, which is where the model put them and the only position the API
        // accepts. Same-model check as on the Codex transport: a signature is not portable.
        const meta = msg.providerMeta;
        if (self?.replay && meta && meta.backend === self.backend && meta.model === self.model) {
          for (const t of meta.thinking ?? []) blocks.push({ ...t });
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
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content }]);
        break;
    }
  }

  // Cache the whole conversation, not just the system prefix: without a breakpoint on the final
  // turn, every agent iteration re-sends the entire history as fresh input tokens. The system
  // breakpoints alone cost ~12M input tokens on one observed 54-iteration run. Total breakpoint
  // count stays at three (2 system + 1 final), under Anthropic's cap of four.
  const lastTurn = turns[turns.length - 1];
  if (lastTurn) {
    const lastBlock = lastTurn.content[lastTurn.content.length - 1];
    if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
      lastBlock.cache_control = CACHE_1H;
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
  /**
   * How many of the billed output tokens were thinking. Read only to be ignored: thinking is billed
   * *inside* `output_tokens`, so adding it would double it. Never reported to the reasoning sink,
   * see the `message_delta` case.
   */
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
        // `output_tokens_details.thinking_tokens` lands here and is deliberately not sent to
        // `reasoningSink.onTokens`. The count belongs to the redacted engine: the SDK bridge reports
        // it *while* the model thinks, so it opens the bubble the answer then fills. This one arrives
        // on the last event of the stream, after the answer, where the streamer seals the bubble and
        // opens a fresh one -- a stray "Thought . 14 tokens" bubble under a reply whose reasoning is
        // already displayed in full, and which no replay reproduces since the mirror stores no count
        // for this transport. This transport reports thinking as text, and only as text.
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

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
  const display = { display: STREAM_THINKING ? ("summarized" as const) : ("omitted" as const) };
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
          "user-agent": CLAUDE_USER_AGENT,
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
        // The one 400 worth replaying: this model refuses to have thinking turned off. Remember it
        // and rebuild the body with thinking left on, so the turn answers instead of failing.
        if (response.status === 400 && DISABLE_REFUSED.test(detail) && wantsThinkingOff(config)) {
          cannotDisableThinking.add(config.model ?? "");
          await log("info", "model refuses thinking disabled, retrying with thinking on", { model: config.model });
          payload = JSON.stringify(buildBody(config, messages, tools));
          lastErr = err;
          continue;
        }
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
      recordCircuitSuccess(base);
      return await processStream(response.body, wrappedOnToken, reasoningSink, replayIdentity(config));
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
      if (countsTowardBreaker(lastErr)) recordCircuitFailure(base);
      throw lastErr;
    } finally {
      clearTimeout(timeout);
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
  wireToolName,
  localToolName,
  normalizeUsage,
  cannotDisableThinking,
  processStream,
};
