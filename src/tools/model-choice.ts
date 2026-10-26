/**
 * What a caller may name as the model of a sub-agent run, and how a wrong name is answered.
 *
 * Both doors that start a sub-agent -- `spawn` and `delegate_browser_task` -- read it here: a tag
 * behaves the same whichever door it came through, and a browser run is pinned exactly like a
 * spawned one (the runner records it as the session's model, so `send` keeps it afterwards).
 */

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
 */
export function refuseUnknownModel(model: string | undefined, ids: readonly string[]): string | undefined {
  if (!model || ids.includes(model)) return undefined;
  const near = closestModels(model, ids);
  const tags = tagsOf(ids);
  const hints = [
    near.length > 0 ? `Closest ids: ${near.join(", ")}.` : "No known id looks like it.",
    tags.length > 0 ? `Tags: ${tags.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return `Unknown model "${model}". ${hints} Omit model to use the configured one.`;
}
