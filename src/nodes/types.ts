import type { McpServerConfig } from "../core/config.ts";

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

/** One MCP server the node runs, as the node reports it: name, whether it came up, its tools. */
export interface NodeMcpStatus {
  name: string;
  ok: boolean;
  tools: number;
  error?: string;
}

/** A file a remote tool hands back: the bytes were uploaded to this server, the path is its own. */
export interface NodeAttachment {
  type: "image" | "audio" | "video" | "file";
  path: string;
  mimeType?: string;
  filename?: string;
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
  /** The MCP servers it runs, and how each came up. */
  mcp?: NodeMcpStatus[];
}

export interface NodeRecord {
  nodeId: string;
  name: string;
  /** sha256 of the token. The token itself is shown once, at pairing, and never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  facts?: NodeFacts;
  /**
   * The subset of the machine's tools this server exposes to the node's agent. Absent means every
   * tool the machine announces; a name the machine does not offer is simply never matched, so the
   * machine's own config stays the ceiling.
   */
  tools?: string[];
  /** Ask before running anything on that machine (the app's second lock). */
  approval?: boolean;
  /**
   * The node's agent does not run. The machine stays connected -- its version, its tools and its
   * updates are still visible -- but a spawn is refused, and the catalog says so.
   */
  disabled?: boolean;
  /**
   * The MCP servers this server asked the node to run, by name. Pushed on every connect and on
   * every change; the node persists the list and starts them from it.
   */
  mcp?: Record<string, McpServerConfig>;
}

/** Node -> server frames. */
export type NodeClientFrame =
  | { type: "node.hello"; protocol: number; facts: NodeFacts }
  | { type: "node.result"; callId: string; ok: boolean; output: string; error?: string; attachments?: NodeAttachment[] }
  | { type: "node.put.result"; callId: string; ok: boolean; path?: string; error?: string }
  | { type: "node.pong" };

/** Server -> node frames. */
export type NodeServerFrame =
  | { type: "node.call"; callId: string; tool: string; args: Record<string, unknown>; timeoutMs: number }
  | { type: "node.cancel"; callId: string }
  | { type: "node.ping" }
  | { type: "node.bye"; reason: string }
  /** The MCP servers this server wants the node to run: the app's list, applied and persisted. */
  | { type: "node.config"; mcp: Record<string, McpServerConfig> }
  /** A file for the node to fetch from `url` (one-shot ticket) and write at `path`. */
  | { type: "node.put"; callId: string; path: string; url: string }
  /** The server runs another version than the node announced: fetch it and restart. */
  | { type: "node.update"; version: string; target: string; force?: boolean };

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
/** More MCP servers than this on one machine is a mistake, not a setup. */
const MAX_MCP_SERVERS = 32;
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
 * hello rather than half-registering a node; the MCP status list is the exception -- a status
 * line is display, so a bad entry is dropped and the hello stands.
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
  const mcp = parseMcpStatus(raw.mcp);
  return { os, arch, hostname, user, mode, version, tools, ...(mcp.length > 0 ? { mcp } : {}) };
}

function parseMcpStatus(value: unknown): NodeMcpStatus[] {
  if (!Array.isArray(value)) return [];
  const statuses: NodeMcpStatus[] = [];
  for (const entry of value.slice(0, MAX_MCP_SERVERS)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as { name?: unknown; ok?: unknown; tools?: unknown; error?: unknown };
    const name = shortString(raw.name, MAX_TOOL_NAME);
    if (!name || typeof raw.ok !== "boolean") continue;
    const count = typeof raw.tools === "number" && Number.isFinite(raw.tools) ? Math.max(0, Math.min(MAX_TOOLS, Math.trunc(raw.tools))) : 0;
    const error = typeof raw.error === "string" && raw.error.trim() ? raw.error.trim().slice(0, MAX_DESCRIPTION) : undefined;
    statuses.push({ name, ok: raw.ok, tools: raw.ok ? count : 0, ...(error ? { error } : {}) });
  }
  return statuses;
}
