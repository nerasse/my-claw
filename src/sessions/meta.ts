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
import { sessionDir, META_FILE } from "./log.ts";
import type { SessionData } from "./store.ts";

/**
 * Shape version of a session directory.
 *
 * A directory written by a newer binary is refused rather than read optimistically: reading a
 * shape you do not know and writing it back is how a downgrade silently drops the fields it did
 * not understand (`harness.md` §7.3).
 */
export const STORAGE_VERSION = 1;

/** A named branch, for the selector and for `/branches name`. */
export interface BranchLabel {
  leafId: string;
  label: string;
  ts: number;
}

/** Origin, when a session comes from a `/fork`. */
export interface ForkOrigin {
  sessionId: string;
  entryId: string;
}

/**
 * State saved by `/undo` to enable `/redo`.
 *
 * `/redo` is **the immediate inverse of `/undo`**, not "go to that leaf". The relationship
 * only holds as long as nothing has been written in between. Once the owner types a new turn,
 * the abandoned branch stops being "where I just was" and becomes one branch among many —
 * navigating between arbitrary branches is exactly what `/branches` is for.
 *
 * Three reasons for this:
 * 1. **The costly surprise.** If redo worked after writing, the owner would type a message,
 *    hit `/redo`, and get teleported to an old branch leaving behind what they just wrote.
 *    That is the same pattern we refused in lot 7 for `/branches` during a run.
 * 2. **Muscle memory.** In every editor, typing after undo kills the redo stack. Going against
 *    that requires a strong reason; "it's possible" is not one.
 * 3. **Nothing is destroyed.** Refusing redo does not destroy access: the branch is listed in
 *    `/branches`, reachable in one command. We remove a shortcut that ceased to be unambiguous.
 */
export interface UndoState {
  /** The leaf to return to on `/redo`. */
  redoLeafId: string;
  /** The leaf we expect to be on when `/redo` is called. If current leaf differs, a turn was written. */
  expectedLeafId: string;
}

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
  /** Named branches for the selector. */
  branches?: BranchLabel[];
  /** Origin, when this session was created by `/fork`. */
  forkedFrom?: ForkOrigin;
  /** Undo state: enables `/redo` as the immediate inverse of `/undo`. */
  undo?: UndoState;
}

export function metaPath(sessionId: string): string {
  return join(sessionDir(sessionId), META_FILE);
}

/** Drops a key whose value is undefined, so the written object has no `"x": null` noise. */
function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Who writes each key of a stored meta.
 *
 * `metaOf` rebuilds the session-owned half from the session, so anything it does not rebuild is
 * erased by the next write unless it is carried over. `branch-commands` writes the branch
 * bookkeeping straight into the file, and measured on 0.4.57 a single persist after a `/fork`
 * dropped `forkedFrom` and every named branch: they survived until the next turn.
 *
 * `Record<keyof SessionMeta, ...>` is the point. A field added to `SessionMeta` and to neither
 * side stops the build, instead of being silently dropped on the next write.
 */
const META_KEYS: Record<keyof SessionMeta, "session" | "carried"> = {
  id: "session",
  platform: "session",
  chatType: "session",
  createdAt: "session",
  lastActiveAt: "session",
  storageVersion: "session",
  leafId: "session",
  title: "session",
  archivedAt: "session",
  pinRank: "session",
  modelOverride: "session",
  effortOverride: "session",
  contextOverride: "session",
  workspace: "session",
  roomId: "session",
  threadId: "session",
  verbose: "session",
  approvedTools: "session",
  skillsOff: "session",
  promptLayersOff: "session",
  nestedDisabled: "session",
  memoryRecallOff: "session",
  meta: "session",
  callers: "session",
  tokenUsage: "session",
  nestedAgents: "session",
  lastPrompt: "session",
  lastFixedTokens: "session",
  branches: "carried",
  forkedFrom: "carried",
  undo: "carried",
};

/** The keys of a stored meta that the session has no opinion about, taken from what is on disk. */
function carriedOver(previous: SessionMeta | null | undefined): Partial<SessionMeta> {
  if (!previous) return {};
  const carried: Record<string, unknown> = {};
  for (const key of Object.keys(META_KEYS) as (keyof SessionMeta)[]) {
    if (META_KEYS[key] !== "carried") continue;
    if (previous[key] !== undefined) carried[key] = previous[key];
  }
  return carried as Partial<SessionMeta>;
}

/**
 * The settings half of a stored session.
 *
 * `scopeOverride`, `scopeEffort` and `invokedBy` are deliberately not here. They are run state:
 * the scheduler sets them from the job before each run, and a cron session outlives its run (the
 * app opens it as a chat), so a persisted copy would outlive the settings it was taken from.
 */
export function metaOf(session: SessionData, leafId: string | null, previous?: SessionMeta | null): SessionMeta {
  return defined({
    ...carriedOver(previous),
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

/**
 * The inverse of `metaOf`: the stored session a directory describes.
 *
 * `messages` comes back empty because nothing feeds it any more -- the conversation is the entry
 * log, and every flat file still on disk already holds `[]`. `storageVersion` and `leafId` are
 * dropped rather than carried: they describe the directory, not the session, and `logOf` reads the
 * leaf from the meta itself.
 */
export function sessionFromMeta(meta: SessionMeta): SessionData {
  const settings: Partial<SessionMeta> = { ...meta };
  delete settings.storageVersion;
  delete settings.leafId;
  return { ...(settings as Omit<SessionMeta, "storageVersion" | "leafId">), messages: [] };
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
