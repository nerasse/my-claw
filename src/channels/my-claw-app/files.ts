import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../core/config.ts";
import {
  kindByName,
  mediaTypeForKind,
  mimeTypeForName,
  sniffKind,
  type FileKind,
  type FileKindVerdict,
} from "../../utils/file-kind.ts";

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
  /** What the file is, finely -- docs/file-preview.md. The reader picks its viewer from this. */
  kind: FileKind;
  /** The coarse word the wire protocol carries, derived from `kind` (mediaTypeForKind). */
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

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/** Enough of a file to recognise it: every signature lives in the first few hundred bytes. */
const SAMPLE_BYTES = 4096;

async function readSample(path: string): Promise<Uint8Array> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = new Uint8Array(SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return new Uint8Array();
  }
}

/**
 * The name first, the bytes only when the name settles nothing (`kindByName` returning nothing is
 * exactly that, docs/file-preview.md). The name is right for everything ordinary and costs no
 * read; a file with no extension, or one nobody knows, is the only one opened to be classified.
 * Reading every write instead would reclassify a text file named `.png` -- and would also cost a
 * read on every attachment, for a case that does not happen.
 */
async function verdictOf(filename: string, path: string): Promise<FileKindVerdict> {
  const byName = kindByName(filename);
  if (byName !== undefined) return { kind: byName, mimeType: mimeTypeForName(filename) };
  return sniffKind(await readSample(path), filename);
}

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
          const path = join(threadDir, name);
          const info = await stat(path);
          if (!info.isFile()) continue;
          const verdict = await verdictOf(filename, path);
          files.push({
            id,
            filename,
            storedName: name,
            kind: verdict.kind,
            type: mediaTypeForKind(verdict.kind),
            mimeType: verdict.mimeType,
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

  /**
   * Which stored ids are the same bytes under another name, within one conversation.
   *
   * A run stores what its tools produced and its answer often delivers the very same file with
   * `MEDIA:` after copying it out of the tool's scratch dir -- the voice note of 2026-09-23, drawn
   * twice in one bubble: `output.mp3` (the run's copy) and `reponse-vocale-my-claw.mp3` (the one
   * its answer named). The store keeps both, by contract: one copy per named file, so each ref
   * still pairs with its own copy by name. What must not happen is the *display* drawing one
   * content twice, so identity is settled here once and the readers dedupe on it.
   *
   * Maps every id that repeats an earlier one (the listing is newest-first) to the id that holds
   * the content. Only files of the same size can match, which keeps this to one hash per copy of a
   * size that repeats at all.
   */
  async duplicatesAmong(owner: string, threadId: string): Promise<Map<string, string>> {
    const dir = filesDirFor(owner, threadId);
    const files = await this.listInThread(dir);
    const canonical = new Map<string, string>();
    const bySize = new Map<number, Array<{ id: string; storedName: string }>>();
    for (const file of files) {
      const group = bySize.get(file.sizeBytes) ?? [];
      group.push({ id: file.id, storedName: file.storedName });
      bySize.set(file.sizeBytes, group);
    }
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const firstOf = new Map<string, string>();
      for (const file of group) {
        const digest = await hashFile(filePathFor(owner, threadId, file.storedName)).catch(() => file.id);
        const seen = firstOf.get(digest);
        if (seen) canonical.set(file.id, seen);
        else firstOf.set(digest, file.id);
      }
    }
    return canonical;
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
      const verdict = await verdictOf(safeName, target);
      return {
        id,
        filename: safeName,
        storedName,
        kind: verdict.kind,
        type: mediaTypeForKind(verdict.kind),
        mimeType: verdict.mimeType,
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
    const target = filePathFor(owner, threadId, storedName);
    await write(target);
    const verdict = await verdictOf(safeName, target);
    return {
      id,
      filename: safeName,
      storedName,
      kind: verdict.kind,
      type: mediaTypeForKind(verdict.kind),
      mimeType: verdict.mimeType,
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
