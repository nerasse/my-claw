import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import type { McpServerConfig } from "../core/config.ts";
import type { NodeFacts, NodeRecord } from "./types.ts";

/**
 * Node records on disk (`$MY_CLAW_DIR/nodes.json`), loaded once and kept in memory.
 *
 * Only the daemon writes this file: `myclaw node add` and `node rm` go through the daemon's own
 * endpoints, so the map cannot go stale behind a second process. Writes are serialized, since a
 * facts update and a revoke can land in the same tick.
 */

const NODES_PATH = join(MY_CLAW_DIR, "nodes.json");
/** The manifest cap, reused: a record can never hold more names than a machine can offer. */
const MAX_NODE_TOOLS = 64;

/** The MCP servers the app asked a node to run. The node applies and persists them. */
export async function setNodeMcp(nodeId: string, mcp: Record<string, McpServerConfig>): Promise<{ ok: boolean; error?: string }> {
  const record = load().get(nodeId);
  if (!record) return { ok: false, error: "unknown node" };
  const names = Object.keys(mcp);
  if (names.length > MAX_NODE_MCP) return { ok: false, error: `at most ${MAX_NODE_MCP} MCP servers` };
  if (names.length === 0) delete record.mcp;
  else record.mcp = mcp;
  await persist();
  void log("info", "node mcp set", { nodeId, servers: names });
  return { ok: true };
}

/** More MCP servers than this on one node is a mistake, not a setup. */
const MAX_NODE_MCP = 32;

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

/**
 * Why a name is not usable, or undefined when it is. One place for the rules, so a rename and a
 * pairing cannot disagree on what a name may be; `nodeId` excludes the node being renamed.
 */
export function nodeNameError(nodeId: string, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "a node needs a name";
  if (trimmed.length > 64) return "node names are at most 64 characters";
  const taken = nodeRecords().some((record) => record.nodeId !== nodeId && record.name.toLowerCase() === trimmed.toLowerCase());
  if (taken) return `a node named "${trimmed}" already exists`;
  return undefined;
}

export async function mintNode(input: { name: string; facts: NodeFacts }): Promise<{ ok: true; minted: MintedNode } | { ok: false; error: string }> {
  const invalid = nodeNameError("", input.name);
  if (invalid) return { ok: false, error: invalid };
  const name = input.name.trim();

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

/** The roster's label for a node. The name rules live in `nodeNameError`. */
export async function setNodeName(nodeId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const record = load().get(nodeId);
  if (!record) return { ok: false, error: "unknown node" };
  const invalid = nodeNameError(nodeId, name);
  if (invalid) return { ok: false, error: invalid };
  const trimmed = name.trim();
  if (record.name === trimmed) return { ok: true };
  record.name = trimmed;
  await persist();
  void log("info", "node renamed", { nodeId, name: trimmed });
  return { ok: true };
}

/**
 * What the node's agent may run, and whether running it asks first. `tools: null` removes the
 * narrowing (everything the machine offers), an empty list exposes nothing.
 */
export async function setNodeAccess(
  nodeId: string,
  access: { tools?: string[] | null; approval?: boolean; disabled?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const record = load().get(nodeId);
  if (!record) return { ok: false, error: "unknown node" };
  if (access.tools !== undefined) {
    if (access.tools === null) {
      delete record.tools;
    } else {
      const names = [...new Set(access.tools.map((name) => name.trim()).filter(Boolean))];
      if (names.length > MAX_NODE_TOOLS) return { ok: false, error: `at most ${MAX_NODE_TOOLS} tools` };
      record.tools = names;
    }
  }
  if (access.approval !== undefined) {
    if (access.approval) record.approval = true;
    else delete record.approval;
  }
  if (access.disabled !== undefined) {
    if (access.disabled) record.disabled = true;
    else delete record.disabled;
  }
  await persist();
  void log("info", "node access set", {
    nodeId,
    tools: record.tools?.length ?? "all",
    approval: record.approval === true,
    disabled: record.disabled === true,
  });
  return { ok: true };
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
