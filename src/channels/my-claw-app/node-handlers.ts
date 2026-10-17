import type { ServerWebSocket } from "bun";
import type { NodesConfig } from "../../core/config.ts";
import {
  nodeSummaries,
  openNodeClaim,
  renameNodeForApp,
  revokeNodeForApp,
  setNodeAccessForApp,
  setNodeDescriptionForApp,
  type NodeSummary,
} from "../../nodes/app.ts";
import type { MyClawAppSessionData } from "./controllers.ts";
import type { SocketRegistry } from "./socket-registry.ts";
import type { MyClawAppNodeFrame, MyClawAppServerFrame } from "./types.ts";

/** What a node frame needs from the adapter: the config that times a claim, the live sockets it
 *  mirrors to, and the one exit every frame answers through. */
export interface MyClawAppNodeDeps {
  nodes(): NodesConfig | undefined;
  readonly sockets: SocketRegistry;
  sendFrame(ws: ServerWebSocket<MyClawAppSessionData> | undefined, frame: MyClawAppServerFrame): void;
}

/**
 * One node, flat: the facts are for a settings row, not for an agent, and a nested object the app
 * has to dig through would be the only reason the shape existed.
 */
export function nodeFrame(summary: NodeSummary): MyClawAppNodeFrame {
  const facts = summary.facts;
  return {
    nodeId: summary.nodeId,
    name: summary.name,
    online: summary.online,
    createdAt: summary.createdAt,
    ...(summary.lastSeenAt ? { lastSeenAt: summary.lastSeenAt } : {}),
    ...(facts ? { os: facts.os, arch: facts.arch, hostname: facts.hostname, user: facts.user, mode: facts.mode, version: facts.version } : {}),
    tools: facts ? facts.tools.map(tool => tool.name) : [],
    ...(summary.agent ? { agent: summary.agent } : {}),
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.exposed ? { exposed: summary.exposed } : {}),
    ...(summary.approval ? { approval: true } : {}),
  };
}

export async function handleNodesList(d: MyClawAppNodeDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  const summaries = await nodeSummaries();
  d.sendFrame(ws, { type: "nodes.list.result", nodes: summaries.map(nodeFrame) });
}

/**
 * "Add a node": a claim code, single use, ten minutes. It authorises both fetching the client
 * and pairing it; the machine to add is the only one that ever sees the token.
 */
export function handleNodesAdd(d: MyClawAppNodeDeps, ws: ServerWebSocket<MyClawAppSessionData>, frame: { name?: unknown }): void {
  const name = typeof frame.name === "string" ? frame.name : undefined;
  const opened = openNodeClaim(d.nodes(), name);
  d.sendFrame(ws, opened.ok
    ? { type: "nodes.add.result", ok: true, code: opened.code, expiresAt: opened.expiresAt }
    : { type: "nodes.add.result", ok: false, error: opened.reason });
}

export async function handleNodesRevoke(d: MyClawAppNodeDeps, ws: ServerWebSocket<MyClawAppSessionData>, nodeId: string): Promise<void> {
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    d.sendFrame(ws, { type: "nodes.revoke.result", ok: false, nodeId: String(nodeId), error: "unknown node" });
    return;
  }
  const revoked = await revokeNodeForApp(nodeId);
  d.sendFrame(ws, {
    type: "nodes.revoke.result",
    ok: revoked.ok,
    nodeId,
    ...(revoked.error ? { error: revoked.error } : {}),
  });
  if (revoked.ok) await mirrorNodesList(d, ws);
}

/** The roster's label, and the agent file follows it. */
export async function handleNodesRename(
  d: MyClawAppNodeDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: { nodeId?: unknown; name?: unknown },
): Promise<void> {
  const nodeId = typeof frame.nodeId === "string" ? frame.nodeId : "";
  const name = typeof frame.name === "string" ? frame.name : "";
  const renamed = await renameNodeForApp(nodeId, name);
  d.sendFrame(ws, {
    type: "nodes.rename.result",
    ok: renamed.ok,
    nodeId,
    ...(renamed.ok ? { name: name.trim() } : {}),
    ...(renamed.agent ? { agent: renamed.agent } : {}),
    ...(renamed.error ? { error: renamed.error } : {}),
  });
  if (renamed.ok) await mirrorNodesList(d, ws);
}

/** The description the orchestrator reads when it picks this node's agent. */
export async function handleNodesDescribe(
  d: MyClawAppNodeDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: { nodeId?: unknown; description?: unknown },
): Promise<void> {
  const nodeId = typeof frame.nodeId === "string" ? frame.nodeId : "";
  const description = typeof frame.description === "string" ? frame.description : "";
  const written = await setNodeDescriptionForApp(nodeId, description);
  d.sendFrame(ws, {
    type: "nodes.describe.result",
    ok: written.ok,
    nodeId,
    ...(written.error ? { error: written.error } : {}),
  });
  if (written.ok) await mirrorNodesList(d, ws);
}

/** What the node's agent may run there, and whether running it asks first. */
export async function handleNodesAccessSet(
  d: MyClawAppNodeDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: { nodeId?: unknown; tools?: unknown; approval?: unknown },
): Promise<void> {
  const nodeId = typeof frame.nodeId === "string" ? frame.nodeId : "";
  const tools = frame.tools === null ? null : Array.isArray(frame.tools) ? frame.tools.filter((name): name is string => typeof name === "string") : undefined;
  const approval = typeof frame.approval === "boolean" ? frame.approval : undefined;
  const written = await setNodeAccessForApp(nodeId, {
    ...(tools !== undefined ? { tools } : {}),
    ...(approval !== undefined ? { approval } : {}),
  });
  d.sendFrame(ws, {
    type: "nodes.access.set.result",
    ok: written.ok,
    nodeId,
    ...(written.error ? { error: written.error } : {}),
  });
  if (written.ok) await mirrorNodesList(d, ws);
}

/** The roster after a revocation, to the owner's other windows: the row they show is gone. */
async function mirrorNodesList(d: MyClawAppNodeDeps, sender: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  const others = d.sockets.all().filter(other => other !== sender && other.data.owner === sender.data.owner);
  await Promise.all(others.map(other => handleNodesList(d, other)));
}
