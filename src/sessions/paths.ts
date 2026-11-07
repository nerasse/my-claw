/**
 * Where a session lives on disk -- docs/session-log.md.
 *
 * Split out of `log.ts` so the index can name a session's files without importing the reader that
 * imports it back: a cycle here would be resolved at call time by the bundler and blow up at boot
 * on whichever side was evaluated first.
 */

import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

export const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");

export const ENTRIES_FILE = "entries.jsonl";
export const META_FILE = "meta.json";

export function sanitizeSessionId(raw: string): string {
  return raw.replace(/\.\./g, "_").replace(/\0/g, "");
}

export function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sanitizeSessionId(sessionId));
}
