/**
 * How a run reaches its conversation's entries -- docs/session-log.md annexe D.
 *
 * The bridge takes a `SessionData` and has no view of the manager that cached it, and both of its
 * construction sites already pass eleven positional arguments. Threading a twelfth through the
 * dispatcher and the sub-agent runner to hand every run something boot already owns is the wrong
 * shape; this is the same seam `llm/world.ts` uses for the availability world, for the same
 * reason.
 *
 * A resolver rather than a map: a log is opened on demand and evicted with its session, so the
 * answer changes over the life of the process and a snapshot taken at boot would be wrong by the
 * first eviction.
 */

import { openSessionLog, type SessionLog } from "./log.ts";

/**
 * What a run gets before boot wires the manager in: a log opened straight off the disk, owned by
 * nobody.
 *
 * Deliberately functional rather than a throw. A run reaching here has no cache, so its appends
 * are not shared with anything else that holds the same conversation -- but they are still
 * written, and a test that exercises a bridge without standing up a manager is the normal case
 * for that. What it must never do is silently drop the entries.
 */
const UNMANAGED: SessionLogResolver = (sessionId) => openSessionLog(sessionId);

export type SessionLogResolver = (sessionId: string) => Promise<SessionLog>;

let current: SessionLogResolver = UNMANAGED;

/** Boot hands in the manager's own `logOf`, so every run shares the cached, flushed handle. */
export function setSessionLogResolver(resolver: SessionLogResolver): void {
  current = resolver;
}

export function sessionLogOf(sessionId: string): Promise<SessionLog> {
  return current(sessionId);
}

/** Test seam: module state is shared by every test file, so it is reset centrally. */
export function resetSessionLogResolver(): void {
  current = UNMANAGED;
}
