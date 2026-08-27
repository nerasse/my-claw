import type { ResolvedLlmConfig } from "../core/config.ts";

/**
 * How long a transport waits with not one byte received -- docs/llm-timeout.md.
 *
 * The defaults live together here rather than one per transport file, because they are three
 * answers to the same question and the only way to see that they disagree on purpose is to read
 * them side by side. They are the fallback: a model's own `timeoutMs` (else the global one) wins,
 * and `0` means no timer of ours at all.
 */

/** Home loop, OpenAI-compatible. Also the budget between two tokens of a stream. */
export const OPENAI_TIMEOUT_MS = 120_000;
/** Codex Responses: a subscription backend that thinks for a long time before answering. */
export const CODEX_TIMEOUT_MS = 300_000;
/** Anthropic Messages: same, with an extended-thinking ceiling that goes further still. */
export const ANTHROPIC_TIMEOUT_MS = 600_000;

/**
 * The default of the transport a resolved config will run on. Only a reporting surface needs it:
 * a transport already knows its own constant and passes it in, while `/status` does not, since
 * which of the three answers applies is exactly what it is trying to tell the owner.
 */
export function transportTimeoutDefault(backend: ResolvedLlmConfig["backend"]): number {
  if (backend === "codex") return CODEX_TIMEOUT_MS;
  if (backend === "anthropic") return ANTHROPIC_TIMEOUT_MS;
  return OPENAI_TIMEOUT_MS;
}

/**
 * The budget in force for this run, in milliseconds. `0` is a legal answer and means the caller
 * must not arm a timer: the owner's Stop signal is then the only wall.
 *
 * `fallback` is the transport's own default, passed in rather than looked up, because which
 * transport is running is something the caller knows and this module should not have to decide.
 */
export function requestTimeoutMs(config: Pick<ResolvedLlmConfig, "timeoutMs">, fallback: number): number {
  const declared = config.timeoutMs;
  if (declared === undefined || !Number.isFinite(declared) || declared < 0) return fallback;
  return Math.floor(declared);
}

/**
 * Where the budget came from, for an error message and for /status. A run that timed out has to
 * say which wall cut it: naming a number without its provenance sends the owner editing the wrong
 * one, and that is exactly what a hardcoded constant in the message used to do.
 */
export function timeoutSourceOf(config: Pick<ResolvedLlmConfig, "timeoutMs" | "timeoutFrom">): string {
  if (config.timeoutMs === undefined) return "default";
  return config.timeoutFrom ?? "declared";
}

/** `900s (model)`, `120s (default)`, `none (Stop only)`. One spelling, every surface. */
export function describeTimeout(config: Pick<ResolvedLlmConfig, "timeoutMs" | "timeoutFrom">, fallback: number): string {
  const ms = requestTimeoutMs(config, fallback);
  if (ms === 0) return "none (Stop only)";
  const seconds = ms / 1000;
  const spelled = Number.isInteger(seconds) ? `${seconds}s` : `${ms}ms`;
  return `${spelled} (${timeoutSourceOf(config)})`;
}
