import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../core/config.ts";

/**
 * Attachments live next to their session, one directory per thread:
 *   $MY_CLAW_DIR/files/my-claw-app/<owner>/<threadId>/<id>__<filename>
 * The layout mirrors the session id 1:1, so archiving or deleting a conversation removes its
 * files with it, and the disk usage of a session is the size of its directory. The uploader's
 * name is carried by the entry itself: a listing needs one readdir and no sidecar to stay in
 * sync with. Entries written before that (plain `<id>.<ext>`) still list, under their id.
 * Uploads from the app and files the agent sends (MEDIA: refs and programmatic attachments)
 * land here the same way: the channel keeps no quota, only a warning above warnSizeBytes.
 */

export interface SessionFile {
  id: string;
  /** Name the device uploaded, normalised. Shown in the app and given to the agent. */
  filename: string;
  /** Entry on disk, `<id>__<filename>`. Only the store should need it. */
  storedName: string;
  type: "image" | "audio" | "video" | "file";
  mimeType: string;
  sizeBytes: number;
  ts: string;
}

const UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(.+)$/;

/** `<id>__<name>` splits on the first separator only, so a name may contain `__` itself. */
export function parseStoredName(entry: string): { id: string; filename: string } | null {
  const match = UUID.exec(entry);
  if (match) return { id: match[1]!, filename: match[2]! };
  const dot = entry.indexOf(".");
  if (dot <= 0) return null;
  return { id: entry.slice(0, dot), filename: entry };
}

const DEFAULT_WARN_SIZE = 50 * 1024 * 1024;

const TYPE_BY_MIME: Record<string, SessionFile["type"]> = {
  "image/": "image",
  "audio/": "audio",
  "video/": "video",
};

export function filesDirFor(owner: string, threadId: string): string {
  return join(MY_CLAW_DIR, "files", "my-claw-app", owner, threadId);
}

export function filePathFor(owner: string, threadId: string, storedName: string): string {
  return join(filesDirFor(owner, threadId), storedName);
}

/** The directory of the owning session, so archive/delete can clean it up. */
export function filesRootForOwner(owner: string): string {
  return join(MY_CLAW_DIR, "files", "my-claw-app", owner);
}

/**
 * Generated video previews live apart from the listing: a thumb in the thread directory
 * would parse as a file of its own (`<id>__name.thumb.jpg`) and show up twice in the
 * explorer. Keyed by owner only, since videos resolve across threads.
 */
export function thumbPathFor(owner: string, id: string): string {
  return join(MY_CLAW_DIR, "files", "my-claw-app", ".thumbs", owner, `${id}.jpg`);
}

/**
 * The only extension table of the channel. An entry missing here does not degrade to a generic
 * download: `typeFor` reads the type back out of the mime, so an unlisted audio extension is
 * stored as type "file", and the STT pass -- which only looks at type "audio" -- never sees it.
 * A voice note would reach the agent as a path instead of as words.
 */
export const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  oga: "audio/ogg", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", amr: "audio/amr", weba: "audio/webm",
  zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeFor(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).slice(1).toLowerCase()] ?? "application/octet-stream";
}

export class SessionFileStore {
  constructor(private config?: MyClawAppChannelConfig) {}

  /** Attachments above this size are logged with a warning and stored anyway. */
  get warnSizeBytes(): number {
    return this.config?.files?.warnSizeBytes ?? DEFAULT_WARN_SIZE;
  }

  private async listThreadDirs(owner: string): Promise<string[]> {
    try {
      return await readdir(join(MY_CLAW_DIR, "files", "my-claw-app", owner));
    } catch {
      return [];
    }
  }

  private async listInThread(threadDir: string): Promise<SessionFile[]> {
    try {
      const names = await readdir(threadDir);
      const files: SessionFile[] = [];
      for (const name of names) {
        const parsed = parseStoredName(name);
        if (!parsed) continue;
        const { id, filename } = parsed;
        try {
          const info = await stat(join(threadDir, name));
          if (!info.isFile()) continue;
          files.push({
            id,
            filename,
            storedName: name,
            type: typeFor(filename),
            mimeType: mimeTypeFor(filename),
            sizeBytes: info.size,
            ts: info.mtime.toISOString(),
          });
        } catch {
          // File deleted between readdir and stat: skip.
        }
      }
      return files.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    } catch {
      return [];
    }
  }

  async list(owner: string, threadId: string): Promise<SessionFile[]> {
    const dir = filesDirFor(owner, threadId);
    return this.listInThread(dir);
  }

  /** Total size of one conversation's attachments, computed on demand. */
  async sessionSizeBytes(owner: string, threadId: string): Promise<number> {
    const files = await this.list(owner, threadId);
    return files.reduce((sum, file) => sum + file.sizeBytes, 0);
  }

  async findById(owner: string, threadId: string, id: string): Promise<SessionFile | null> {
    const files = await this.list(owner, threadId);
    return files.find((file) => file.id === id) ?? null;
  }

  async save(owner: string, threadId: string, filename: string, bytes: Uint8Array): Promise<SessionFile> {
    return this.writeEntry(owner, threadId, filename, bytes.byteLength, (target) => writeFile(target, bytes));
  }

  /**
   * Copies an existing file -- an attachment the agent generated -- into the store without
   * buffering it through JS. Every send creates a fresh copy, so a regenerated file replaces
   * the previous one in the conversation rather than being deduplicated away.
   */
  async saveFromPath(owner: string, threadId: string, sourcePath: string, filename?: string): Promise<SessionFile> {
    const info = await stat(sourcePath);
    const name = filename ?? basename(sourcePath);
    return this.writeEntry(owner, threadId, name, info.size, (target) => copyFile(sourcePath, target));
  }

  /** Streams an upload body straight to disk; a multi-GB file never sits in memory. */
  async saveStream(owner: string, threadId: string, filename: string, body: ReadableStream | null): Promise<SessionFile> {
    const ext = extname(filename).slice(1).toLowerCase();
    const safeName = basename(filename).replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || `attachment.${ext || "bin"}`;
    const id = randomUUID();
    const dir = filesDirFor(owner, threadId);
    await mkdir(dir, { recursive: true });
    const storedName = `${id}__${safeName}`;
    const target = filePathFor(owner, threadId, storedName);
    try {
      if (!body) throw new Error("empty upload body");
      await pipeline(Readable.fromWeb(body), createWriteStream(target));
      const info = await stat(target);
      return {
        id,
        filename: safeName,
        storedName,
        type: typeFor(safeName),
        mimeType: mimeTypeFor(safeName),
        sizeBytes: info.size,
        ts: new Date().toISOString(),
      };
    } catch (err) {
      await rm(target, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async writeEntry(
    owner: string,
    threadId: string,
    filename: string,
    sizeBytes: number,
    write: (target: string) => Promise<void>,
  ): Promise<SessionFile> {
    const ext = extname(filename).slice(1).toLowerCase();
    const safeName = basename(filename).replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || `attachment.${ext || "bin"}`;
    const id = randomUUID();
    const dir = filesDirFor(owner, threadId);
    await mkdir(dir, { recursive: true });
    const storedName = `${id}__${safeName}`;
    await write(filePathFor(owner, threadId, storedName));
    return {
      id,
      filename: safeName,
      storedName,
      type: typeFor(safeName),
      mimeType: mimeTypeFor(safeName),
      sizeBytes,
      ts: new Date().toISOString(),
    };
  }

  async read(owner: string, threadId: string, id: string): Promise<{ path: string; file: SessionFile } | null> {
    const file = await this.findById(owner, threadId, id);
    if (!file) return null;
    return { path: filePathFor(owner, threadId, file.storedName), file };
  }

  async remove(owner: string, threadId: string, id: string): Promise<boolean> {
    const file = await this.findById(owner, threadId, id);
    if (!file) return false;
    await rm(filePathFor(owner, threadId, file.storedName), { force: true });
    await rm(thumbPathFor(owner, id), { force: true }).catch(() => {});
    return true;
  }

  /** Archive/delete of a session must take its files with it. */
  async removeSessionFiles(owner: string, threadId: string): Promise<void> {
    await rm(filesDirFor(owner, threadId), { recursive: true, force: true });
    // Previews are keyed by owner only; once the last thread of that owner is gone they are
    // unreachable, so the whole thumb set goes with the session.
    const remaining = await readdir(join(MY_CLAW_DIR, "files", "my-claw-app", owner)).catch(() => []);
    if (remaining.length === 0) {
      await rm(join(MY_CLAW_DIR, "files", "my-claw-app", ".thumbs", owner), { recursive: true, force: true });
    }
  }

  async readById(owner: string, id: string): Promise<{ path: string; file: SessionFile } | null> {
    const roots = await this.listThreadDirs(owner);
    for (const threadId of roots) {
      const found = await this.read(owner, threadId, id);
      if (found) return found;
    }
    return null;
  }
}

function typeFor(filename: string): SessionFile["type"] {
  const mime = mimeTypeFor(filename);
  for (const [prefix, type] of Object.entries(TYPE_BY_MIME)) {
    if (mime.startsWith(prefix)) return type;
  }
  return "file";
}
