/**
 * What a 400 is asking us to change, and how to change it.
 *
 * An endpoint that names the field it will not take is not the same as an endpoint that is down,
 * and it is not the same as a request we sent wrong either: it is a fact about *that model*. Every
 * read of it used to live where the call was made, one `if` per message we happened to meet first,
 * so a shape refused by one provider was paid again on the next call to the same endpoint -- and a
 * parameter refused by one model killed a twenty-nine minute run outright (2026-09-26).
 *
 * So the knowledge is one table, in data, and the call site asks it a question. Three properties
 * keep it from becoming a burden:
 *
 * - **The discriminant is short and stable.** Never the whole sentence; the parameter name the
 *   endpoint quoted, or the field it demands. A provider rewording its message does not break a
 *   repair, it only makes it unrecognised -- which is the safe direction.
 * - **The default is to do nothing.** An unknown refusal is thrown exactly as before. Nothing is
 *   guessed, and no error is ever swallowed.
 * - **A repair is learned, not repeated.** Once an endpoint has refused a shape, the repaired
 *   request is what this process sends it from then on, so the 400 is paid once and never per call.
 *
 * None of it is persisted: it is a compatibility fact about a remote endpoint, not state worth
 * keeping across a boot.
 */

import type { CacheDialect } from "./cache-policy.ts";

/** The knobs a repaired request may move. Everything a repair could want to change lives here. */
export type RepairOptions = {
  /** Anthropic-style `cache_control` breakpoints on the stable prefix and the last message. */
  cacheBreakpoints: boolean;
  /** An OpenAI-style `prompt_cache_key`, which is a top-level field and a different dialect. */
  cacheKey: boolean;
  /**
   * Replay the reasoning a turn carries even when it came from another model than the one being
   * called. The field belongs to the turn that produced it, so an endpoint in thinking mode that
   * demands it must be answered from the log rather than from the current identity.
   */
  forceReasoning: boolean;
  /** Top-level fields this endpoint has refused by name. */
  dropParameters: string[];
};

export type Repair = {
  /** Named in the log, and the key a refusal is remembered under. */
  id: string;
  /** The endpoint's own words, reduced to the one part that does not move. */
  match: (status: number, detail: string) => boolean;
  /** Turns the named refusal into a change. Returns false when there is nothing to change. */
  apply: (options: RepairOptions, detail: string) => boolean;
};

/** The parameter a refusal names, if it quotes one. `The parameter X is not supported`. */
function namedParameter(detail: string): string | undefined {
  const m = /parameter\s+["'`]?([A-Za-z0-9_.]+)["'`]?\s+(?:is|are)\s+not\s+supported/i.exec(detail);
  return m?.[1];
}

/**
 * Cache parameters are not top-level fields: `cache_control` rides inside a message part. Dropping
 * it by name would delete nothing, so the two known spellings turn their dialect off instead.
 */
const CACHE_PARAMETERS = new Set(["cache_control", "prompt_cache_key", "cache_creation", "cache_read"]);

export const REPAIRS: readonly Repair[] = [
  {
    id: "drop-refused-parameter",
    match: (status, detail) => status === 400 && namedParameter(detail) !== undefined,
    apply: (options, detail) => {
      const name = namedParameter(detail);
      if (!name) return false;
      if (CACHE_PARAMETERS.has(name)) {
        const had = options.cacheBreakpoints || options.cacheKey;
        options.cacheBreakpoints = false;
        options.cacheKey = false;
        return had;
      }
      if (options.dropParameters.includes(name)) return false;
      options.dropParameters.push(name);
      return true;
    },
  },
  {
    id: "plain-content",
    match: (status, detail) =>
      status === 400 &&
      /content\.str|should be a valid string|is not of type 'string'|messages\[\d+\]\.content/i.test(detail),
    apply: options => {
      const had = options.cacheBreakpoints || options.cacheKey;
      options.cacheBreakpoints = false;
      options.cacheKey = false;
      return had;
    },
  },
  {
    id: "replay-reasoning",
    match: (status, detail) =>
      status === 400 && /reasoning_content/i.test(detail) && /pass(?:ed)?\s*back|required|must be/i.test(detail),
    apply: options => {
      if (options.forceReasoning) return false;
      options.forceReasoning = true;
      return true;
    },
  },
];

/** The repair this refusal answers to, or nothing -- in which case the error is thrown as it is. */
export function repairFor(status: number, detail: string): Repair | undefined {
  return REPAIRS.find(repair => repair.match(status, detail));
}

/** What an endpoint has taught us, kept per endpoint and model, never across a boot. */
type Learned = {
  noCacheHints: boolean;
  forceReasoning: boolean;
  dropParameters: string[];
};

const learned = new Map<string, Learned>();

/** The options this endpoint gets: its refusals applied, and the cache hint in the dialect it speaks. */
export function repairOptionsFor(
  endpointKey: string,
  dialect: CacheDialect,
  cacheAllowed: boolean,
): RepairOptions {
  const known = learned.get(endpointKey);
  return {
    cacheBreakpoints: cacheAllowed && dialect === "anthropic" && !known?.noCacheHints,
    cacheKey: cacheAllowed && dialect === "openai" && !known?.noCacheHints,
    forceReasoning: known?.forceReasoning === true,
    dropParameters: [...(known?.dropParameters ?? [])],
  };
}

/**
 * Records the repair so the next call to this endpoint starts already fixed. Called only when a
 * repair actually changed something: one that changed nothing means it did not suffice, and
 * replaying the same request would only buy the same 400.
 */
export function rememberRepair(endpointKey: string, repair: Repair, detail: string): void {
  const known = learned.get(endpointKey) ?? { noCacheHints: false, forceReasoning: false, dropParameters: [] };
  if (repair.id === "drop-refused-parameter") {
    const name = namedParameter(detail);
    if (name && CACHE_PARAMETERS.has(name)) known.noCacheHints = true;
    else if (name && !known.dropParameters.includes(name)) known.dropParameters.push(name);
  } else if (repair.id === "plain-content") {
    known.noCacheHints = true;
  } else if (repair.id === "replay-reasoning") {
    known.forceReasoning = true;
  }
  learned.set(endpointKey, known);
}

/** Test seam: one file's refusals must not decide the next file's requests. */
export function resetLearnedRepairs(): void {
  learned.clear();
}
