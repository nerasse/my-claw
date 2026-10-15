import { NODE_PROTOCOL, type NodeFacts, type NodeServerFrame } from "../nodes/types.ts";
import type { ClientTls, NodeClientConfig } from "./config.ts";
import { buildFacts } from "./facts.ts";
import { runTool } from "./tools.ts";

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

export interface RunNodeOptions {
  config: NodeClientConfig;
  token: string;
  tls?: ClientTls | null;
  log: NodeLogger;
  /** Return once the first connection closes (tests, `--once`). */
  once?: boolean;
  /** Stop the loop: the socket is closed and runNode returns (SIGTERM, tests). */
  signal?: AbortSignal;
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
  const facts = buildFacts(options.config);
  let delay = backoff.initialMs;

  for (;;) {
    if (options.signal?.aborted) return;
    const startedAt = Date.now();
    try {
      await connectOnce(options, facts);
    } catch (err) {
      if (err instanceof NodeRevokedError) throw err;
      options.log("warn", "connection failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (options.once || options.signal?.aborted) return;
    if (Date.now() - startedAt > HEALTHY_SESSION_MS) delay = backoff.initialMs;
    await sleep(delay, options.signal);
    delay = Math.min(delay * 2, backoff.maxMs);
  }
}

/** One connection, from open to close. Resolves when the socket closed; throws on revoke. */
async function connectOnce(options: RunNodeOptions, facts: NodeFacts): Promise<void> {
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
      send({ type: "node.hello", protocol: NODE_PROTOCOL, facts });
      log("info", "connected", { server: options.config.server, name: options.config.name ?? facts.hostname });
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
        void runTool(options.config, frame.tool, frame.args, controller.signal).then((result) => {
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
          });
        });
        return;
      }
      if (frame.type === "node.cancel") {
        running.get(frame.callId)?.abort();
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
