/**
 * What a caller may name as the model of a sub-agent run, and how a wrong name is answered.
 *
 * Both doors that start a sub-agent -- `spawn` and `delegate_browser_task` -- read it here: a tag
 * behaves the same whichever door it came through, and a browser run is pinned exactly like a
 * spawned one (the runner records it as the session's model, so `send` keeps it afterwards).
 *
 * The two optional pins a caller may set on that run are judged here too, so one door cannot
 * accept an effort the other refuses.
 */
import { EFFORT_LEVELS } from "../llm/resolver.ts";
import type { EffortLevel } from "../core/config.ts";

const SUGGESTIONS = 5;

const tokensOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The ids a mistyped model most looks like: the ones sharing the most of its name, the id that
 * contains it whole before the others, the shorter first. Tags are left out, they are listed apart.
 *
 * Exported for its own test.
 */
export function closestModels(query: string, ids: readonly string[], limit = SUGGESTIONS): string[] {
  const wanted = tokensOf(query);
  if (wanted.length === 0) return [];
  const floor = Math.max(1, Math.ceil(wanted.length / 2));
  const whole = query.toLowerCase();
  return ids
    .filter((id) => !id.startsWith("tag:"))
    .map((id) => {
      const own = new Set(tokensOf(id));
      return { id, score: wanted.filter((token) => own.has(token)).length, whole: id.toLowerCase().includes(whole) };
    })
    .filter((candidate) => candidate.score >= floor)
    .sort((a, b) => b.score - a.score || Number(b.whole) - Number(a.whole) || a.id.length - b.id.length)
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

/** Every id a sub-agent run may be pinned to: the tags, as `tag:<name>`, then the catalog. */
export function subagentModelIds(config: { tags?: Record<string, unknown>; llm: { models?: Array<{ id: string }> } }): string[] {
  return [...Object.keys(config.tags ?? {}).map((tag) => `tag:${tag}`), ...(config.llm.models ?? []).map((m) => m.id)];
}

/** The tags, as `tag:<name>`: a handful that change only with the config, so they fit in a description. */
export function tagsOf(ids: readonly string[]): string[] {
  return ids.filter((id) => id.startsWith("tag:"));
}

/**
 * A model the caller named, judged against what a run may be pinned to. `undefined` when it passes,
 * otherwise the refusal: the closest ids and the tags, never the whole catalog -- 544 ids is about
 * 5 000 tokens on every request, and an unknown id would waste the run that carried it.
 *
 * The id has to be the whole `provider/model` reference, exactly as the catalogue writes it. A
 * label ("GPT-6 Luna") and a bare id tail ("gpt-6-luna") are both refused on purpose: several
 * providers serve the same name, and picking one for the caller picks whose quota gets spent.
 */
export function refuseUnknownModel(model: string | undefined, ids: readonly string[]): string | undefined {
  if (!model || ids.includes(model)) return undefined;
  const near = closestModels(model, ids);
  const tags = tagsOf(ids);
  const hints = [
    near.length > 0 ? `Closest ids: ${near.join(", ")}.` : "No known id looks like it.",
    tags.length > 0 ? `Tags: ${tags.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return `Unknown model "${model}". ${hints} Pass the whole provider/model reference, or omit model to use the configured one.`;
}

/**
 * The two optional pins a caller may set on a sub-agent run: its reasoning and its context
 * ceiling. Both ride on the session the run creates -- `effortOverride` and `contextOverride` are
 * what a chat's `/effort` and `/cap` write -- so the resolver and the window reader apply them
 * with no second precedence to keep in step (docs/subagents.md).
 */
export interface SubagentPins {
  effort?: EffortLevel;
  contextCap?: number;
}

/**
 * What the caller asked for, or the refusal. Shared by both doors, so `effort: "HIGH"` cannot be
 * accepted by one and refused by the other.
 *
 * The ladder is the resolver's own, not the model's trimmed list: which levels a model accepts is
 * clamped downstream, and refusing here a level the model merely trims would be a refusal about
 * the wrong thing.
 */
export function judgePins(args: Record<string, unknown>): { ok: true; pins: SubagentPins } | { ok: false; error: string } {
  const pins: SubagentPins = {};
  const effort = args["effort"];
  if (effort !== undefined && effort !== null && effort !== "") {
    const wanted = String(effort).trim().toLowerCase();
    // The words a chat's /effort takes for "hand it back": a caller repeating them means the same.
    if (wanted !== "default" && wanted !== "inherit") {
      const level = EFFORT_LEVELS.find((candidate) => candidate === wanted);
      if (!level) {
        return { ok: false, error: `Unknown effort "${String(effort)}". Use one of: ${EFFORT_LEVELS.join(", ")}, or omit it.` };
      }
      pins.effort = level;
    }
  }
  const cap = args["contextCap"];
  if (cap !== undefined && cap !== null && cap !== "") {
    const tokens = typeof cap === "number" ? cap : Number(String(cap).trim());
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return { ok: false, error: `contextCap must be a positive number of tokens, not "${String(cap)}".` };
    }
    pins.contextCap = Math.floor(tokens);
  }
  return { ok: true, pins };
}
