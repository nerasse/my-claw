import type { MyClawConfig } from "../core/config.ts";
import { resolveContextCap } from "../core/config.ts";
import { resolveContextWindow, type ContextMode } from "../llm/context-window.ts";
import { matchesAnyGlob } from "../utils/glob.ts";

/**
 * Whether the `/model` menu should offer a context choice for this model, and what to show in it.
 *
 * Shared by both channels for the same reason `status-command.ts` is: the two adapters had byte
 * identical bodies for every other picker step, and a divergence here would mean one channel
 * offering a window the other refuses. See docs/context-window.md.
 */
export interface ContextChoice {
  /** False when the cap does not lower this model's window: the submenu would offer one number twice. */
  available: boolean;
  raw: number;
  cap: number;
  mode: ContextMode;
}

export function contextChoiceFor(
  config: MyClawConfig,
  modelId: string,
  override: ContextMode | undefined,
): ContextChoice {
  const model = config.llm.models?.find((m) => m.id === modelId);
  const window = resolveContextWindow({
    model: modelId,
    config,
    declared: model?.limit?.context,
    declaredSource: model?.contextFrom,
    sessionMode: override,
  });
  const cap = resolveContextCap(config);
  // An exemption is a standing decision by the operator, and "capped" clears the session override
  // rather than outranking it, so both entries would resolve to the full window: the submenu would
  // compare a number against itself.
  const exempt = matchesAnyGlob(modelId, config.context?.capExempt);
  return {
    // `cappedFrom` alone is not enough: it is absent precisely when the session already opted out,
    // and the entry has to stay reachable to opt back in.
    available: cap !== undefined && !exempt && window.raw > cap,
    raw: window.raw,
    cap: cap ?? window.raw,
    mode: override ?? "capped",
  };
}
