import { DEFAULT_CONTEXT_TOKENS, estimateMessagesTokens } from "./tokens.ts";
import { resolveContextCap, tagNameOf, tagRouteOf, type MyClawConfig, type AgentToolType, type LlmConfig } from "../core/config.ts";
import { findModel, leafModelId } from "./resolver.ts";
import { matchesAnyGlob } from "../utils/glob.ts";
import type { ContextLookup } from "./pricing.ts";
import type { ChatMessage } from "./provider.ts";

/**
 * The ceiling the selected tag-route candidate pins for a run (`tag:<name>` in config.tags,
 * docs/tags.md). A candidate's cap is deliberate per-model policy, so it outranks the
 * agent/global standing cap; a session's own override still wins over everything.
 */
function resolveTagContextCap(config: MyClawConfig, modelId: string): number | undefined {
  const name = tagNameOf(modelId);
  if (name === undefined) return undefined;
  const tag = name === "Default" ? undefined : tagsOf(config)?.[name];
  const cap = tagRouteOf(tag)?.[0]?.contextCap;
  return cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined;
}

/**
 * `tags` lives on the root config and the llm view is a boot-time mirror of it (index.ts). Reading
 * only one of the two is how a partial config -- a reload that rebuilt the llm view, a caller that
 * assembled its own -- silently lost every tag ceiling.
 */
function tagsOf(config: MyClawConfig): LlmConfig["tags"] {
  return config.tags ?? config.llm?.tags;
}

/**
 * The ceiling in force for this model under this agent. A tag's own cap is deliberate per-model
 * policy, so it outranks the standing agent/global one. Exported because the menus have to offer
 * exactly the ceiling the run will apply: two implementations of this precedence is how a tag came
 * to be offered a list built from the agent's cap while the run used the tag's.
 */
export function standingContextCap(
  config: MyClawConfig,
  modelId: string,
  agent?: AgentToolType | "orchestrator",
): number | undefined {
  return resolveTagContextCap(config, modelId) ?? resolveContextCap(config, agent);
}

/**
 * The window for a model id as every display should read it: the id keeps its identity (a tag's
 * own cap applies to it) while the declared window comes from the model the id ends on.
 */
export function resolveModelContextWindow(
  config: MyClawConfig,
  modelId: string,
  sessionOverride?: ContextOverride,
  agent: AgentToolType | "orchestrator" = "main",
): ResolvedContextWindow {
  return resolveContextWindow({
    ...declaredWindowOf(config, modelId),
    sessionOverride,
    agent,
  });
}

/**
 * The window a model declares, whole: no cap, no exemption, no session override.
 *
 * Every compaction pass sizes its verbatim tail on this window (`retainedBudgetFor`,
 * docs/compaction.md), the automatic gates and `/compact` alike. The ceilings the other readers
 * apply -- the standing cap, a tag route's cap, the session's own choice -- are what the
 * *trigger* reads: they decide when a run compacts, never how much a split keeps. The last rung
 * stands: a model declaring no window of its own still inherits `llm.limit.context`.
 */
export function resolveFullContextWindow(config: MyClawConfig, modelId: string): ResolvedContextWindow {
  const { raw, rawSource, approximate } = resolveRaw(declaredWindowOf(config, modelId));
  const out: ResolvedContextWindow = { raw, effective: raw, rawSource };
  if (approximate) out.approximate = true;
  return out;
}

/**
 * Where a model id carries its declared window: the model the id ends on (a `tag:` reference
 * reports the window of the model behind it), plus the fallback the resolver hands the run.
 */
function declaredWindowOf(config: MyClawConfig, modelId: string): ResolveWindowOptions {
  const tags = tagsOf(config);
  const leaf = leafModelId(tags && !config.llm?.tags ? { ...config.llm, tags } : config.llm, modelId);
  const entry = config.llm ? findModel(config.llm, leaf) : undefined;
  return {
    model: modelId,
    config,
    // The same fallback the resolver hands the run: a model with no window of its own inherits
    // the global one, so a menu cannot offer a number the run would not use.
    declared: entry?.limit?.context ?? config.llm?.limit?.context,
    declaredSource: entry?.contextFrom,
  };
}

/**
 * How much context a model may hold, and how full it currently is.
 *
 * Three questions that used to share one answer -- a bare `DEFAULT_CONTEXT_TOKENS` -- and are kept
 * apart here: what window the model has (resolution), how much of it we agree to use (cap), and
 * how much is already occupied (measure). See docs/context-window.md.
 */

export type ContextSource = "declared" | "models.dev" | "openrouter" | "openrouter-endpoint" | "default";

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
  /** A route candidate's cap, before the standing agent/global cap. */
  capOverride?: number;
}

export function resolveContextWindow(opts: ResolveWindowOptions): ResolvedContextWindow {
  const { raw, rawSource, approximate } = resolveRaw(opts);

  const out: ResolvedContextWindow = { raw, effective: raw, rawSource };
  if (approximate) out.approximate = true;

  // Precedence: session override, then the tag's own ceiling, then the agent cap, then the
  // global cap. A conversation has said the most recent and most specific thing, so it wins
  // over both -- in either direction. A route candidate pins its cap (docs/tags.md), so that cap
  // outranks the agent's standing ceiling for this attempt.
  const override = opts.sessionOverride;
  if (typeof override === "number" && override > 0) {
    if (override < raw) {
      out.effective = override;
      out.cappedFrom = raw;
    }
    out.overridden = true;
    return out;
  }

  const cap = opts.capOverride ?? standingContextCap(opts.config, opts.model, opts.agent);
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
 * array is rebuilt every iteration from a system prompt plus injections plus trimming, so its
 * length is not a stable index into anything. Session history only grows during a run, which makes
 * it the one count both sides can agree on.
 *
 * The `pruned` field was removed: all prompts are now sent whole (docs/prompt-immutable.md),
 * so there is only one shape and the field no longer serves a purpose. Old meta.json files
 * may still carry it; it is ignored on read.
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
export function measuredPrompt(
  promptTokens: number,
  historyLength: number,
): MeasuredPrompt | undefined {
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
 *
 * `fixed` is the system prompt plus the tool schemas: real occupancy that no estimate over the
 * history can see. It matters because the two readings were in different units -- a billed prompt
 * counts it, an estimate does not, and the gap measured 33k on a live 22-message prompt (46 370
 * billed against 13 337 estimated). Whenever the estimate branch won, that much window went
 * unseen. Only added there, since a measurement already contains it.
 */
export function occupiedContextTokens<T>(
  history: readonly T[],
  toChat: (messages: readonly T[]) => ChatMessage[],
  measured?: MeasuredPrompt,
  fixed = 0,
): number {
  const estimated = estimateMessagesTokens(toChat(history));
  if (!measured || measured.tokens <= 0) return estimated + fixed;
  // A shorter history than the measurement covered means compaction or a rewrite happened, which
  // invalidates it outright: the tokens it counted are no longer in the prompt.
  if (measured.messageCount > history.length) return estimated + fixed;
  const delta = estimateMessagesTokens(toChat(history.slice(measured.messageCount)));
  // Never read lower than the pure estimate, so this can only tighten the gate, never loosen it.
  // `fixed` only on the estimate: a billed size already contains the system prompt and the tool
  // schemas, while `delta` is history added since and does not.
  return Math.max(estimated + fixed, measured.tokens + delta);
}


