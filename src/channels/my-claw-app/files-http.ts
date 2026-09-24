import { mkdir, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { extractVideoThumbnail } from "../../media/video.ts";
import { kindByName, mimeTypeForName, type FileKind } from "../../utils/file-kind.ts";
import { listZipEntries } from "../../utils/archive.ts";
import { extractOfficeText } from "../../utils/office-text.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { thumbPathFor, type SessionFileStore } from "./files.ts";
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

export async function serveMedia(d: MyClawAppFilesDeps, id: string, owner: string | undefined, thumb: boolean, rangeHeader: string | null = null, view: string | null = null): Promise<Response> {
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

  // What the app cannot decode travels as something it can: the text of a document, or the entry
  // list of an archive (docs/file-preview.md). Both are read out of the bytes here, and neither
  // ever rewrites the file -- Download still hands over the document itself.
  if (view === "text") {
    const text = await extractOfficeText(path);
    if (text === null) return new Response("Not Found", { status: 404 });
    return new Response(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (view === "list") {
    const entries = await listZipEntries(path);
    if (entries.length === 0) return new Response("Not Found", { status: 404 });
    return Response.json(
      { entries: entries.slice(0, ARCHIVE_ENTRY_LIMIT).map((entry) => ({ name: entry.name, size: entry.size })) },
      { headers: { "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" } },
    );
  }

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
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    // The PDF page is loaded by the app's WebView from a local asset, so its origin is `null` and
    // its own fetch of the document is cross-origin (docs/file-preview.md). The credential is the
    // token in the query either way, so opening the read to any origin grants nothing: without it
    // a page that does not know the URL gets the same 401 it would from any other caller.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
  // What the app renders travels inline, so a WebView or an <img> reads a document and not a
  // download; what it saves -- an archive, an Office file, an unknown binary -- stays an
  // attachment (docs/file-preview.md). A page or a drawing served inline must run nothing,
  // whatever opens it: the app's own preview turns JavaScript off, this is the fence for every
  // other reader of the same URL.
  const rendered = RENDERED_INLINE.test(mimeType);
  if (filename) {
    headers["Content-Disposition"] = `${rendered ? "inline" : "attachment"}; filename="${filename.replace(/["\\]/g, "")}"`;
  } else if (rendered) {
    headers["Content-Disposition"] = "inline";
  }
  if (mimeType === "text/html" || mimeType === "image/svg+xml" || mimeType === "application/xhtml+xml") {
    headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  }

  const file = Bun.file(path);
  const size = file.size;
  const range = parseRange(rangeHeader, size);
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(file, { headers });
}

/** A listing is for reading, not for walking a filesystem: past this the answer is a download. */
const ARCHIVE_ENTRY_LIMIT = 2000;

/** The families the app shows rather than saves. Everything else is a download. */
const RENDERED_INLINE = /^(image|audio|video|text)\//;

/**
 * A single byte range, which is all pdf.js and a video seek ever ask for. A malformed or
 * unsatisfiable one answers the whole file, which is what every reader tolerates.
 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
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

/**
 * An HTTP header value is ISO-8859-1, so the name travels percent-encoded: OkHttp refuses a
 * header outside that range outright, and the browser would hand over mojibake. Both clients
 * encode, and this is the only place that undoes it -- without it `resume.pdf` with accents was
 * stored, listed and downloaded as `r%C3%A9sum%C3%A9.pdf`. A value that is not valid encoding
 * (a literal percent in the name) is kept as typed rather than dropped.
 */
function decodeUploadName(raw: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "attachment";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function handleUpload(d: MyClawAppFilesDeps, owner: string, req: Request): Promise<Response> {
  const threadId = req.headers.get("x-thread-id")?.trim() || "default";
  const safeThread = sanitizeThreadId(threadId);
  const filename = decodeUploadName(req.headers.get("x-filename"));
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
    return Response.json({ id: file.id, kind: file.kind, type: type || file.type, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes });
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
export function registerMedia(d: MyClawAppFilesDeps, path: string, meta: { type: "image" | "audio" | "video" | "file"; kind?: FileKind } & Omit<MediaEntry, "path" | "type">, id: string = crypto.randomUUID()): MyClawAppAttachmentMeta | undefined {
  d.media.set(id, { path, ...meta });
  d.mediaOrder.push(id);
  if (d.mediaOrder.length > MAX_MEDIA_ENTRIES) {
    const oldest = d.mediaOrder.shift();
    if (oldest) d.media.delete(oldest);
  }
  return {
    id,
    kind: meta.kind ?? kindByName(path),
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

/** Serving reuses the one table: two lists drifted apart once, and .opus was the casualty. */
function mimeTypeForPath(path: string): string | undefined {
  return mimeTypeForName(path);
}
