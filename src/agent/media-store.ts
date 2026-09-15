/**
 * Storing what a run produced, before its end marker is written.
 *
 * The marker is the only entry that carries a run's pictures to a reopened thread, and the log
 * never rewrites an entry -- so the marker has to be born able to name the copy a device fetches.
 * The bytes are therefore stored here, at the end of the run, through a hook the channel injects:
 * the agent side owns no store, and a run with no hook (cron, a plugin) records the paths alone.
 *
 * The id is pinned back onto the attachment the registry holds, which is what lets the outgoing
 * frame name the same copy the marker does: the router consumes those very objects, so a picture
 * is stored once and both the log and the device point at it (2026-09-15).
 */

import type { MediaStoreHook } from "./backend.ts";
import type { Attachment } from "../channels/types.ts";

/** The paths a marker records, and the id of each when the run found somewhere to store it. */
export interface StoredRunMedia {
  paths: string[];
  ids?: Array<string | null>;
}

/**
 * Stores every attachment that has bytes and no id yet. One failure is a hole, not a lost run:
 * the picture keeps its path and the marker says the copy is nowhere.
 */
export async function storeRunMedia(
  attachments: readonly Attachment[],
  sessionId: string,
  store: MediaStoreHook | undefined,
): Promise<StoredRunMedia> {
  const withPath = attachments.filter((att) => att.path);
  const paths = withPath.map((att) => att.path!);
  if (paths.length === 0 || !store) return { paths };
  const ids: Array<string | null> = [];
  for (const att of withPath) {
    if (att.id) {
      // Already stored -- another caller got there first, and one copy is the point.
      ids.push(att.id);
      continue;
    }
    const id = await store(sessionId, att.path!).catch(() => undefined);
    if (id) att.id = id;
    ids.push(id ?? null);
  }
  return { paths, ids };
}
