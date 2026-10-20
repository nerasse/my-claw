import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { NODE_PROTOCOL, type NodeAttachment, type NodeFacts, type NodeServerFrame } from "../nodes/types.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { mediaTypeForPath } from "../utils/media.ts";
import { httpBaseOf, pathAllowed, resolvePath, saveConfig, type ClientTls, type NodeClientConfig } from "./config.ts";
import { buildFacts } from "./facts.ts";
import { NodeMcpHub } from "./mcp.ts";
import { runTool } from "./tools.ts";
import { applyUpdate, canAttemptUpdate, markUpdateAttempt } from "./update.ts";

/**
 * The node's one socket: dial out, say hello, run what the server asks, reconnect when it drops.
 *
 * Nothing listens on this machine. The socket is opened by the node, kept alive by the server's
 * pings, and every tool call runs here with the rights of the account the service runs as.
 * docs/remote-nodes.md.
 */

export type NodeLogLevel = "info" | "warn" | "error";
export type NodeLogger = (level: NodeLogLevel, message: string, data?: Record<string, unknown>) => void;

export class NodeRevokedError extends Error {}

/**
 * Whether an offer is acted on. A normal one waits out the window (one attempt per version per
 * half hour); a forced one -- the owner pressing update in the app -- always is.
 */
export function shouldApplyUpdate(version: string, force: boolean | undefined, now = Date.now()): boolean {
  return force === true || canAttemptUpdate(version, now);
}

export interface RunNodeOptions {
  config: NodeClientConfig;
  token: string;
  tls?: ClientTls | null;
  log: NodeLogger;
  /** Return once the first connection closes (tests, `--once`). */
  once?: boolean;
  /** Stop the loop: the socket is closed and runNode returns (SIGTERM, tests). */
  signal?: AbortSignal;
  /** Config dir, handed to the restarted process when an update lands on Windows. */
  dir?: string;
  backoff?: { initialMs: number; maxMs: number };
}

const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 60_000 };
/** A session that lasted this long was healthy; the next failure starts the backoff over. */
const HEALTHY_SESSION_MS = 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runNode(options: RunNodeOptions): Promise<void> {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let delay = backoff.initialMs;
  // The MCP servers outlive a socket: they are started once, from the config the last server left,
  // and a reconnect must not restart Godot's addon.
  const mcp = new NodeMcpHub({
    log: (level, message, data) => options.log(level, message, data),
    upload: (bytes, filename, mimeType) => uploadToServer(options, bytes, filename, mimeType),
  });
  await mcp.apply(options.config.mcp ?? {});

  try {
    for (;;) {
      if (options.signal?.aborted) return;
      const startedAt = Date.now();
      try {
        await connectOnce(options, mcp);
      } catch (err) {
        if (err instanceof NodeRevokedError) throw err;
        options.log("warn", "connection failed", { error: err instanceof Error ? err.message : String(err) });
      }
      if (options.once || options.signal?.aborted) return;
      if (Date.now() - startedAt > HEALTHY_SESSION_MS) delay = backoff.initialMs;
      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  } finally {
    await mcp.closeAll();
  }
}

/** The facts a hello carries right now: the machine, its own tools, then the MCP servers'. */
function factsNow(config: NodeClientConfig, mcp: NodeMcpHub): NodeFacts {
  const base = buildFacts(config);
  const statuses = mcp.statuses();
  return {
    ...base,
    tools: [...base.tools, ...mcp.manifest()],
    ...(statuses.length > 0 ? { mcp: statuses } : {}),
  };
}

/** A file this machine produced, handed to the server that asked: it owns the only copy the model sees. */
async function uploadToServer(options: RunNodeOptions, bytes: Uint8Array, filename: string, mimeType?: string): Promise<NodeAttachment | undefined> {
  try {
    const response = await fetch(`${httpBaseOf(options.config.server)}/node/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "content-type": mimeType ?? "application/octet-stream",
        "x-file-name": basename(filename),
      },
      body: bytes,
    });
    if (!response.ok) {
      await response.body?.cancel();
      options.log("warn", "upload refused", { status: response.status, filename });
      return undefined;
    }
    const body = (await response.json().catch(() => undefined)) as { path?: unknown; filename?: unknown; error?: unknown } | undefined;
    if (typeof body?.path !== "string") return undefined;
    const stored = typeof body.filename === "string" ? body.filename : basename(filename);
    return { type: mediaTypeForPath(stored), path: body.path, filename: stored, ...(mimeType ? { mimeType } : {}) };
  } catch (err) {
    options.log("warn", "upload failed", { error: String(err), filename });
    return undefined;
  }
}

/**
 * A file the server pushes: the node fetches it from a one-shot ticket and writes it itself, so
 * the socket never carries megabytes of JSON.
 */
async function receiveFile(options: RunNodeOptions, path: string, url: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const response = await fetch(`${httpBaseOf(options.config.server)}${url}`, { headers: { Authorization: `Bearer ${options.token}` } });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, error: `the server refused the file (HTTP ${response.status})` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const target = resolvePath(options.config, path);
    if (!pathAllowed(options.config, target)) return { ok: false, error: `outside the allowed roots: ${target}` };
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomically(target, bytes);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** One connection, from open to close. Resolves when the socket closed; throws on revoke. */
async function connectOnce(options: RunNodeOptions, mcp: NodeMcpHub): Promise<void> {
  const { log } = options;
  // `ca` is deliberately not passed: the stored CA is the one the *proxy* verifies this machine
  // with, not a trust anchor for the server's own certificate, which is a public one.
  const ws = new WebSocket(options.config.server, {
    headers: { Authorization: `Bearer ${options.token}` },
    ...(options.tls ? { tls: { cert: options.tls.cert, key: options.tls.key } } : {}),
  });

  const running = new Map<string, AbortController>();
  const send = (frame: object): void => {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    } catch {
      // The socket went away; the close handler deals with it.
    }
  };

  await new Promise<void>((resolve, reject) => {
    let opened = false;
    // `close()` is a no-op on a socket that is still connecting, so an abort in that window
    // (measured: the server attaches the upgrade a beat before the client's own open event) would
    // be swallowed and the run would hang on a healthy socket nobody wants any more. The open
    // handler finishes what the abort asked for.
    let aborting = false;
    const closeForAbort = (): void => {
      try {
        ws.close(1000, "shutting down");
      } catch {
        // Already gone; the close handler (or its absence) settles the promise.
      }
    };
    const onAbort = (): void => {
      aborting = true;
      if (ws.readyState === WebSocket.CONNECTING) {
        resolve();
        return;
      }
      closeForAbort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    ws.onopen = () => {
      opened = true;
      if (aborting) {
        closeForAbort();
        return;
      }
      send({ type: "node.hello", protocol: NODE_PROTOCOL, facts: factsNow(options.config, mcp) });
      log("info", "connected", { server: options.config.server, name: options.config.name });
    };
    ws.onmessage = (event) => {
      let frame: NodeServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as NodeServerFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;

      if (frame.type === "node.call") {
        const controller = new AbortController();
        running.set(frame.callId, controller);
        const startedAt = Date.now();
        void runTool(options.config, frame.tool, frame.args, controller.signal, {
          upload: (bytes, filename, mimeType) => uploadToServer(options, bytes, filename, mimeType),
          mcp: { call: (name, args) => mcp.call(name, args) },
        }).then((result) => {
          running.delete(frame.callId);
          log(result.ok ? "info" : "warn", "tool finished", {
            tool: frame.tool,
            callId: frame.callId,
            durationMs: Date.now() - startedAt,
            ok: result.ok,
          });
          send({
            type: "node.result",
            callId: frame.callId,
            ok: result.ok,
            output: result.output,
            ...(result.error ? { error: result.error } : {}),
            ...(result.attachments?.length ? { attachments: result.attachments } : {}),
          });
        });
        return;
      }
      if (frame.type === "node.cancel") {
        running.get(frame.callId)?.abort();
        return;
      }
      if (frame.type === "node.update") {
        // The server runs another version: fetch it through the relay and restart on it. One
        // attempt per version per window, so a relay that refuses is not hammered -- `force` is
        // the owner asking from the app, which lifts the window rather than being refused by it.
        if (!shouldApplyUpdate(frame.version, frame.force)) return;
        markUpdateAttempt(frame.version);
        log("info", "update offered", { version: frame.version, target: frame.target, ...(frame.force === true ? { forced: true } : {}) });
        void applyUpdate({
          server: options.config.server,
          token: options.token,
          version: frame.version,
          target: frame.target,
          ...(options.dir ? { dir: options.dir } : {}),
          log,
        }).then((outcome) => {
          if (outcome === "failed") log("warn", "update failed; still running the old build", { version: frame.version });
        });
        return;
      }
      if (frame.type === "node.config") {
        // The app owns this list: persist it, start what it names, then say what came up.
        options.config.mcp = frame.mcp;
        void (async () => {
          await saveConfig(options.config, options.dir).catch(err => log("warn", "config save failed", { error: String(err) }));
          await mcp.apply(frame.mcp);
          send({ type: "node.hello", protocol: NODE_PROTOCOL, facts: factsNow(options.config, mcp) });
        })();
        return;
      }
      if (frame.type === "node.put") {
        void receiveFile(options, frame.path, frame.url).then((outcome) => {
          send({
            type: "node.put.result",
            callId: frame.callId,
            ok: outcome.ok,
            ...(outcome.path ? { path: outcome.path } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        });
        return;
      }
      if (frame.type === "node.ping") {
        send({ type: "node.pong" });
        return;
      }
      if (frame.type === "node.bye") {
        log("warn", "the server said goodbye", { reason: frame.reason });
      }
    };
    ws.onclose = (event) => {
      options.signal?.removeEventListener("abort", onAbort);
      for (const controller of running.values()) controller.abort();
      running.clear();
      if (event.code === 4003) {
        reject(new NodeRevokedError(`the server revoked this node (${event.reason || "revoked"})`));
        return;
      }
      resolve();
    };
    ws.onerror = () => {
      if (!opened) reject(new Error("could not connect"));
    };
  });
}
