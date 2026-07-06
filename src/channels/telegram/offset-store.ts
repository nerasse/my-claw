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
import { MY_CLAW_DIR } from "../../core/config.ts";
import { telegramLog } from "../../utils/logger.ts";

const STORE_VERSION = 1;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 25;
const DEFAULT_CLAIM_STALE_MS = 60 * 60 * 1000;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
};

type StoredTelegramUpdateClaim = {
  key: string;
  ownerId: string;
  ownerPid: number;
  createdAt: number;
};

type StoredTelegramUpdateLock = {
  ownerId: string;
  ownerPid: number;
  createdAt: number;
};

export type TelegramUpdateDeduper = {
  claimUpdate: (updateId: number | null | undefined) => boolean;
  commitUpdate: (token: string, updateId: number | null | undefined) => Promise<void>;
  releaseUpdate: (updateId: number | null | undefined) => void;
  current: () => number | null;
  stop: () => Promise<void>;
};

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sanitizeTelegramStorageSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "default";
}

function extractBotIdFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  const [rawBotId] = trimmed.split(":", 1);
  if (!rawBotId || !/^\d+$/.test(rawBotId)) return null;
  return rawBotId;
}

function hashTelegramToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function resolveTelegramUpdateOffsetPath(token: string, rootDir = MY_CLAW_DIR): string {
  const botId = sanitizeTelegramStorageSegment(extractBotIdFromToken(token) ?? "unknown");
  const tokenHash = hashTelegramToken(token);
  return join(rootDir, "telegram", "accounts", botId, tokenHash, "update-offset.json");
}

function claimsDirForPath(storagePath: string): string {
  return join(dirname(storagePath), "update-claims");
}

function lockPathForPath(storagePath: string): string {
  return `${storagePath}.lock`;
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
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

function parseState(raw: string): TelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramUpdateOffsetState>;
    if (parsed.version !== STORE_VERSION) return null;
    if (parsed.lastUpdateId !== null && parsed.lastUpdateId !== undefined && !isValidUpdateId(parsed.lastUpdateId)) {
      return null;
    }
    if (parsed.botId !== null && parsed.botId !== undefined && typeof parsed.botId !== "string") {
      return null;
    }
    return {
      version: STORE_VERSION,
      lastUpdateId: parsed.lastUpdateId ?? null,
      botId: parsed.botId ?? null,
    };
  } catch {
    return null;
  }
}

function isClaimStale(path: string, claimStaleMs: number, nowMs: number): boolean {
  const claim = readJsonFileSync<Partial<StoredTelegramUpdateClaim>>(path);
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
  const lock = readJsonFileSync<Partial<StoredTelegramUpdateLock>>(path);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUpdateKey(botId: string | null, updateId: number | null | undefined): string {
  if (!botId || !isValidUpdateId(updateId)) {
    return "";
  }
  return `${botId}|${updateId}`;
}

function hashUpdateKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function readTelegramUpdateOffset(token: string, rootDir = MY_CLAW_DIR): Promise<number | null> {
  const path = resolveTelegramUpdateOffsetPath(token, rootDir);
  try {
    const parsed = parseState(readFileSync(path, "utf-8"));
    const expectedBotId = extractBotIdFromToken(token);
    if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
      return null;
    }
    if (expectedBotId && parsed?.botId === null) {
      return null;
    }
    return parsed?.lastUpdateId ?? null;
  } catch {
    return null;
  }
}

export async function writeTelegramUpdateOffset(token: string, updateId: number, rootDir = MY_CLAW_DIR): Promise<void> {
  if (!isValidUpdateId(updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }

  writeJsonFileAtomicallySync(resolveTelegramUpdateOffsetPath(token, rootDir), {
    version: STORE_VERSION,
    lastUpdateId: updateId,
    botId: extractBotIdFromToken(token),
  } satisfies TelegramUpdateOffsetState, true);
}

export async function createTelegramUpdateDeduper(params: {
  token: string;
  rootDir?: string;
  nowMs?: () => number;
  claimStaleMs?: number;
}): Promise<TelegramUpdateDeduper> {
  const rootDir = params.rootDir ?? MY_CLAW_DIR;
  const nowMs = params.nowMs ?? (() => Date.now());
  const claimStaleMs =
    typeof params.claimStaleMs === "number" && Number.isFinite(params.claimStaleMs)
      ? Math.max(0, Math.floor(params.claimStaleMs))
      : DEFAULT_CLAIM_STALE_MS;
  const storagePath = resolveTelegramUpdateOffsetPath(params.token, rootDir);
  const claimsDir = claimsDirForPath(storagePath);
  const lockPath = lockPathForPath(storagePath);
  const botId = extractBotIdFromToken(params.token);
  let lastSeenUpdateId = await readTelegramUpdateOffset(params.token, rootDir);
  const ownerId = randomUUID();
  const localClaims = new Map<string, string>();

  mkdirSync(claimsDir, { recursive: true });

  const claimPathForKey = (key: string): string => join(claimsDir, `${hashUpdateKey(key)}.json`);

  const releaseLocalClaim = (key: string): void => {
    const claimPath = localClaims.get(key);
    if (!claimPath) return;
    localClaims.delete(key);
    rmSync(claimPath, { force: true });
  };

  const withStorageLock = async <T>(task: () => Promise<T> | T): Promise<T> => {
    mkdirSync(dirname(storagePath), { recursive: true });
    for (;;) {
      try {
        writeFileSync(
          lockPath,
          JSON.stringify({
            ownerId,
            ownerPid: process.pid,
            createdAt: nowMs(),
          } satisfies StoredTelegramUpdateLock),
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

  return {
    claimUpdate(updateId) {
      const key = buildUpdateKey(botId, updateId);
      if (!key) {
        return true;
      }
      if (localClaims.has(key)) {
        return false;
      }
      if (lastSeenUpdateId !== null && isValidUpdateId(updateId) && updateId <= lastSeenUpdateId) {
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
            } satisfies StoredTelegramUpdateClaim),
            { flag: "wx" },
          );
          localClaims.set(key, claimPath);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            // An unexpected fs error (disk full, claims dir gone) must not silently drop every
            // inbound message: log and fail-open so processing proceeds.
            void telegramLog("error", "telegram claim write failed, processing anyway", { key, error: String(error) });
            return true;
          }
          if (isClaimStale(claimPath, claimStaleMs, nowMs())) {
            rmSync(claimPath, { force: true });
            continue;
          }
          return false;
        }
      }
    },

    async commitUpdate(token, updateId) {
      const key = buildUpdateKey(botId, updateId);
      if (!key || !isValidUpdateId(updateId)) {
        return;
      }
      await withStorageLock(async () => {
        if (lastSeenUpdateId === null || updateId > lastSeenUpdateId) {
          lastSeenUpdateId = updateId;
        }
        await writeTelegramUpdateOffset(token, lastSeenUpdateId, rootDir);
        releaseLocalClaim(key);
      });
    },

    releaseUpdate(updateId) {
      const key = buildUpdateKey(botId, updateId);
      if (!key) {
        return;
      }
      releaseLocalClaim(key);
    },

    current() {
      return lastSeenUpdateId;
    },

    async stop() {
      for (const key of [...localClaims.keys()]) {
        releaseLocalClaim(key);
      }
    },
  };
}
