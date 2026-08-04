import { DEFAULT_CONTEXT_TOKENS, estimateMessagesTokens } from "./tokens.ts";
import { resolveContextCap, type MyClawConfig, type AgentToolType } from "../core/config.ts";
import { matchesAnyGlob } from "../utils/glob.ts";
import type { ContextLookup } from "./pricing.ts";
import type { ChatMessage } from "./provider.ts";

/**
 * How much context a model may hold, and how full it currently is.
 *
 * Three questions that used to share one answer -- a bare `DEFAULT_CONTEXT_TOKENS` -- and are kept
 * apart here: what window the model has (resolution), how much of it we agree to use (cap), and
 * how much is already occupied (measure). See docs/context-window.md.
 */

export type ContextSource = "declared" | "models.dev" | "default";

export interface ResolvedContextWindow {
  /** What the model can hold, before any policy is applied. */
  raw: number;
  /** What the run is allowed to use. Never above `raw`. */
  effective: number;
  rawSource: ContextSource;
  /** Set only when the cap actually lowered the window, so callers can explain the number. */
  cappedFrom?: number;
  /** The session asked for the full window on a model the cap would otherwise have lowered. */
  overridden?: boolean;
  /** The window came from a matched id or a median rather than the model itself. */
  approximate?: boolean;
}

/**
 * What a single conversation asked for: the model's whole window, or an explicit ceiling in tokens.
 * A number may sit below the standing cap as well as above it -- the point is not only to lift the
 * policy but to tighten it on a conversation where a smaller prompt is worth the trade.
 */
export type ContextOverride = "full" | number;

interface WindowSource {
  contextWindowOf(model: string, baseUrl?: string, upstreamApiBase?: string): ContextLookup | undefined;
}

export interface ResolveWindowOptions {
  model: string;
  config: MyClawConfig;
  /** Already-resolved limit for this model: a config declaration, else provider discovery. */
  declared?: number;
  /**
   * Where `declared` came from, when the caller knows. The boot-time enrichment pass writes the
   * models.dev window into the same field a declaration uses, so provenance has to travel with it
   * or /status cannot tell a curated number from a third-party one.
   */
  declaredSource?: ContextSource;
  baseUrl?: string;
  upstreamApiBase?: string;
  /** models.dev table. Optional so resolution still works before the table is on disk. */
  table?: WindowSource;
  sessionOverride?: ContextOverride;
  /** Agent whose own ceiling applies, when the run belongs to one. */
  agent?: AgentToolType | "orchestrator";
}

export function resolveContextWindow(opts: ResolveWindowOptions): ResolvedContextWindow {
  const { raw, rawSource, approximate } = resolveRaw(opts);

  const out: ResolvedContextWindow = { raw, effective: raw, rawSource };
  if (approximate) out.approximate = true;

  // Precedence: session override, then exemption, then the cap. A conversation has said the most
  // recent and most specific thing, so it wins over both -- in either direction.
  const override = opts.sessionOverride;
  if (typeof override === "number" && override > 0) {
    if (override < raw) {
      out.effective = override;
      out.cappedFrom = raw;
    }
    out.overridden = true;
    return out;
  }

  const cap = resolveContextCap(opts.config, opts.agent);
  const exempt = matchesAnyGlob(opts.model, opts.config.context?.capExempt);
  if (cap === undefined || override === "full" || exempt || raw <= cap) {
    // Only claim an override when it changed something, so /status does not advertise a session
    // choice that made no difference on a model already below the cap.
    if (override === "full" && cap !== undefined && raw > cap) out.overridden = true;
    return out;
  }
  out.effective = cap;
  out.cappedFrom = raw;
  return out;
}

function resolveRaw(opts: ResolveWindowOptions): { raw: number; rawSource: ContextSource; approximate?: boolean } {
  if (opts.declared !== undefined && opts.declared > 0) {
    return { raw: opts.declared, rawSource: opts.declaredSource ?? "declared" };
  }
  const hit = opts.table?.contextWindowOf(opts.model, opts.baseUrl, opts.upstreamApiBase);
  if (hit) return { raw: hit.tokens, rawSource: "models.dev", approximate: hit.approximate };
  return { raw: DEFAULT_CONTEXT_TOKENS, rawSource: "default" };
}

/**
 * Exact prompt size billed on the last call, with the history it covered.
 *
 * `messageCount` counts session history entries, not the `ChatMessage` array actually sent: that
 * array is rebuilt every iteration from a system prompt plus injections plus pruning plus
 * trimming, so its length is not a stable index into anything. Session history only grows during a
 * run, which makes it the one count both sides can agree on.
 */
export interface MeasuredPrompt {
  tokens: number;
  messageCount: number;
}

/**
 * A measurement worth keeping, or undefined so the caller leaves the previous one in place.
 *
 * Both engines record usage through their own accumulator, so the rule lives here rather than being
 * written twice. A zero prompt is not a measurement: providers report it on some error paths, and
 * storing it would blind the gate until the next successful call.
 */
export function measuredPrompt(promptTokens: number, historyLength: number): MeasuredPrompt | undefined {
  if (promptTokens <= 0) return undefined;
  return { tokens: promptTokens, messageCount: historyLength };
}

/**
 * How full the window is, in the units the provider bills.
 *
 * `chars/4` under-counts badly -- the first live measurement read 10k billed against 4 281
 * estimated, 2.3x -- which would make a cap miss its target by the same factor. The measurement
 * describes the prompt *as sent*, so it lags by a turn; pairing it with the message count it
 * covered lets the settled history stay exact while only the newest turn is estimated.
 */
export function occupiedContextTokens<T>(
  history: readonly T[],
  toChat: (messages: readonly T[]) => ChatMessage[],
  measured?: MeasuredPrompt,
): number {
  const estimated = estimateMessagesTokens(toChat(history));
  if (!measured || measured.tokens <= 0) return estimated;
  // A shorter history than the measurement covered means compaction or a rewrite happened, which
  // invalidates it outright: the tokens it counted are no longer in the prompt.
  if (measured.messageCount > history.length) return estimated;
  const delta = estimateMessagesTokens(toChat(history.slice(measured.messageCount)));
  // Never read lower than the pure estimate, so this can only tighten the gate, never loosen it.
  return Math.max(estimated, measured.tokens + delta);
}
