import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../core/config.ts";

/**
 * Uploaded attachments live next to their session, one directory per thread:
 *   $MY_CLAW_DIR/files/my-claw-app/<owner>/<threadId>/<id>.<ext>
 * The layout mirrors the session id 1:1, so archiving or deleting a conversation removes its
 * files with it, and the disk usage of a session is the size of its directory.
 */

export interface SessionFile {
  id: string;
  filename: string;
  type: "image" | "audio" | "video" | "file";
  mimeType: string;
  sizeBytes: number;
  ts: string;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 2 * 1024 * 1024 * 1024;

const TYPE_BY_MIME: Record<string, SessionFile["type"]> = {
  "image/": "image",
  "audio/": "audio",
  "video/": "video",
};

export function filesDirFor(owner: string, threadId: string): string {
  return join(MY_CLAW_DIR, "files", "my-claw-app", owner, threadId);
}

export function filePathFor(owner: string, threadId: string, id: string, ext: string): string {
  return join(filesDirFor(owner, threadId), `${id}.${ext}`);
}

/** The directory of the owning session, so archive/delete can clean it up. */
export function filesRootForOwner(owner: string): string {
  return join(MY_CLAW_DIR, "files", "my-claw-app", owner);
}

function mimeTypeFor(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase();
  const known: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
    zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return known[ext] ?? "application/octet-stream";
}

export class SessionFileStore {
  constructor(private config?: MyClawAppChannelConfig) {}

  /** Largest single upload accepted, for the HTTP pre-check. */
  get maxSizeBytes(): number {
    return this.config?.files?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  }

  private get maxTotalBytes(): number {
    return this.config?.files?.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  }

  private allowedExtensions(): Set<string> | null {
    const list = this.config?.files?.allowedExtensions;
    return list && list.length > 0 ? new Set(list.map((ext) => ext.toLowerCase().replace(/^\./, ""))) : null;
  }

  private async totalBytes(): Promise<number> {
    let total = 0;
    for (const deviceDir of await this.listRoots()) {
      for (const threadDir of await this.listThreadDirs(deviceDir)) {
        for (const file of await this.listInThread(threadDir)) {
          total += file.sizeBytes;
        }
      }
    }
    return total;
  }

  private async listRoots(): Promise<string[]> {
    try {
      return await readdir(join(MY_CLAW_DIR, "files", "my-claw-app"));
    } catch {
      return [];
    }
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
        const [id, ...rest] = name.split(".");
        if (!id || rest.length === 0) continue;
        try {
          const info = await stat(join(threadDir, name));
          if (!info.isFile()) continue;
          const filename = name;
          files.push({
            id,
            filename,
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
    const ext = extname(filename).slice(1).toLowerCase();
    const allowed = this.allowedExtensions();
    if (allowed && (!ext || !allowed.has(ext))) {
      throw new Error(`File type .${ext || "?"} not allowed.`);
    }
    if (bytes.byteLength > this.maxSizeBytes) {
      throw new Error(`File too large: ${bytes.byteLength} bytes (max ${this.maxSizeBytes}).`);
    }
    if (bytes.byteLength + (await this.totalBytes()) > this.maxTotalBytes) {
      throw new Error("Attachment storage full.");
    }

    const safeName = basename(filename).replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || "attachment";
    const id = randomUUID();
    const dir = filesDirFor(owner, threadId);
    await mkdir(dir, { recursive: true });
    const path = filePathFor(owner, threadId, id, ext || "bin");
    await writeFile(path, bytes);
    return { id, filename: safeName, type: typeFor(safeName), mimeType: mimeTypeFor(safeName), sizeBytes: bytes.byteLength, ts: new Date().toISOString() };
  }

  async read(owner: string, threadId: string, id: string): Promise<{ path: string; file: SessionFile } | null> {
    const file = await this.findById(owner, threadId, id);
    if (!file) return null;
    return { path: join(filesDirFor(owner, threadId), file.filename), file };
  }

  async remove(owner: string, threadId: string, id: string): Promise<boolean> {
    const file = await this.findById(owner, threadId, id);
    if (!file) return false;
    await rm(join(filesDirFor(owner, threadId), file.filename), { force: true });
    return true;
  }

  /** Archive/delete of a session must take its files with it. */
  async removeSessionFiles(owner: string, threadId: string): Promise<void> {
    await rm(filesDirFor(owner, threadId), { recursive: true, force: true });
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
