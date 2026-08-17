import { mkdir, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { extractVideoThumbnail } from "../../media/video.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { MIME_BY_EXTENSION, thumbPathFor, type SessionFileStore } from "./files.ts";
import { sanitizeThreadId } from "./sessions.ts";
import type { MyClawAppSkillsController } from "./controllers.ts";
import type { MyClawAppAttachmentMeta, MyClawAppAttachmentRef } from "./types.ts";

/**
 * What the HTTP surface needs from the adapter: the session store the bytes live in, plus the
 * three look-aside caches, passed by reference so a hit registered on one request is seen by
 * the next one.
 */
export interface MyClawAppFilesDeps {
  readonly skills?: MyClawAppSkillsController;
  readonly files: SessionFileStore;
  readonly media: Map<string, MediaEntry>;
  readonly mediaOrder: string[];
  readonly thumbnails: Map<string, Promise<string | undefined>>;
}

// A look-aside cache of recently served media; the bytes themselves live in the session store
// (uploads) or were copied there on send, so evicting an entry here only drops the fast path.
const MAX_MEDIA_ENTRIES = 1000;

export interface MediaEntry {
  path: string;
  type: "image" | "audio" | "video" | "file";
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  audioAsVoice?: boolean;
}

export async function serveSkill(d: MyClawAppFilesDeps, source: string, name: string, workspace?: string): Promise<Response> {
  if (!d.skills) return new Response("Skill catalog unavailable", { status: 503 });
  if (source !== "built-in" && source !== "custom" && source !== "workspace") {
    return new Response("Bad Request", { status: 400 });
  }
  // First fence: the name only ever feeds the controller, and the controller re-checks the
  // resolved path against the tier root, but a name that could smuggle path segments has no
  // legitimate use and is refused before anything touches the filesystem. The workspace key
  // is a config key, never a path, and is held to the same charset.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return new Response("Bad Request", { status: 400 });
  }
  if (workspace !== undefined && !/^[A-Za-z0-9._-]+$/.test(workspace)) {
    return new Response("Bad Request", { status: 400 });
  }
  const content = await d.skills.read(source, name, workspace);
  if (content === null) return new Response("Not Found", { status: 404 });
  return new Response(content, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

export async function serveMedia(d: MyClawAppFilesDeps, id: string, owner: string | undefined, thumb: boolean): Promise<Response> {
  let path: string | undefined;
  let mimeType = "application/octet-stream";
  let filename: string | undefined;
  const entry = d.media.get(id);
  if (entry) {
    path = entry.path;
    mimeType = entry.mimeType ?? mimeTypeForPath(path) ?? "application/octet-stream";
    filename = entry.filename;
  } else if (owner) {
    const found = await d.files.readById(owner, id);
    if (found) {
      path = found.path;
      mimeType = found.file.mimeType;
      filename = found.file.filename;
    }
  }
  if (!path) return new Response("Not Found", { status: 404 });

  if (thumb) {
    if (!mimeType.startsWith("video/")) return new Response("Not Found", { status: 404 });
    const generated = await thumbnailFor(d, owner ?? "", id, path);
    if (!generated) {
      await myClawAppLog("warn", "video thumbnail unavailable", { owner, id });
      return new Response("Not Found", { status: 404 });
    }
    path = generated;
    mimeType = "image/jpeg";
    filename = undefined;
  }

  const headers: Record<string, string> = {
    "Content-Type": mimeType,
  };
  if (filename) {
    headers["Content-Disposition"] = `attachment; filename="${filename.replace(/["\\]/g, "")}"`;
  }
  return new Response(Bun.file(path), { headers });
}

export function thumbnailFor(d: MyClawAppFilesDeps, owner: string, id: string, videoPath: string): Promise<string | undefined> {
  const target = thumbPathFor(owner, id);
  const inflight = d.thumbnails.get(target);
  if (inflight) return inflight;
  const pending = (async (): Promise<string | undefined> => {
    try {
      await stat(target);
      return target;
    } catch {
      // not cached yet: generate
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await extractVideoThumbnail(videoPath, target);
      return target;
    } catch {
      return undefined;
    }
  })();
  d.thumbnails.set(target, pending);
  void pending.then(() => d.thumbnails.delete(target));
  return pending;
}

export async function handleUpload(d: MyClawAppFilesDeps, owner: string, req: Request): Promise<Response> {
  const threadId = req.headers.get("x-thread-id")?.trim() || "default";
  const safeThread = sanitizeThreadId(threadId);
  const filename = (req.headers.get("x-filename") ?? "attachment").trim();
  const type = (req.headers.get("x-type") ?? "file").trim() as MyClawAppAttachmentRef["type"];
  if (!safeThread) {
    await myClawAppLog("warn", "upload rejected: bad threadId", { owner, threadId });
    return new Response("Bad threadId", { status: 400 });
  }
  // No size cap on this channel: uploads and agent attachments are streamed/copied to disk
  // as-is. A payload past the warning threshold is logged and stored anyway.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > d.files.warnSizeBytes) {
    await myClawAppLog("warn", "large upload", { owner, threadId: safeThread, declared, threshold: d.files.warnSizeBytes });
  }
  try {
    const file = await d.files.saveStream(owner, safeThread, filename, req.body);
    await myClawAppLog("info", "file uploaded", { owner, threadId: safeThread, id: file.id, size: file.sizeBytes, type });
    return Response.json({ id: file.id, type: type || file.type, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Upload failed";
    await myClawAppLog("warn", "upload failed", { owner, threadId: safeThread, filename, reason });
    return new Response(reason, { status: 400 });
  }
}

/**
 * Registers media for serving. `id` is the session-store file id when the bytes were copied
 * into the store (agent attachments), so the look-aside cache and the persistent file agree:
 * an evicted cache entry still resolves through the store, and files.delete matches.
 */
export function registerMedia(d: MyClawAppFilesDeps, path: string, meta: { type: "image" | "audio" | "video" | "file" } & Omit<MediaEntry, "path" | "type">, id: string = crypto.randomUUID()): MyClawAppAttachmentMeta | undefined {
  d.media.set(id, { path, ...meta });
  d.mediaOrder.push(id);
  if (d.mediaOrder.length > MAX_MEDIA_ENTRIES) {
    const oldest = d.mediaOrder.shift();
    if (oldest) d.media.delete(oldest);
  }
  return {
    id,
    type: meta.type,
    mimeType: meta.mimeType ?? mimeTypeForPath(path),
    filename: meta.filename,
    sizeBytes: meta.sizeBytes,
    width: meta.width,
    height: meta.height,
    durationMs: meta.durationMs,
    audioAsVoice: meta.audioAsVoice,
  };
}

/** Serving reuses the store's table: two lists drifted apart once, and .opus was the casualty. */
function mimeTypeForPath(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).slice(1).toLowerCase()];
}
