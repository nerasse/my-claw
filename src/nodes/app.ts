/**
 * The Nodes section of the app's Settings. The same operations as `myclaw node` and the HTTP
 * surface, answering to a paired device instead: the roster, a claim code for a new machine, a
 * rename, the description of its agent, what it may run, and a revocation. docs/remote-nodes.md.
 */

import type { NodesConfig } from "../core/config.ts";
import { nodeAgentFile, removeNodeAgent, renameNodeAgent, setNodeAgentDescription } from "./agent.ts";
import { openClaim } from "./claims.ts";
import { closeNodeSocket, nodeFactsOf, nodeOnline } from "./hub.ts";
import { nodeNameError, nodeRecord, nodeRecords, revokeNode, setNodeAccess, setNodeName } from "./store.ts";
import type { NodeFacts } from "./types.ts";

export interface NodeSummary {
  nodeId: string;
  name: string;
  online: boolean;
  createdAt: string;
  lastSeenAt?: string;
  /** Live facts when the node is connected, the ones stored at its last connect otherwise. */
  facts?: NodeFacts;
  /** The agent file its sub-agent lives in: where the description is written. */
  agent?: string;
  /** What that file tells the orchestrator this machine is for. */
  description?: string;
  /** The subset of the machine's tools this server exposes. Absent: all it offers. */
  exposed?: string[];
  /** Ask before running anything on that machine. */
  approval?: boolean;
}

export async function nodeSummaries(): Promise<NodeSummary[]> {
  const records = nodeRecords();
  return Promise.all(records.map(async record => {
    const facts = nodeFactsOf(record.nodeId) ?? record.facts;
    const file = await nodeAgentFile(record.nodeId);
    return {
      nodeId: record.nodeId,
      name: record.name,
      online: nodeOnline(record.nodeId),
      createdAt: record.createdAt,
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(facts ? { facts } : {}),
      ...(file ? { agent: file.name } : {}),
      ...(file?.description ? { description: file.description } : {}),
      ...(record.tools ? { exposed: record.tools } : {}),
      ...(record.approval ? { approval: true } : {}),
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
 * Renames a node and its agent file together: the file is named after the node, so leaving it
 * behind would make the roster point at an agent nobody recognises. The file is renamed first --
 * a taken name is refused before anything moved.
 */
export async function renameNodeForApp(nodeId: string, name: string): Promise<{ ok: boolean; agent?: string; error?: string }> {
  if (!nodeRecord(nodeId)) return { ok: false, error: "unknown node" };
  const invalid = nodeNameError(nodeId, name);
  if (invalid) return { ok: false, error: invalid };
  const file = await renameNodeAgent(nodeId, name.trim());
  if (!file.ok) return { ok: false, error: file.error };
  const renamed = await setNodeName(nodeId, name);
  if (!renamed.ok) return { ok: false, error: renamed.error };
  return { ok: true, agent: file.agent };
}

/** The description the orchestrator reads when it picks this node's agent. */
export async function setNodeDescriptionForApp(nodeId: string, description: string): Promise<{ ok: boolean; error?: string }> {
  if (!nodeRecord(nodeId)) return { ok: false, error: "unknown node" };
  return setNodeAgentDescription(nodeId, description);
}

/** What the node's agent may run, and whether running it asks first. */
export async function setNodeAccessForApp(
  nodeId: string,
  access: { tools?: string[] | null; approval?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  return setNodeAccess(nodeId, access);
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
