import { createHash } from "node:crypto";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../config.ts";

export interface MatrixStorageConfig {
  homeserver: string;
  accessToken: string;
  userId?: string;
}

export interface MatrixRuntimeStoragePaths {
  rootDir: string;
  syncPath: string;
  cryptoSnapshotPath: string;
  cryptoDatabasePrefix: string;
  inboundDedupePath: string;
  pendingActionsPath: string;
  pendingApprovalsPath: string;
}

function sanitizeMatrixPathSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function resolveMatrixHomeserverKey(homeserver: string): string {
  try {
    const url = new URL(homeserver);
    if (url.host) {
      return sanitizeMatrixPathSegment(url.host);
    }
  } catch {
    // ignore invalid URL and fall through
  }
  return sanitizeMatrixPathSegment(homeserver);
}

function hashMatrixAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

export function resolveMatrixRuntimeStoragePaths(
  config: MatrixStorageConfig,
  rootBaseDir = join(MY_CLAW_DIR, "matrix", "accounts", "default"),
): MatrixRuntimeStoragePaths {
  const userKey = sanitizeMatrixPathSegment(config.userId ?? "unknown");
  const serverKey = resolveMatrixHomeserverKey(config.homeserver);
  const tokenHash = hashMatrixAccessToken(config.accessToken);
  const rootDir = join(rootBaseDir, `${serverKey}__${userKey}`, tokenHash);
  return {
    rootDir,
    syncPath: join(rootDir, "bot-storage.json"),
    cryptoSnapshotPath: join(rootDir, "crypto-idb-snapshot.json"),
    cryptoDatabasePrefix: `my-claw-matrix-default-${tokenHash}`,
    inboundDedupePath: join(rootDir, "inbound-dedupe.json"),
    pendingActionsPath: join(rootDir, "pending-actions.json"),
    pendingApprovalsPath: join(rootDir, "pending-approvals.json"),
  };
}

export function resolveOpenClawSnapshotPath(config: MatrixStorageConfig): {
  prefix: string;
  snapshotPath: string;
} {
  const userKey = sanitizeMatrixPathSegment(config.userId ?? "unknown");
  const serverKey = resolveMatrixHomeserverKey(config.homeserver);
  const tokenHash = hashMatrixAccessToken(config.accessToken);
  const rootDir = join(
    MY_CLAW_DIR,
    "..",
    ".openclaw",
    "matrix",
    "accounts",
    "default",
    `${serverKey}__${userKey}`,
    tokenHash,
  );
  return {
    prefix: `openclaw-matrix-default-${tokenHash}`,
    snapshotPath: join(rootDir, "crypto-idb-snapshot.json"),
  };
}
