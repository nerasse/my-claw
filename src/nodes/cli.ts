import { readFile } from "node:fs/promises";
import { CONFIG_PATH, type MyClawConfig } from "../core/config.ts";
import { nodeRecords } from "./store.ts";

/**
 * `myclaw node`: the shell half of node pairing.
 *
 * It reads the store directly for `ls`, and asks the running daemon for everything that touches
 * live state -- a claim code lives in the daemon's memory, and a revoke has to close a socket.
 * Both admin calls authenticate with a paired device, exactly like `/my-claw-app/ticket`.
 */

const USAGE = `usage: myclaw node <command>

  add [--name <name>] [--url <public url>]   mint a claim code for a machine
  ls                                         list paired nodes
  rm <nodeId>                                revoke a node, close its socket, remove its agent
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        flags[name] = args[i + 1] ?? "";
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

async function readConfig(): Promise<MyClawConfig> {
  const raw = await readFile(CONFIG_PATH, "utf-8").catch(() => "{}");
  try {
    return JSON.parse(raw) as MyClawConfig;
  } catch {
    // A broken config is reported by the write path; `ls` still has a store to read.
    return { whitelist: [], blacklist: [], channels: {}, llm: {}, agents: {} };
  }
}

/** The credential the admin routes take: the first enabled paired device. */
function adminDevice(config: MyClawConfig): { deviceId: string; token: string } | undefined {
  const devices = config.channels?.["my-claw-app"]?.devices ?? {};
  for (const [deviceId, entry] of Object.entries(devices)) {
    if (entry?.enabled !== false && entry?.token) return { deviceId, token: entry.token };
  }
  return undefined;
}

function channelPort(config: MyClawConfig): number {
  return config.channels?.["my-claw-app"]?.port ?? 8080;
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
  auth?: { deviceId: string; token: string },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    headers["X-My-Claw-Device"] = auth.deviceId;
    headers["Authorization"] = `Bearer ${auth.token}`;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: parsed.error ?? `daemon answered ${response.status}`, status: response.status };
    }
    return { ok: true, body: (await response.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, error: "the daemon is not reachable" };
  }
}

/**
 * Where a node reaches this server. Same rule as `myclaw device add`: the CLI knows the address
 * better than the daemon, which only sees the Host it was asked on.
 */
export function nodeServerUrl(flagUrl: string | undefined, env: Record<string, string | undefined>, port: number): string {
  const given = flagUrl?.trim() || env["MYCLAW_PUBLIC_URL"]?.trim();
  const base = given ? given.replace(/\/+$/, "") : `http://127.0.0.1:${port}`;
  return `${base.replace(/^http/, "ws")}/node`;
}

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function runNodeCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const command = positional[0];
  if (!command || command === "help" || flags["help"] !== undefined) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const config = await readConfig();
  const port = channelPort(config);

  if (command === "ls") {
    const nodes = nodeRecords();
    if (nodes.length === 0) {
      console.log("No paired node.");
      return 0;
    }
    for (const node of nodes) {
      const facts = node.facts;
      const detail = facts ? `${facts.os} ${facts.arch} ${facts.mode} "${facts.user}"` : "no facts";
      const seen = node.lastSeenAt ? ` last seen ${node.lastSeenAt}` : "";
      console.log(`${node.nodeId}  "${node.name}"  ${detail}${seen}`);
    }
    return 0;
  }

  const device = adminDevice(config);
  if (!device) {
    console.error("No paired device to authenticate with. Pair one first: myclaw setup");
    return 1;
  }

  if (command === "add") {
    const name = flags["name"]?.trim();
    const opened = await postJson(port, "/node/ticket", name ? { name } : {}, device);
    if (!opened.ok) {
      console.error(`No code: ${opened.error}. Is my-claw running? (myclaw status)`);
      return 1;
    }
    const code = String(opened.body["code"] ?? "");
    const server = nodeServerUrl(flags["url"], env, port);
    const httpBase = server.replace(/^ws/, "http").replace(/\/node$/, "");
    const shown = formatCode(code);
    console.log("Pair a node:\n");
    console.log(`Code    ${shown}   (single use, ten minutes)`);
    console.log(`Server  ${server}`);
    console.log("\nOn the machine to add, run (sudo for an admin install, without for user mode):\n");
    console.log(`  curl -fsSL '${httpBase}/node/install.sh' | sudo sh -s -- --pair ${shown} --server ${server}`);
    return 0;
  }

  if (command === "rm") {
    const nodeId = positional[1];
    if (!nodeId) {
      console.error("rm needs a node id");
      return 1;
    }
    const revoked = await postJson(port, "/node/revoke", { nodeId }, device);
    if (!revoked.ok) {
      console.error(`Revoke failed: ${revoked.error}`);
      return 1;
    }
    console.log(`Revoked ${nodeId}`);
    return 0;
  }

  console.log(USAGE);
  return 1;
}
