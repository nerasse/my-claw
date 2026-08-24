import type { MyClawConfig } from "../core/config.ts";
import { tryResolveRunModel } from "./run-model.ts";
import { availabilityWorld } from "./world.ts";

/**
 * The model a chat runs right now: its own pick, else the agent's pin, else the global default.
 *
 * Every menu, status line and confirmation goes through this. The expression it replaces --
 * `session.modelOverride ?? config.llm.defaultModel` -- was written out seven times and skipped the
 * agent pin in all seven, so a chat inheriting a pin was told it ran the global default while every
 * request went elsewhere. See docs/model-resolution.md.
 *
 * Falls back to the raw override, then the global default, when nothing resolves: a menu must
 * still print something when the config is broken, and the broken part is reported by the run.
 */
export function chatModel(config: MyClawConfig, sessionModel: string | undefined, agent = "main"): string {
  const run = tryResolveRunModel(
    config,
    { agent, ...(sessionModel ? { sessionModel } : {}) },
    availabilityWorld(),
  );
  return run?.requestedModel ?? run?.model ?? sessionModel ?? config.llm.defaultModel ?? config.llm.model ?? "";
}
