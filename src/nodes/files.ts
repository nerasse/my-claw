import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { mediaTypeForPath } from "../utils/media.ts";
import type { NodeAttachment } from "./types.ts";

/**
 * Files crossing between a node and this server. Both directions are gated by the node's own
 * token: the bytes a remote tool produces come back here, and the bytes this server sends are
 * fetched by the node from a one-shot ticket.
 *
 * Uploads land under `$MY_CLAW_DIR/nodes/files/<nodeId>/`, outside the workspace, so a file a
 * remote machine wrote is never readable as if the agent had written it.
 */

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** A ticket is redeemed within seconds of being offered: one call, one fetch. */
const TICKET_TTL_MS = 120_000;

export interface NodeUpload {
  path: string;
  filename: string;
  size: number;
}

export function nodeUploadLimit(): number {
  return MAX_UPLOAD_BYTES;
}

/**
 * Whether a path a node named is one this server stored for it: a frame from a machine is a claim,
 * and only the files it actually uploaded here may reach a prompt or a screen.
 */
export function isNodeUploadPath(nodeId: string, path: string): boolean {
  const dir = join(MY_CLAW_DIR, "nodes", "files", nodeId, "");
  return path.startsWith(dir) && !path.includes("..");
}

/** A file name is a claim from another machine: keep a readable stem, nothing that walks paths. */
function safeName(raw: string): string {
  const base = basename(raw).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return base.slice(0, 120) || "file";
}

export async function storeNodeUpload(nodeId: string, filename: string, bytes: Uint8Array): Promise<NodeUpload> {
  if (bytes.byteLength === 0) throw new Error("empty upload");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`uploads are at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`);
  const dir = join(MY_CLAW_DIR, "nodes", "files", nodeId);
  await mkdir(dir, { recursive: true });
  const name = `${randomBytes(6).toString("hex")}-${safeName(filename)}`;
  const path = join(dir, name);
  await writeFile(path, bytes, { mode: 0o600 });
  void log("info", "node upload stored", { nodeId, filename: safeName(filename), bytes: bytes.byteLength });
  return { path, filename: safeName(filename), size: bytes.byteLength };
}

/** The kind of attachment a stored file makes: what the model sees and the app renders. */
export function nodeAttachmentOf(upload: NodeUpload): NodeAttachment {
  return {
    type: mediaTypeForPath(upload.path),
    path: upload.path,
    filename: upload.filename,
  };
}

interface Ticket {
  path: string;
  nodeId: string;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

/** Hands the node a URL to fetch a file of this server's, once. */
export function openFileTicket(nodeId: string, path: string): { id: string; url: string } {
  const id = randomBytes(16).toString("hex");
  tickets.set(id, { path, nodeId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { id, url: `/node/file/${id}` };
}

/** The path behind a ticket this node may redeem, or why it cannot. One-shot by design. */
export function takeFileTicket(id: string, nodeId: string): { ok: true; path: string } | { ok: false; error: string } {
  const ticket = tickets.get(id);
  if (!ticket) return { ok: false, error: "unknown ticket" };
  if (ticket.expiresAt < Date.now()) {
    tickets.delete(id);
    return { ok: false, error: "ticket expired" };
  }
  // Only its own node burns it: a guess from anywhere else must not cost the one the file is for.
  if (ticket.nodeId !== nodeId) return { ok: false, error: "ticket belongs to another node" };
  tickets.delete(id);
  return { ok: true, path: ticket.path };
}

/** Module state, reset between test files. */
export function resetNodeFiles(): void {
  tickets.clear();
}
