/**
 * The Nodes section of the app's Settings. The same three operations as `myclaw node` and the
 * HTTP surface, answering to a paired device instead: the roster, a claim code for a new machine,
 * and a revocation. docs/remote-nodes.md.
 */

import type { NodesConfig } from "../core/config.ts";
import { nodeAgentName, removeNodeAgent } from "./agent.ts";
import { openClaim } from "./claims.ts";
import { closeNodeSocket, nodeFactsOf, nodeOnline } from "./hub.ts";
import { nodeRecord, nodeRecords, revokeNode } from "./store.ts";
import type { NodeFacts } from "./types.ts";

export interface NodeSummary {
  nodeId: string;
  name: string;
  online: boolean;
  createdAt: string;
  lastSeenAt?: string;
  /** Live facts when the node is connected, the ones stored at its last connect otherwise. */
  facts?: NodeFacts;
  /** The agent file its sub-agent lives in: the owner writes its description there. */
  agent?: string;
}

export async function nodeSummaries(): Promise<NodeSummary[]> {
  const records = nodeRecords();
  return Promise.all(records.map(async record => {
    const facts = nodeFactsOf(record.nodeId) ?? record.facts;
    const agent = await nodeAgentName(record.nodeId);
    return {
      nodeId: record.nodeId,
      name: record.name,
      online: nodeOnline(record.nodeId),
      createdAt: record.createdAt,
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(facts ? { facts } : {}),
      ...(agent ? { agent } : {}),
    };
  }));
}

export function openNodeClaim(
  nodes: NodesConfig | undefined,
  name?: string,
): { ok: true; code: string; expiresAt: number } | { ok: false; reason: string } {
  return openClaim({
    ttlSeconds: nodes?.claimTtlSeconds,
    ...(name?.trim() ? { name: name.trim() } : {}),
  });
}

/**
 * Revocation, in the order the surface uses: the socket closes first, so a node that keeps
 * answering is not left holding a record that is already gone.
 */
export async function revokeNodeForApp(nodeId: string): Promise<{ ok: boolean; error?: string }> {
  if (!nodeRecord(nodeId)) return { ok: false, error: "unknown node" };
  closeNodeSocket(nodeId, "revoked");
  await revokeNode(nodeId);
  await removeNodeAgent(nodeId);
  return { ok: true };
}
