import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "../tools/types.ts";
import { readAppVersion } from "../core/diagnostics.ts";
import { log } from "../utils/logger.ts";
import { nodeRecord, setNodeFacts, touchNode } from "./store.ts";
import { isNodeUploadPath, openFileTicket } from "./files.ts";
import { basename } from "node:path";
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
  /** Files being pushed to the machine, answered by `node.put.result`. */
  pendingPuts: Map<string, { resolve: (result: PutResult) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface PutResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const live = new Map<string, LiveNode>();
let keepalive: ReturnType<typeof setInterval> | undefined;

/**
 * Told when a node comes or goes, so a roster on a screen can say so without being reloaded.
 * A listener that throws must not take the socket path with it.
 */
const presenceListeners = new Set<(nodeId: string, online: boolean) => void>();

export function onNodePresence(listener: (nodeId: string, online: boolean) => void): () => void {
  presenceListeners.add(listener);
  return () => presenceListeners.delete(listener);
}

function notifyPresence(nodeId: string, online: boolean): void {
  for (const listener of presenceListeners) {
    try {
      listener(nodeId, online);
    } catch {
      // The screen's problem, never the socket's.
    }
  }
}

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
  for (const [callId, put] of entry.pendingPuts) {
    entry.pendingPuts.delete(callId);
    clearTimeout(put.timer);
    put.resolve({ ok: false, error: reason });
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
  live.set(nodeId, { ws, nodeId, lastSeen: Date.now(), pending: new Map(), pendingPuts: new Map() });
  startKeepalive();
  void log("info", "node connected", { nodeId });
  // The MCP list the app set is the machine's standing order: handed over on every connect, so a
  // node that was away when it changed catches up without anyone pressing anything.
  const record = nodeRecord(nodeId);
  if (record?.mcp) send(ws, { type: "node.config", mcp: record.mcp });
  notifyPresence(nodeId, true);
}

export function detachNodeSocket(ws: NodeWs): void {
  const entry = live.get(ws.data.nodeId);
  if (!entry || entry.ws !== ws) return;
  failPending(entry, "the node disconnected before answering");
  live.delete(ws.data.nodeId);
  void log("info", "node disconnected", { nodeId: ws.data.nodeId });
  notifyPresence(ws.data.nodeId, false);
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
    // A node may claim any path it likes; only the files it actually uploaded here are readable.
    const attachments = (Array.isArray(frame.attachments) ? frame.attachments : [])
      .filter((file) => file && typeof file.path === "string" && isNodeUploadPath(entry.nodeId, file.path))
      .map((file) => ({
        type: file.type === "image" || file.type === "audio" || file.type === "video" || file.type === "file" ? file.type : "file" as const,
        path: file.path,
        ...(typeof file.mimeType === "string" ? { mimeType: file.mimeType } : {}),
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
      }));
    void log(frame.ok ? "info" : "warn", "node tool finished", {
      nodeId: entry.nodeId,
      tool: pending.tool,
      durationMs,
      ok: frame.ok,
      outputChars: typeof frame.output === "string" ? frame.output.length : 0,
      ...(attachments.length > 0 ? { attachments: attachments.length } : {}),
      ...(frame.error ? { error: frame.error } : {}),
    });
    pending.resolve({
      success: frame.ok === true,
      output: typeof frame.output === "string" ? frame.output : "",
      ...(frame.error ? { error: frame.error } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    return;
  }

  if (frame.type === "node.put.result") {
    const put = entry.pendingPuts.get(frame.callId);
    if (!put) return;
    entry.pendingPuts.delete(frame.callId);
    clearTimeout(put.timer);
    void log(frame.ok ? "info" : "warn", "node file sent", {
      nodeId: entry.nodeId,
      ok: frame.ok,
      ...(frame.path ? { path: frame.path } : {}),
      ...(frame.error ? { error: frame.error } : {}),
    });
    put.resolve({
      ok: frame.ok === true,
      ...(typeof frame.path === "string" ? { path: frame.path } : {}),
      ...(typeof frame.error === "string" ? { error: frame.error } : {}),
    });
    return;
  }

  if (frame.type === "node.pong") void touchNode(entry.nodeId);
}

export function nodeOnline(nodeId: string): boolean {
  return live.has(nodeId);
}

/**
 * How a node reads from the outside, for the catalog and for a spawn: a disabled node stays
 * connected (its version, its tools, its updates are all still visible) but its agent does not
 * run. A record that is gone is its own answer -- the agent file may well still be there.
 */
export function nodeState(nodeId: string): "online" | "offline" | "disabled" | "gone" {
  const record = nodeRecord(nodeId);
  if (!record) return "gone";
  if (record.disabled === true) return "disabled";
  return live.has(nodeId) ? "online" : "offline";
}

/**
 * Offers the server's build to a connected node right now, at the owner's request: the retry a
 * node that failed its download would otherwise wait half an hour for. `force` is what lifts the
 * node's own window, and the node still proves the new binary before it swaps it in.
 */
export async function offerNodeUpdateNow(nodeId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = live.get(nodeId);
  if (!entry) return { ok: false, error: "the node is offline" };
  const facts = entry.facts;
  if (!facts) return { ok: false, error: "the node has not announced itself yet" };
  const serverVersion = await readAppVersion();
  if (!/^\d+\.\d+\.\d+$/.test(serverVersion)) return { ok: false, error: "this server's version is unknown" };
  if (facts.version === serverVersion) return { ok: false, error: `the node already runs ${serverVersion}` };
  const target = nodeTargetFor(facts.os, facts.arch);
  if (!target) return { ok: false, error: `no build is published for ${facts.os} ${facts.arch}` };
  void log("info", "node update forced", { nodeId, from: facts.version, to: serverVersion, target });
  send(entry.ws, { type: "node.update", version: serverVersion, target, force: true });
  return { ok: true };
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

/** Hands the machine a file of this server's, through a one-shot ticket it fetches itself. */
export function putFileToNode(nodeId: string, path: string): Promise<PutResult> {
  const entry = live.get(nodeId);
  if (!entry) return Promise.resolve({ ok: false, error: "the node is not connected" });
  const ticket = openFileTicket(nodeId, path);
  const callId = randomUUID();
  return new Promise<PutResult>((resolve) => {
    const timer = setTimeout(() => {
      entry.pendingPuts.delete(callId);
      void log("warn", "node file put timed out", { nodeId, path });
      resolve({ ok: false, error: "the node did not answer in time" });
    }, CALL_TIMEOUT_MS);
    entry.pendingPuts.set(callId, { resolve, timer });
    send(entry.ws, { type: "node.put", callId, path: basename(path), url: ticket.url });
  });
}

/** The MCP list this server wants a connected node to run; silent for one that is away. */
export function pushNodeMcp(nodeId: string): boolean {
  const entry = live.get(nodeId);
  if (!entry) return false;
  send(entry.ws, { type: "node.config", mcp: nodeRecord(nodeId)?.mcp ?? {} });
  return true;
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
  presenceListeners.clear();
  if (keepalive) {
    clearInterval(keepalive);
    keepalive = undefined;
  }
}
