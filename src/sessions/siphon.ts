import type { SessionData } from "../sessions/store.ts";
import { attributionParent } from "../sessions/store.ts";

/**
 * Siphon: one model for a whole tree, read from its root -- docs/siphon.md.
 *
 * The pin is a decision of the conversation the owner is in, so it lives on that conversation's
 * session and nowhere else. A child never carries a copy: a copy would go stale the moment the
 * owner changes the pin while a chain is running, and every level would then disagree about the
 * model it is on.
 *
 * Which session is the root is not asked here -- `attributionParent` already answers "who do I
 * owe my work to" the way the rest of the codebase does, and a root is its own parent. This walks
 * that until it stops moving, so a chain of any depth lands on the same session.
 */

/** A session by id, or nothing when it is gone. Injected: this module reads no disk. */
export type SessionLoader = (sessionId: string) => Promise<SessionData | null | undefined>;

/**
 * The session at the top of this one's chain: itself for a conversation or a standalone agent.
 *
 * Bounded by the sessions already visited, not by a fixed depth: a cycle would otherwise spin, and
 * a corrupted `invokedBy` is a thing that can exist on disk.
 */
export async function rootSessionOf(session: SessionData, load: SessionLoader): Promise<SessionData> {
  let current = session;
  const seen = new Set<string>([current.id]);
  for (;;) {
    const parentId = attributionParent(current);
    if (parentId === current.id || seen.has(parentId)) return current;
    const parent = await load(parentId).catch(() => null);
    if (!parent) return current;
    seen.add(parentId);
    current = parent;
  }
}

/** The pin a run of this session must obey, or undefined when Siphon is off. */
export function pinModelOf(session: SessionData): string | undefined {
  const pin = typeof session.pinModel === "string" ? session.pinModel.trim() : "";
  return pin.length > 0 ? pin : undefined;
}

/**
 * Whether this session's walls are waited out: the retry switch, or a Siphon pin.
 *
 * A pin is the owner saying "this model, whatever it takes", so a wall under it parks the
 * conversation and resumes at the reset exactly as the switch does -- and the owner does not have
 * to remember a second toggle to make a tag full of spent accounts usable (2026-11-10).
 *
 * Read on the session that holds the decision. A child asks its root (`rootSessionOf`), which is
 * the one place either answer lives.
 */
export function waitsForQuotaOf(session: SessionData): boolean {
  return pinModelOf(session) !== undefined || session.quotaRetry?.enabled === true;
}
