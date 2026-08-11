import type { MyClawConfig, AgentToolType } from "../core/config.ts";
import { resolveModelContextWindow, standingContextCap, type ContextOverride } from "../llm/context-window.ts";

/**
 * The context step of the `/model` flow: which ceilings are worth offering for this model, and
 * which one is currently in force.
 *
 * Shared by both channels for the same reason `status-command.ts` is: the two adapters had byte
 * identical bodies for every other picker step, and a divergence here would mean one channel
 * offering a window the other refuses. See docs/context-window.md.
 */

/** Ceilings offered below the standing cap. Lowering a window is not only about lifting a policy:
 *  a shorter prompt is cheaper and faster, and sometimes worth it for one conversation. */
const LOWER_TIERS = [512_000, 256_000, 128_000, 64_000];

export interface ContextTier {
  /** `undefined` marks the full window, which is the model's own number rather than a ceiling. */
  ceiling?: number;
  tokens: number;
  label: string;
  selected: boolean;
}

export interface ContextChoice {
  /** False when there is nothing to arbitrate: a single option is not a choice. */
  available: boolean;
  raw: number;
  effective: number;
  tiers: ContextTier[];
}

function shortContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString("en-US");
}

/**
 * One compact line for model menus and `/models`. The first number is what this run may use; the
 * second is shown only when policy or a session/agent choice lowered the model's full window.
 */
export function formatContextInfo(
  config: MyClawConfig,
  modelId: string,
  override: ContextOverride | undefined,
  agent?: AgentToolType | "orchestrator",
): string {
  const choice = contextChoiceFor(config, modelId, override, agent);
  const effective = shortContextTokens(choice.effective);
  return choice.effective === choice.raw
    ? `Context: ${effective}`
    : `Context: ${effective} / full ${shortContextTokens(choice.raw)}`;
}

export function contextChoiceFor(
  config: MyClawConfig,
  modelId: string,
  override: ContextOverride | undefined,
  agent: AgentToolType | "orchestrator" = "main",
): ContextChoice {
  const window = resolveModelContextWindow(config, modelId, override, agent);
  const raw = window.raw;
  const cap = standingContextCap(config, modelId, agent);

  // The standing policy is offered alongside the graduations so the list always contains the
  // option that undoes a session choice. Ceilings at or above the window are dropped (they would
  // render as the same number twice), and the rest reads top-down like a volume scale.
  const ceilings = [...new Set([...(cap !== undefined ? [cap] : []), ...LOWER_TIERS])]
    .filter((c) => c < raw)
    .sort((a, b) => b - a);
  const tiers: ContextTier[] = [
    {
      tokens: raw,
      label: `Full: ${raw.toLocaleString("en-US")}`,
      selected: window.effective === raw,
    },
  ];
  for (const ceiling of ceilings) {
    tiers.push({
      ceiling,
      tokens: ceiling,
      // The standing cap is named as such: picking it back is how a conversation returns to policy.
      label: `${ceiling.toLocaleString("en-US")}${ceiling === cap ? " (cap)" : ""}`,
      selected: window.effective === ceiling,
    });
  }

  return { available: tiers.length > 1, raw, effective: window.effective, tiers };
}
