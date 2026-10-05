import { stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { briefError } from "../../utils/errors.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { mimeTypeForName } from "../../utils/file-kind.ts";
import { writeStreamAtomically } from "./fs-ops.ts";
import { zipPlan, zipStream } from "../../utils/zip-stream.ts";

/**
 * The two HTTP halves of the files page -- docs/files-page.md.
 *
 * Upload and download are requests and streams, not frames: a phone sends real bytes, and base64
 * over a WebSocket would be a tax on the connection and one frame-size limit away from a corrupt
 * file. Authentication is the adapter's, exactly as for /app-update/apk: these functions are only
 * ever reached with a device already resolved.
 */

export async function fsUpload(req: Request, device: string): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("path");
  if (!raw) return new Response("Bad Request", { status: 400 });
  const dir = resolve(raw);
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) return new Response("Not Found", { status: 404 });
  const form = await req.formData().catch(() => null);
  if (!form) return new Response("Bad Request", { status: 400 });
  const written: Array<{ name: string; size: number }> = [];
  try {
    for (const [, value] of form.entries()) {
      if (!(value instanceof File)) continue;
      const name = safeUploadName(value.name);
      const path = join(dir, name);
      const existing = await stat(path).catch(() => null);
      // The file being replaced owned a mode; a fresh upload gets the umask-safe default.
      const mode = existing ? existing.mode & 0o7777 : 0o644;
      await writeStreamAtomically(path, value.stream(), mode);
      written.push({ name, size: value.size });
      await myClawAppLog("info", "fs.upload", { path, size: value.size, device });
    }
  } catch (err) {
    await myClawAppLog("warn", "fs.upload failed", { dir, device, error: briefError(err) });
    return new Response(briefError(err), { status: 400 });
  }
  if (written.length === 0) return new Response("No files", { status: 400 });
  return Response.json({ path: dir, files: written });
}

/** The multipart name is client data: only its last segment survives, and nothing that means
 *  "somewhere else" can be written. */
function safeUploadName(raw: string): string {
  const base = basename(raw).replaceAll("\u0000", "");
  if (!base || base === "." || base === "..") return "upload";
  return base;
}

export async function fsDownload(raw: string | null): Promise<Response> {
  if (!raw) return new Response("Bad Request", { status: 400 });
  const path = resolve(raw);
  const st = await stat(path).catch(() => null);
  if (st?.isDirectory()) return folderDownload(path);
  if (!st?.isFile()) return new Response("Not Found", { status: 404 });
  const name = basename(path);
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": mimeTypeForName(name),
      "Content-Length": String(st.size),
      "Content-Disposition": contentDisposition(name),
      "Cache-Control": "no-store",
    },
  });
}

/** A folder goes down as one ZIP, written while it is sent (owner, 2026-10-05). */
async function folderDownload(path: string): Promise<Response> {
  const plan = await zipPlan(path).catch((err: unknown) => ({ refused: briefError(err) }));
  if ("refused" in plan) {
    await myClawAppLog("warn", "fs.download folder refused", { path, reason: plan.refused });
    return new Response(`this folder cannot be downloaded as a ZIP: ${plan.refused}`, { status: 413 });
  }
  return new Response(zipStream(plan.items), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${basename(path) || "folder"}.zip`),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * `attachment`, with both spellings of the name: a plain one for anything that only reads
 * `filename`, and the RFC 5987 form because a header value is ISO-8859-1 and `résumé.pdf` would
 * otherwise reach the phone as mojibake.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['*]/g, (c) => (c === "'" ? "%27" : "%2A"));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
