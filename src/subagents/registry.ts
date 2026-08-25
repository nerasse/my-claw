import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { subagentSessionIdsSync } from "../sessions/store.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const SUBAGENT_DIR = join(SESSIONS_DIR, "subagent");

function randomHex(n: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, n);
}

/**
 * `displayName` is written by the model and ends up inside a session id, which is a file path:
 * a `/` puts the sub-agent outside `sessions/subagent/`, where `listExistingIds` no longer sees
 * it and the uniqueness check silently stops working. An allowlist rather than a denylist of
 * dangerous characters, because the same field is rendered in the app: invisible and bidi code
 * points would let two agents look identical in a list.
 */
const UNSAFE_DISPLAY_NAME = /[^\p{L}\p{N}\p{M}_-]+/gu;
const MAX_DISPLAY_NAME = 64;

export function sanitizeDisplayName(raw: string): string {
  const collapsed = raw
    .replace(UNSAFE_DISPLAY_NAME, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  // By code point: slicing UTF-16 units can cut a surrogate pair in half and leave a lone
  // surrogate in a filename.
  const points = Array.from(collapsed);
  const capped = (points.length > MAX_DISPLAY_NAME ? points.slice(0, MAX_DISPLAY_NAME).join("") : collapsed)
    .replace(/-+$/g, "");
  return capped.length > 0 ? capped : "agent";
}

export class SubAgentRegistry {
  private queues = new Map<string, Promise<void>>();

  generateId(displayName: string, existing: Set<string>): string {
    const safe = sanitizeDisplayName(displayName);
    let id: string;
    do {
      id = `subagent/${safe}-${randomHex(4)}`;
    } while (existing.has(id));
    return id;
  }

  async listExistingIds(): Promise<Set<string>> {
    // Through the shared walk: a sub-agent is a directory now, and globbing `*.json` here found
    // none of them, so every generated id collided with one already taken.
    return new Set(subagentSessionIdsSync());
  }

  async enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id);

    const wrapped = (previous ?? Promise.resolve()).then(() => task());

    const cleanup = wrapped
      .then(() => {})
      .catch(() => {});

    this.queues.set(id, cleanup);

    try {
      return await wrapped;
    } finally {
      if (this.queues.get(id) === cleanup) {
        this.queues.delete(id);
      }
    }
  }

  isRunning(id: string): boolean {
    return this.queues.has(id);
  }
}
