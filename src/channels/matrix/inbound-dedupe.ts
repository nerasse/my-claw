import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonFileAtomicallySync } from "../../utils/atomic-write.ts";

const STORE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CLAIM_STALE_MS = 6 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 25;

type StoredMatrixInboundDedupeEntry = {
  key: string;
  ts: number;
};

type StoredMatrixInboundDedupeState = {
  version: number;
  entries: StoredMatrixInboundDedupeEntry[];
};

type StoredMatrixInboundClaim = {
  key: string;
  ownerId: string;
  ownerPid: number;
  createdAt: number;
};

type StoredMatrixInboundLock = {
  ownerId: string;
  ownerPid: number;
  createdAt: number;
};

export type MatrixInboundEventDeduper = {
  claimEvent: (params: { roomId: string; eventId: string }) => boolean;
  commitEvent: (params: { roomId: string; eventId: string }) => Promise<void>;
  releaseEvent: (params: { roomId: string; eventId: string }) => void;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

function normalizeEventPart(value: string): string {
  return value.trim();
}

function buildEventKey(params: { roomId: string; eventId: string }): string {
  const roomId = normalizeEventPart(params.roomId);
  const eventId = normalizeEventPart(params.eventId);
  return roomId && eventId ? `${roomId}|${eventId}` : "";
}

function hashEventKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function pruneSeenEvents(params: {
  seen: Map<string, number>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}): void {
  const { seen, ttlMs, maxEntries, nowMs } = params;
  if (ttlMs > 0) {
    const cutoff = nowMs - ttlMs;
    for (const [key, ts] of seen) {
      if (ts < cutoff) {
        seen.delete(key);
      }
    }
  }
  const max = Math.max(0, Math.floor(maxEntries));
  if (max <= 0) {
    seen.clear();
    return;
  }
  while (seen.size > max) {
    const oldestKey = seen.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    seen.delete(oldestKey);
  }
}

function toStoredState(params: {
  seen: Map<string, number>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}): StoredMatrixInboundDedupeState {
  pruneSeenEvents(params);
  return {
    version: STORE_VERSION,
    entries: Array.from(params.seen.entries()).map(([key, ts]) => ({ key, ts })),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonFileSync<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readStoredStateSync(storagePath: string): StoredMatrixInboundDedupeState | null {
  const parsed = readJsonFileSync<{ version?: unknown; entries?: unknown }>(storagePath);
  if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.entries)) {
    return null;
  }
  return {
    version: STORE_VERSION,
    entries: parsed.entries as StoredMatrixInboundDedupeEntry[],
  };
}

function readSeenMapSync(storagePath: string, ttlMs: number, maxEntries: number, nowMs: number): Map<string, number> {
  const seen = new Map<string, number>();
  for (const entry of readStoredStateSync(storagePath)?.entries ?? []) {
    if (!entry || typeof entry.key !== "string") {
      continue;
    }
    const key = entry.key.trim();
    const ts = normalizeTimestamp(entry.ts);
    if (!key || ts === null) {
      continue;
    }
    seen.set(key, ts);
  }
  pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs });
  return seen;
}

function isClaimStale(path: string, claimStaleMs: number, nowMs: number): boolean {
  const claim = readJsonFileSync<Partial<StoredMatrixInboundClaim>>(path);
  const createdAt = normalizeTimestamp(claim?.createdAt);
  if (createdAt === null) {
    return true;
  }
  if (nowMs - createdAt > claimStaleMs) {
    return true;
  }
  return !processExists(Number(claim?.ownerPid));
}

function isLockStale(path: string, nowMs: number): boolean {
  const lock = readJsonFileSync<Partial<StoredMatrixInboundLock>>(path);
  const createdAt = normalizeTimestamp(lock?.createdAt);
  if (createdAt !== null) {
    if (nowMs - createdAt > LOCK_STALE_MS) {
      return true;
    }
    return !processExists(Number(lock?.ownerPid));
  }
  try {
    const stats = statSync(path);
    return nowMs - stats.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

export async function createMatrixInboundEventDeduper(params: {
  storagePath: string;
  ttlMs?: number;
  maxEntries?: number;
  nowMs?: () => number;
  claimStaleMs?: number;
}): Promise<MatrixInboundEventDeduper> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs)
      ? Math.max(0, Math.floor(params.ttlMs))
      : DEFAULT_TTL_MS;
  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.max(0, Math.floor(params.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  const claimStaleMs =
    typeof params.claimStaleMs === "number" && Number.isFinite(params.claimStaleMs)
      ? Math.max(0, Math.floor(params.claimStaleMs))
      : DEFAULT_CLAIM_STALE_MS;
  const ownerId = randomUUID();
  const claimsDir = join(dirname(params.storagePath), "inbound-claims");
  const lockPath = `${params.storagePath}.lock`;
  const localClaims = new Map<string, string>();

  mkdirSync(claimsDir, { recursive: true });

  // Load seen map into memory at creation to avoid sync file I/O on every claimEvent
  const seenMap = readSeenMapSync(params.storagePath, ttlMs, maxEntries, nowMs());
  let dirty = false;

  const claimPathForKey = (key: string): string => join(claimsDir, `${hashEventKey(key)}.json`);

  const releaseLocalClaim = (key: string): void => {
    const claimPath = localClaims.get(key);
    if (!claimPath) {
      return;
    }
    localClaims.delete(key);
    rmSync(claimPath, { force: true });
  };

  const withStorageLock = async <T>(task: () => Promise<T> | T): Promise<T> => {
    mkdirSync(dirname(params.storagePath), { recursive: true });
    for (;;) {
      try {
        writeFileSync(
          lockPath,
          JSON.stringify({
            ownerId,
            ownerPid: process.pid,
            createdAt: nowMs(),
          } satisfies StoredMatrixInboundLock),
          { flag: "wx" },
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        if (isLockStale(lockPath, nowMs())) {
          rmSync(lockPath, { force: true });
          continue;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }

    try {
      return await task();
    } finally {
      rmSync(lockPath, { force: true });
    }
  };

  const persistSeenMap = async (): Promise<void> => {
    if (!dirty) return;
    await withStorageLock(() => {
      writeJsonFileAtomicallySync(
        params.storagePath,
        toStoredState({ seen: seenMap, ttlMs, maxEntries, nowMs: nowMs() }),
      );
      dirty = false;
    });
  };

  return {
    claimEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return true;
      }
      if (localClaims.has(key)) {
        return false;
      }

      if (seenMap.has(key)) {
        return false;
      }

      const claimPath = claimPathForKey(key);
      for (;;) {
        try {
          writeFileSync(
            claimPath,
            JSON.stringify({
              key,
              ownerId,
              ownerPid: process.pid,
              createdAt: nowMs(),
            } satisfies StoredMatrixInboundClaim),
            { flag: "wx" },
          );
          localClaims.set(key, claimPath);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            return false;
          }
          if (isClaimStale(claimPath, claimStaleMs, nowMs())) {
            rmSync(claimPath, { force: true });
            continue;
          }
          return false;
        }
      }
    },
    commitEvent: async ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return;
      }
      seenMap.delete(key);
      seenMap.set(key, nowMs());
      dirty = true;
      releaseLocalClaim(key);
      // Persist asynchronously without blocking the caller
      void persistSeenMap();
    },
    releaseEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return;
      }
      releaseLocalClaim(key);
    },
    flush: async () => {
      await persistSeenMap();
    },
    stop: async () => {
      for (const key of [...localClaims.keys()]) {
        releaseLocalClaim(key);
      }
      await persistSeenMap();
    },
  };
}
