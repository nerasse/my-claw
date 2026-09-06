import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import type { McpServerConfig } from "../core/config.ts";
import type { Tool } from "../tools/types.ts";
import { McpConnection } from "./connection.ts";

interface Entry {
  configKey: string;
  conn: McpConnection;
}

/**
 * Per-server view for `/mcp`. Built from the *declared* set, not from the live connections: a
 * server that failed to connect used to be logged and dropped, so listing only what is connected
 * hid exactly the servers worth reporting.
 */
export interface McpServerStatus {
  name: string;
  transport: McpServerConfig["transport"];
  state: "connected" | "disabled" | "failed";
  toolCount: number;
  /** Present only for `failed`, carried over from the caught connect error. */
  lastError?: string;
  /** ISO timestamp of the last connect attempt, absent for a server never attempted (disabled). */
  lastAttemptAt?: string;
}

function isEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

/** Reconnect backoff after a server goes away: five seconds, doubling, capped at five minutes. */
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

// Identity of a server's wiring: a change here means reconnect, anything else is a no-op.
function configKey(config: McpServerConfig): string {
  return JSON.stringify({
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    url: config.url,
    headers: config.headers,
  });
}

/**
 * Owns the live connections to external MCP servers declared in config.mcp and exposes
 * their tools as my-claw Tools. A single manager feeds both backends: the home loop reads
 * getTools() directly, and the Claude SDK sees the same tools through the in-process tool
 * server (both build their tool set from the registry's dynamic provider). One connection
 * per server, no double-spawn.
 *
 * sync() diffs the config so a hot-reload only reconnects servers whose wiring changed.
 */
export class McpManager {
  private entries = new Map<string, Entry>();
  // Survives a failed connect so the reason is still reportable. Keyed by server name and cleared
  // when that server later connects.
  private failures = new Map<string, { error: string; at: string }>();
  private declared: Record<string, McpServerConfig> = {};
  private lastAttemptAt = new Map<string, string>();
  /** Reconnect attempts since a server was last up, and the timer arming the next one. */
  private backoff = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  async sync(mcp: Record<string, McpServerConfig> | undefined): Promise<void> {
    this.declared = { ...(mcp ?? {}) };
    const desired = new Map<string, McpServerConfig>();
    for (const [name, config] of Object.entries(mcp ?? {})) {
      if (isEnabled(config)) desired.set(name, config);
    }

    // Drop servers that are gone, disabled, or whose wiring changed (they get reconnected below).
    for (const [name, entry] of [...this.entries]) {
      const next = desired.get(name);
      if (!next || configKey(next) !== entry.configKey) {
        await entry.conn.close();
        this.entries.delete(name);
      }
    }

    // Connect servers that are newly desired (or were just dropped for a wiring change).
    const added: string[] = [];
    await Promise.all(
      [...desired].map(async ([name, config]) => {
        if (this.entries.has(name)) return;
        const ok = await this.open(name, config);
        if (ok) added.push(name);
      }),
    );

    if (added.length > 0) {
      void log("info", "mcp servers connected", { servers: added, toolCount: this.getTools().length });
    }
    hooks.emit("mcp:synced", { servers: [...this.entries.keys()], toolCount: this.getTools().length });
  }

  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const entry of this.entries.values()) tools.push(...entry.conn.getTools());
    return tools;
  }

  serverNames(): string[] {
    return [...this.entries.keys()];
  }

  /** Declared servers with their live state, in config order so the output matches the file. */
  status(): McpServerStatus[] {
    return Object.entries(this.declared).map(([name, config]) => {
      const entry = this.entries.get(name);
      const failure = this.failures.get(name);
      const lastAttemptAt = this.lastAttemptAt.get(name);
      if (entry) {
        return { name, transport: config.transport, state: "connected" as const, toolCount: entry.conn.getTools().length, lastAttemptAt };
      }
      // Disabled outranks failed: a server switched off after a failure is not a problem to report.
      if (!isEnabled(config)) {
        return { name, transport: config.transport, state: "disabled" as const, toolCount: 0, lastAttemptAt };
      }
      return { name, transport: config.transport, state: "failed" as const, toolCount: 0, lastError: failure?.error, lastAttemptAt: failure?.at ?? lastAttemptAt };
    });
  }

  /**
   * One connection attempt, and the wiring that makes a lost server come back.
   *
   * Nothing used to notice a peer going away: a stdio server that exited kept its tools listed and
   * every call failed one at a time until the next restart. `onClosed` drops the entry and arms a
   * retry instead.
   */
  private async open(name: string, config: McpServerConfig): Promise<boolean> {
    const conn = new McpConnection(name, config);
    this.lastAttemptAt.set(name, new Date().toISOString());
    try {
      await conn.connect();
      conn.onClosed(() => this.handleLoss(name, config));
      this.entries.set(name, { configKey: configKey(config), conn });
      this.failures.delete(name);
      this.backoff.delete(name);
      return true;
    } catch (err) {
      this.failures.set(name, { error: String(err), at: new Date().toISOString() });
      void log("error", "mcp server connect failed", { server: name, error: String(err) });
      await conn.close().catch(() => undefined);
      return false;
    }
  }

  private handleLoss(name: string, config: McpServerConfig): void {
    if (this.stopped) return;
    this.entries.delete(name);
    this.failures.set(name, { error: "connection lost", at: new Date().toISOString() });
    void log("warn", "mcp server connection lost", { server: name });
    hooks.emit("mcp:synced", { servers: [...this.entries.keys()], toolCount: this.getTools().length });
    this.scheduleReconnect(name, config);
  }

  private scheduleReconnect(name: string, config: McpServerConfig): void {
    if (this.stopped || this.timers.has(name)) return;
    const attempt = (this.backoff.get(name) ?? 0) + 1;
    this.backoff.set(name, attempt);
    // Jittered, and capped at five minutes: a server that is down for the afternoon must not be
    // dialled every five seconds until it comes back.
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (attempt - 1));
    const delay = base / 2 + Math.random() * (base / 2);
    const timer = setTimeout(() => {
      this.timers.delete(name);
      if (this.stopped) return;
      // Only if it is still declared and still wanted: a server removed from the config while it
      // was down must not be resurrected by its own retry.
      const declared = this.declared[name];
      if (!declared || configKey(declared) !== configKey(config) || !isEnabled(declared)) return;
      void this.open(name, config).then((ok) => {
        if (ok) {
          void log("info", "mcp server reconnected", { server: name });
          hooks.emit("mcp:synced", { servers: [...this.entries.keys()], toolCount: this.getTools().length });
        } else {
          this.scheduleReconnect(name, config);
        }
      });
    }, delay);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.entries.values()].map((e) => e.conn.close()));
    this.entries.clear();
  }
}
