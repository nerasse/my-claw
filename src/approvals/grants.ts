import type { ApprovalGrantConfig } from "../core/config.ts";
import type { ApprovalOrigin } from "../channels/types.ts";

/**
 * Standing grants: exact calls the owner allowed once and for all.
 *
 * A grant is an allow rule, so it is written as narrowly as the decision he actually made: one
 * tool, one machine, one exact set of arguments. "Same arguments" means the same JSON with the
 * keys in a fixed order -- `{path, mode}` and `{mode, path}` are the same call, and a hash of the
 * raw object would let key order decide whether a permission applies.
 */

/** Stable JSON: object keys sorted at every depth, so a grant matches whatever the model ordered. */
export function canonicalArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortValue(args));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** `local`, or the node id: the machine half of a grant. */
export function originKey(origin: ApprovalOrigin | undefined): string {
  return origin ? origin.nodeId : "local";
}

export function grantOf(
  grants: readonly ApprovalGrantConfig[],
  call: { toolName: string; origin?: ApprovalOrigin; args: Record<string, unknown> },
): ApprovalGrantConfig | undefined {
  const origin = originKey(call.origin);
  const args = canonicalArgs(call.args);
  return grants.find((grant) => grant.tool === call.toolName && grant.origin === origin && grant.args === args);
}
