import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep, join } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";

/**
 * The node's own configuration and credentials, all under one directory (0600 for anything that
 * is a secret). Nothing here is read from my-claw's server config: this file is the ceiling the
 * machine's owner set, and the server can only narrow it further (docs/remote-nodes.md).
 */

export const ALL_TOOLS = ["bash", "read", "write", "apply_patch", "search", "ls"] as const;
export type NodeToolName = (typeof ALL_TOOLS)[number];

export interface NodeClientConfig {
  /** The my-claw endpoint, e.g. `wss://myclaw.example/node`. */
  server: string;
  /** Display name; written at pairing (the claim's name, else the hostname). */
  name?: string;
  /** Working directory for bash and for relative paths. Defaults to the user's home. */
  workdir?: string;
  /** Tools exposed to my-claw. Absent = all of them. */
  tools?: NodeToolName[];
  /** Drops `write` and `apply_patch`; `bash` stays, it is the machine's own shell. */
  readOnly?: boolean;
  /** Directories the file tools may touch. Absent = no restriction. */
  roots?: string[];
}

export interface ClientTls {
  ca: string;
  cert: string;
  key: string;
}

/**
 * `MYCLAW_NODE_DIR` wins (the service units set it: an admin install keeps its config under
 * /etc, a user install under the home). Windows has no better default than the home too.
 */
export function nodeDir(env: Record<string, string | undefined> = process.env): string {
  const given = env["MYCLAW_NODE_DIR"]?.trim();
  if (given) return resolve(given);
  return join(homedir(), ".my-claw-node");
}

const CONFIG_FILE = "config.json";
const TOKEN_FILE = "token";
const TLS_CA_FILE = "ca.pem";
const TLS_CERT_FILE = "client.pem";
const TLS_KEY_FILE = "client-key.pem";

/** The exposed set: the config's list (or all), minus the writes when `readOnly`. */
export function exposedTools(config: NodeClientConfig): NodeToolName[] {
  const wanted = config.tools ?? [...ALL_TOOLS];
  const known = wanted.filter((name): name is NodeToolName => (ALL_TOOLS as readonly string[]).includes(name));
  return config.readOnly ? known.filter((name) => name !== "write" && name !== "apply_patch") : known;
}

/** The roots ceiling, for the file tools. Absent roots mean the machine is fully open. */
export function pathAllowed(config: NodeClientConfig, path: string): boolean {
  if (!config.roots?.length) return true;
  const target = resolve(path);
  return config.roots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base + sep);
  });
}

export async function loadConfig(dir = nodeDir()): Promise<NodeClientConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf-8")) as NodeClientConfig;
    if (typeof raw.server !== "string" || !raw.server) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveConfig(config: NodeClientConfig, dir = nodeDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomically(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2));
}

export async function loadToken(dir = nodeDir()): Promise<string | null> {
  try {
    const token = (await readFile(join(dir, TOKEN_FILE), "utf-8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function saveToken(token: string, dir = nodeDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomically(join(dir, TOKEN_FILE), token, { mode: 0o600 });
  await chmod(join(dir, TOKEN_FILE), 0o600);
}

/** Present when the server issued certificates at pairing; absent in the plain-endpoint mode. */
export async function loadClientTls(dir = nodeDir()): Promise<ClientTls | null> {
  try {
    const [ca, cert, key] = await Promise.all([
      readFile(join(dir, TLS_CA_FILE), "utf-8"),
      readFile(join(dir, TLS_CERT_FILE), "utf-8"),
      readFile(join(dir, TLS_KEY_FILE), "utf-8"),
    ]);
    return { ca, cert, key };
  } catch {
    return null;
  }
}

export async function saveClientTls(tls: ClientTls, dir = nodeDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomically(join(dir, TLS_CA_FILE), tls.ca, { mode: 0o600 });
  await writeFileAtomically(join(dir, TLS_CERT_FILE), tls.cert, { mode: 0o600 });
  await writeFileAtomically(join(dir, TLS_KEY_FILE), tls.key, { mode: 0o600 });
  await Promise.all([
    chmod(join(dir, TLS_CA_FILE), 0o600),
    chmod(join(dir, TLS_CERT_FILE), 0o600),
    chmod(join(dir, TLS_KEY_FILE), 0o600),
  ]);
}

/** `wss://host/node` -> `https://host/node`, for the pair and download calls. */
export function httpBaseOf(server: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString().replace(/\/+$/, "");
}
