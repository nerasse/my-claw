/**
 * Everything about a session that is not the conversation -- docs/session-log.md §2.4.
 *
 * The other half of `sessions/<id>/`: `entries.jsonl` only ever grows, this only ever mutates.
 * Splitting them is the whole point of the storage change. The old file rewrote 12 MB of history
 * to record that a title changed, which is what put a 41 ms synchronous `JSON.stringify` on a
 * two-second timer; here the history is appended a line at a time and the settings are a small
 * object written when they actually change.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import { sessionDir } from "./log.ts";
import type { SessionData } from "./store.ts";

/**
 * Shape version of a session directory.
 *
 * A directory written by a newer binary is refused rather than read optimistically: reading a
 * shape you do not know and writing it back is how a downgrade silently drops the fields it did
 * not understand (`harness.md` §7.3).
 */
export const STORAGE_VERSION = 1;

export interface SessionMeta {
  id: string;
  platform: string;
  chatType: string;
  createdAt: string;
  lastActiveAt: string;
  storageVersion: number;
  /** The branch cursor: which leaf this conversation is currently on. */
  leafId: string | null;
  title?: string;
  archivedAt?: string;
  pinRank?: number;
  modelOverride?: string;
  effortOverride?: SessionData["effortOverride"];
  contextOverride?: SessionData["contextOverride"];
  workspace?: string;
  roomId?: string;
  threadId?: string;
  verbose?: boolean;
  approvedTools?: string[];
  skillsOff?: string[];
  promptLayersOff?: string[];
  nestedDisabled?: string[];
  memoryRecallOff?: boolean;
  meta?: SessionData["meta"];
  callers?: SessionData["callers"];
  tokenUsage?: SessionData["tokenUsage"];
  nestedAgents?: SessionData["nestedAgents"];
  lastPrompt?: SessionData["lastPrompt"];
  lastFixedTokens?: number;
}

export function metaPath(sessionId: string): string {
  return join(sessionDir(sessionId), "meta.json");
}

/** Drops a key whose value is undefined, so the written object has no `"x": null` noise. */
function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

/**
 * The settings half of a stored session.
 *
 * `scopeOverride`, `scopeEffort` and `invokedBy` are deliberately not here. They are run state:
 * the scheduler sets them from the job before each run, and a cron session outlives its run (the
 * app opens it as a chat), so a persisted copy would outlive the settings it was taken from.
 */
export function metaOf(session: SessionData, leafId: string | null): SessionMeta {
  return defined({
    id: session.id,
    platform: session.platform,
    chatType: session.chatType,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    storageVersion: STORAGE_VERSION,
    leafId,
    title: session.title,
    archivedAt: session.archivedAt,
    pinRank: session.pinRank,
    modelOverride: session.modelOverride,
    effortOverride: session.effortOverride,
    contextOverride: session.contextOverride,
    workspace: session.workspace,
    roomId: session.roomId,
    threadId: session.threadId,
    verbose: session.verbose,
    approvedTools: session.approvedTools,
    skillsOff: session.skillsOff,
    promptLayersOff: session.promptLayersOff,
    nestedDisabled: session.nestedDisabled,
    memoryRecallOff: session.memoryRecallOff,
    meta: session.meta,
    callers: session.callers,
    tokenUsage: session.tokenUsage,
    nestedAgents: session.nestedAgents,
    lastPrompt: session.lastPrompt,
    lastFixedTokens: session.lastFixedTokens,
  });
}

export async function writeMeta(sessionId: string, meta: SessionMeta): Promise<void> {
  await writeJsonFileAtomically(metaPath(sessionId), meta, true);
}

/** A directory written by a newer binary. Refused rather than read: never a lossy round-trip. */
export class UnsupportedStorageVersionError extends Error {
  readonly version: number;
  constructor(sessionId: string, version: number) {
    super(`Session ${sessionId} was written by a newer version (storage ${version} > ${STORAGE_VERSION})`);
    this.name = "UnsupportedStorageVersionError";
    this.version = version;
  }
}

/** Reads a session's settings, or nothing when the directory does not exist yet. */
export async function readMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const raw = await readFile(metaPath(sessionId), "utf-8");
    const meta = JSON.parse(raw) as SessionMeta;
    if (typeof meta.storageVersion === "number" && meta.storageVersion > STORAGE_VERSION) {
      throw new UnsupportedStorageVersionError(sessionId, meta.storageVersion);
    }
    return meta;
  } catch (err) {
    if (err instanceof UnsupportedStorageVersionError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Unlike the entries, this one is recoverable by hand and losing it silently would reopen a
    // conversation with its title, its model and its approvals gone.
    void log("error", "session meta: unreadable, treated as absent", { sessionId, error: String(err) });
    return null;
  }
}
