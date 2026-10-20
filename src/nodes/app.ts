/**
 * The Nodes section of the app's Settings. The same operations as `myclaw node` and the HTTP
 * surface, answering to a paired device instead: the roster, a claim code for a new machine, a
 * rename, the description of its agent, what it may run, and a revocation. docs/remote-nodes.md.
 */

import type { McpServerConfig, NodesConfig } from "../core/config.ts";
import { nodeAgentFile, removeNodeAgent, renameNodeAgent, setNodeAgentDescription } from "./agent.ts";
import { openClaim } from "./claims.ts";
import { closeNodeSocket, nodeFactsOf, nodeOnline, offerNodeUpdateNow, pushNodeMcp } from "./hub.ts";
import { nodeNameError, nodeRecord, nodeRecords, revokeNode, setNodeAccess, setNodeMcp, setNodeName } from "./store.ts";
import type { NodeFacts, NodeRecord } from "./types.ts";

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
  /** Its agent does not run; the machine stays connected. */
  disabled?: boolean;
  /** The MCP servers it runs: the configured ones, and how each came up. */
  mcp?: NodeMcpSummary[];
}

export interface NodeMcpSummary {
  name: string;
  transport: string;
  /** The command line (stdio) or the URL (http/sse) the machine runs. */
  target: string;
  /** Running on the machine but not configured from here: a hand edit of its config. */
  external?: boolean;
  ok?: boolean;
  tools?: number;
  error?: string;
  /** What this server configured, so the app edits fields rather than re-parsing a command line. */
  config?: McpServerConfig;
}

export async function nodeSummaries(): Promise<NodeSummary[]> {
  const records = nodeRecords();
  return Promise.all(records.map(async record => {
    const facts = nodeFactsOf(record.nodeId) ?? record.facts;
    const file = await nodeAgentFile(record.nodeId);
    const summary = mcpSummaries(record, facts);
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
      ...(record.disabled ? { disabled: true } : {}),
      ...(summary.length > 0 ? { mcp: summary } : {}),
    };
  }));
}

function mcpTargetOf(config: McpServerConfig): string {
  if (config.transport === "stdio") return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
  return config.url ?? "";
}

/**
 * The configured servers and the reported ones, merged: a machine runs exactly what it was told
 * plus whatever its own config file already had (shown, marked external, never managed here).
 */
function mcpSummaries(record: NodeRecord, facts: NodeFacts | undefined): NodeMcpSummary[] {
  const status = new Map((facts?.mcp ?? []).map(entry => [entry.name, entry]));
  const configured = Object.entries(record.mcp ?? {}).map(([name, config]) => {
    const reported = status.get(name);
    return {
      name,
      transport: config.transport,
      target: mcpTargetOf(config),
      ...(reported ? { ok: reported.ok, tools: reported.tools } : {}),
      ...(reported?.error ? { error: reported.error } : {}),
      config,
    };
  });
  const known = new Set(configured.map(entry => entry.name));
  const extra = (facts?.mcp ?? [])
    .filter(entry => !known.has(entry.name))
    .map(entry => ({
      name: entry.name,
      transport: "stdio",
      target: "",
      external: true,
      ok: entry.ok,
      tools: entry.tools,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  return [...configured, ...extra];
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
  access: { tools?: string[] | null; approval?: boolean; disabled?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  return setNodeAccess(nodeId, access);
}

/** The owner's MCP list for a node: stored, then handed to the machine if it is connected. */
export async function setNodeMcpForApp(
  nodeId: string,
  mcp: Record<string, McpServerConfig>,
): Promise<{ ok: boolean; error?: string }> {
  const written = await setNodeMcp(nodeId, mcp);
  if (written.ok) pushNodeMcp(nodeId);
  return written;
}

/** The owner asking a connected node to take the server's build now, window or no window. */
export async function updateNodeForApp(nodeId: string): Promise<{ ok: boolean; error?: string }> {
  if (!nodeRecord(nodeId)) return { ok: false, error: "unknown node" };
  return offerNodeUpdateNow(nodeId);
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
