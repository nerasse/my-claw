import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "../tools/types.ts";
import { readAppVersion } from "../core/diagnostics.ts";
import { log } from "../utils/logger.ts";
import { nodeRecord, setNodeFacts, touchNode } from "./store.ts";
import { NODE_PROTOCOL, nodeTargetFor, parseNodeFacts, type NodeClientFrame, type NodeFacts, type NodeServerFrame } from "./types.ts";

/**
 * The live side of the node protocol: one socket per node, tool calls round-tripped on it.
 *
 * A call is a promise resolved by the matching `node.result` frame, failed by a disconnect, a
 * timeout or an abort. Every call is journaled (node, tool, arguments, outcome) -- what ran on a
 * machine that is not this one is exactly what an owner later needs to audit.
 */

export interface NodeSocketData {
  node: true;
  nodeId: string;
  lastSeen: number;
}

type NodeWs = ServerWebSocket<NodeSocketData>;

interface PendingCall {
  tool: string;
  startedAt: number;
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveNode {
  ws: NodeWs;
  nodeId: string;
  facts?: NodeFacts;
  lastSeen: number;
  pending: Map<string, PendingCall>;
}

const live = new Map<string, LiveNode>();
let keepalive: ReturnType<typeof setInterval> | undefined;

const PING_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 90_000;
/** Backstop only: the node's own tool timeouts answer first. */
const CALL_TIMEOUT_MS = 600_000;
const ARGS_PREVIEW_CHARS = 500;

function send(ws: NodeWs, frame: NodeServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The socket went away; its close handler fails whatever was pending.
  }
}

function failPending(entry: LiveNode, reason: string): void {
  for (const [callId, pending] of entry.pending) {
    entry.pending.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve({ success: false, output: "", error: reason });
  }
}

export function attachNodeSocket(ws: NodeWs): void {
  const nodeId = ws.data.nodeId;
  const previous = live.get(nodeId);
  if (previous && previous.ws !== ws) {
    // One node, one connection: a client that reconnected before its old socket was reaped must
    // not leave a second socket that still receives calls nobody reads.
    failPending(previous, "the node reconnected on a new socket");
    try {
      previous.ws.close(4000, "replaced by a new connection");
    } catch {
      // Already gone.
    }
  }
  live.set(nodeId, { ws, nodeId, lastSeen: Date.now(), pending: new Map() });
  startKeepalive();
  void log("info", "node connected", { nodeId });
}

export function detachNodeSocket(ws: NodeWs): void {
  const entry = live.get(ws.data.nodeId);
  if (!entry || entry.ws !== ws) return;
  failPending(entry, "the node disconnected before answering");
  live.delete(ws.data.nodeId);
  void log("info", "node disconnected", { nodeId: ws.data.nodeId });
}

export function handleNodeFrame(ws: NodeWs, raw: string): void {
  const entry = live.get(ws.data.nodeId);
  if (!entry || entry.ws !== ws) return;
  entry.lastSeen = Date.now();

  let frame: NodeClientFrame;
  try {
    frame = JSON.parse(raw) as NodeClientFrame;
  } catch {
    return;
  }
  if (!frame || typeof frame !== "object") return;

  if (frame.type === "node.hello") {
    if (frame.protocol !== NODE_PROTOCOL) {
      try {
        ws.close(4002, "protocol mismatch");
      } catch {
        // Already gone.
      }
      return;
    }
    const facts = parseNodeFacts(frame.facts);
    if (!facts) {
      try {
        ws.close(4001, "invalid hello");
      } catch {
        // Already gone.
      }
      return;
    }
    entry.facts = facts;
    void setNodeFacts(entry.nodeId, facts);
    void offerNodeUpdate(ws, entry.nodeId, facts);
    return;
  }

  if (frame.type === "node.result") {
    const pending = entry.pending.get(frame.callId);
    if (!pending) return;
    entry.pending.delete(frame.callId);
    clearTimeout(pending.timer);
    const durationMs = Date.now() - pending.startedAt;
    void log(frame.ok ? "info" : "warn", "node tool finished", {
      nodeId: entry.nodeId,
      tool: pending.tool,
      durationMs,
      ok: frame.ok,
      outputChars: typeof frame.output === "string" ? frame.output.length : 0,
      ...(frame.error ? { error: frame.error } : {}),
    });
    pending.resolve({
      success: frame.ok === true,
      output: typeof frame.output === "string" ? frame.output : "",
      ...(frame.error ? { error: frame.error } : {}),
    });
    return;
  }

  if (frame.type === "node.pong") void touchNode(entry.nodeId);
}

export function nodeOnline(nodeId: string): boolean {
  return live.has(nodeId);
}

/**
 * A node of another version than this server is offered the build this server runs, on every
 * connect: the release carries the client beside the tarball, so "aligned" has one answer. The
 * frame is best-effort -- the node keeps serving from its old binary if the fetch fails, and the
 * protocol number above is what actually refuses an incompatible client.
 */
export async function offerNodeUpdate(ws: NodeWs, nodeId: string, facts: NodeFacts): Promise<void> {
  const serverVersion = await readAppVersion();
  if (!/^\d+\.\d+\.\d+$/.test(serverVersion)) return;
  if (!/^\d+\.\d+\.\d+$/.test(facts.version)) return;
  if (facts.version === serverVersion) return;
  const target = nodeTargetFor(facts.os, facts.arch);
  if (!target) return;
  void log("info", "node update offered", { nodeId, from: facts.version, to: serverVersion, target });
  send(ws, { type: "node.update", version: serverVersion, target });
}

/** The manifest a connected node announced. Absent when it is not connected. */
export function nodeFactsOf(nodeId: string): NodeFacts | undefined {
  return live.get(nodeId)?.facts;
}

export function nodeNameOf(nodeId: string): string {
  return nodeRecord(nodeId)?.name ?? nodeId;
}

export function callNodeTool(
  nodeId: string,
  tool: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ToolResult> {
  const entry = live.get(nodeId);
  if (!entry) {
    return Promise.resolve({ success: false, output: "", error: `the node is not connected` });
  }

  // The bridge enriches every call with `__`-prefixed context (signal, message, workspace): none
  // of it is the node's business, and an AbortSignal does not survive JSON.stringify.
  const wireArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("__")) wireArgs[key] = value;
  }

  const callId = randomUUID();
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<ToolResult>((resolve) => {
    const onAbort = (): void => {
      entry.pending.delete(callId);
      clearTimeout(timer);
      send(entry.ws, { type: "node.cancel", callId });
      void log("warn", "node tool cancelled", { nodeId, tool, durationMs: Date.now() - startedAt });
      resolve({ success: false, output: "", error: "cancelled" });
    };

    const timer = setTimeout(() => {
      entry.pending.delete(callId);
      options.signal?.removeEventListener("abort", onAbort);
      void log("warn", "node tool timed out", { nodeId, tool, timeoutMs });
      resolve({ success: false, output: "", error: `the node did not answer within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    entry.pending.set(callId, {
      tool,
      startedAt,
      timer,
      resolve: (result) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
    });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    void log("info", "node tool started", {
      nodeId,
      tool,
      args: previewArgs(wireArgs),
    });
    send(entry.ws, { type: "node.call", callId, tool, args: wireArgs, timeoutMs });
  });
}

function previewArgs(args: Record<string, unknown>): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    return "<unserializable>";
  }
  return encoded.length > ARGS_PREVIEW_CHARS ? `${encoded.slice(0, ARGS_PREVIEW_CHARS)}…` : encoded;
}

/** Revocation, from the owner: the socket is told why, then dropped. */
export function closeNodeSocket(nodeId: string, reason: string): boolean {
  const entry = live.get(nodeId);
  if (!entry) return false;
  send(entry.ws, { type: "node.bye", reason });
  failPending(entry, `the node was revoked (${reason})`);
  live.delete(nodeId);
  try {
    entry.ws.close(4003, reason);
  } catch {
    // Already gone.
  }
  return true;
}

/**
 * One ping per interval, and a socket that answered none of the last three is dropped: proxies on
 * the way kill idle connections without a close frame, and a socket nobody noticed dying is a
 * call that hangs until its timeout.
 */
function startKeepalive(): void {
  if (keepalive) return;
  keepalive = setInterval(() => {
    const now = Date.now();
    for (const entry of [...live.values()]) {
      if (now - entry.lastSeen > STALE_AFTER_MS) {
        failPending(entry, "the node stopped answering");
        live.delete(entry.nodeId);
        try {
          entry.ws.close(4004, "stale");
        } catch {
          // Already gone.
        }
        continue;
      }
      send(entry.ws, { type: "node.ping" });
    }
  }, PING_INTERVAL_MS);
  keepalive.unref?.();
}

/** Module-level state, reset between test files. */
export function resetNodeHub(): void {
  live.clear();
  if (keepalive) {
    clearInterval(keepalive);
    keepalive = undefined;
  }
}
