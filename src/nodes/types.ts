/**
 * A remote node: a small client installed on another machine, reached over the one WebSocket it
 * dials out to my-claw. This file is the wire shape and the stored record; the connection, the
 * store, the generated agent and the HTTP surface live beside it. docs/remote-nodes.md.
 */

export interface NodeToolManifest {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What a node announces about itself: at pairing, then again on every connect. */
export interface NodeFacts {
  os: string;
  arch: string;
  hostname: string;
  user: string;
  mode: "admin" | "user";
  version: string;
  tools: NodeToolManifest[];
}

export interface NodeRecord {
  nodeId: string;
  name: string;
  /** sha256 of the token. The token itself is shown once, at pairing, and never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  facts?: NodeFacts;
}

/** Node -> server frames. */
export type NodeClientFrame =
  | { type: "node.hello"; protocol: number; facts: NodeFacts }
  | { type: "node.result"; callId: string; ok: boolean; output: string; error?: string }
  | { type: "node.pong" };

/** Server -> node frames. */
export type NodeServerFrame =
  | { type: "node.call"; callId: string; tool: string; args: Record<string, unknown>; timeoutMs: number }
  | { type: "node.cancel"; callId: string }
  | { type: "node.ping" }
  | { type: "node.bye"; reason: string }
  /** The server runs another version than the node announced: fetch it and restart. */
  | { type: "node.update"; version: string; target: string };

export const NODE_PROTOCOL = 1;

/**
 * The build a machine with these facts needs, or null when nothing is published for it. The
 * release names follow the platform: `win32` is `windows`, the rest keep their own word.
 */
export function nodeTargetFor(os: string, arch: string): string | null {
  if (arch !== "x64" && arch !== "arm64") return null;
  if (os === "linux" || os === "darwin") return `${os}-${arch}`;
  if (os === "win32" && arch === "x64") return "windows-x64";
  return null;
}

const MAX_TOOLS = 64;
const MAX_TOOL_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_PARAMETERS_BYTES = 16 * 1024;
const TOOL_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function parseTool(value: unknown): NodeToolManifest | null {
  if (!value || typeof value !== "object") return null;
  const tool = value as { name?: unknown; description?: unknown; parameters?: unknown };
  const name = shortString(tool.name, MAX_TOOL_NAME);
  if (!name || !TOOL_NAME_RE.test(name)) return null;
  if (typeof tool.description !== "string" || tool.description.length > MAX_DESCRIPTION) return null;
  if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(tool.parameters);
  } catch {
    return null;
  }
  if (encoded.length > MAX_PARAMETERS_BYTES) return null;
  return { name, description: tool.description, parameters: tool.parameters as Record<string, unknown> };
}

/**
 * Facts arrive from a machine that is only trusted to describe itself, so everything is bounded
 * before it reaches a store, a prompt or a tool schema. Anything malformed rejects the whole
 * hello rather than half-registering a node.
 */
export function parseNodeFacts(value: unknown): NodeFacts | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<NodeFacts>;
  const os = shortString(raw.os, 32);
  const arch = shortString(raw.arch, 32);
  const hostname = shortString(raw.hostname, 128);
  const user = shortString(raw.user, 64);
  const version = shortString(raw.version, 32);
  const mode = raw.mode === "admin" || raw.mode === "user" ? raw.mode : null;
  if (!os || !arch || !hostname || !user || !version || !mode) return null;
  if (!Array.isArray(raw.tools) || raw.tools.length > MAX_TOOLS) return null;
  const tools: NodeToolManifest[] = [];
  for (const entry of raw.tools) {
    const tool = parseTool(entry);
    if (!tool) return null;
    tools.push(tool);
  }
  return { os, arch, hostname, user, mode, version, tools };
}
