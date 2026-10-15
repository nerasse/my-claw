import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import type { NodeFacts, NodeRecord } from "./types.ts";

/**
 * Node records on disk (`$MY_CLAW_DIR/nodes.json`), loaded once and kept in memory.
 *
 * Only the daemon writes this file: `myclaw node add` and `node rm` go through the daemon's own
 * endpoints, so the map cannot go stale behind a second process. Writes are serialized, since a
 * facts update and a revoke can land in the same tick.
 */

const NODES_PATH = join(MY_CLAW_DIR, "nodes.json");

let records: Map<string, NodeRecord> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

/** The last time each node was written, so a pong every 30 s does not churn the file. */
const lastSeenWritten = new Map<string, number>();
const SEEN_INTERVAL_MS = 5 * 60_000;

export function nodesFilePath(): string {
  return NODES_PATH;
}

function load(): Map<string, NodeRecord> {
  if (records) return records;
  records = new Map();
  try {
    const raw = JSON.parse(readFileSync(NODES_PATH, "utf-8")) as { nodes?: Record<string, NodeRecord> };
    for (const [nodeId, record] of Object.entries(raw.nodes ?? {})) {
      if (record && typeof record.tokenHash === "string" && typeof record.name === "string") {
        records.set(nodeId, record);
      }
    }
  } catch {
    // No file yet, or one written by hand into nonsense: an empty set is the honest reading.
  }
  return records;
}

function persist(): Promise<void> {
  writeQueue = writeQueue
    .then(() => writeJsonFileAtomically(NODES_PATH, { nodes: Object.fromEntries(load()) }, true))
    .catch((err) => {
      void log("error", "node store write failed", { error: String(err) });
    });
  return writeQueue;
}

export function nodeRecords(): NodeRecord[] {
  return [...load().values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function nodeRecord(nodeId: string): NodeRecord | undefined {
  return load().get(nodeId);
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function findNodeByToken(token: string): NodeRecord | undefined {
  const digest = Buffer.from(hashToken(token), "hex");
  for (const record of load().values()) {
    const known = Buffer.from(record.tokenHash, "hex");
    if (known.length === digest.length && timingSafeEqual(known, digest)) return record;
  }
  return undefined;
}

export interface MintedNode {
  record: NodeRecord;
  token: string;
}

export async function mintNode(input: { name: string; facts: NodeFacts }): Promise<{ ok: true; minted: MintedNode } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "a node needs a name" };
  if (name.length > 64) return { ok: false, error: "node names are at most 64 characters" };
  const taken = nodeRecords().some((record) => record.name.toLowerCase() === name.toLowerCase());
  if (taken) return { ok: false, error: `a node named "${name}" already exists` };

  const nodeId = `node-${randomBytes(4).toString("hex")}`;
  const token = newToken();
  const record: NodeRecord = {
    nodeId,
    name,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    facts: input.facts,
  };
  load().set(nodeId, record);
  lastSeenWritten.set(nodeId, Date.now());
  await persist();
  void log("info", "node paired", { nodeId, name, os: input.facts.os, mode: input.facts.mode });
  return { ok: true, minted: { record, token } };
}

export async function revokeNode(nodeId: string): Promise<boolean> {
  if (!load().delete(nodeId)) return false;
  lastSeenWritten.delete(nodeId);
  await persist();
  void log("info", "node revoked", { nodeId });
  return true;
}

/** Facts from a hello: the same node, possibly a new machine name or tool set. */
export async function setNodeFacts(nodeId: string, facts: NodeFacts): Promise<void> {
  const record = load().get(nodeId);
  if (!record) return;
  record.facts = facts;
  record.lastSeenAt = new Date().toISOString();
  lastSeenWritten.set(nodeId, Date.now());
  await persist();
}

/** A node is alive; written at most once every five minutes (a pong every 30 s is not news). */
export async function touchNode(nodeId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastSeenWritten.get(nodeId) ?? 0) < SEEN_INTERVAL_MS) return;
  const record = load().get(nodeId);
  if (!record) return;
  record.lastSeenAt = new Date().toISOString();
  lastSeenWritten.set(nodeId, now);
  await persist();
}

/**
 * Module-level state, reset between test files. Pending writes are drained first: a write
 * enqueued by the file before must not land after the reset, or the next file's first read finds
 * records nobody minted there (measured: a stray "web01" failing a later pairing, order-dependent).
 */
export async function resetNodesStore(): Promise<void> {
  await writeQueue.catch(() => undefined);
  records = null;
  writeQueue = Promise.resolve();
  lastSeenWritten.clear();
}
