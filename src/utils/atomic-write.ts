import { open, mkdir, rename, unlink } from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

// A fixed `${path}.tmp` name lets two concurrent writers interleave (the second renames a file the
// first already moved). A unique per-write name keeps them independent. fsync before rename makes
// the payload durable, so a crash between write and rename cannot leave a zero-length target.
function tmpNameFor(path: string): string {
  return `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
}

export interface AtomicWriteOptions {
  /** File mode for the target (e.g. 0o600 for secrets). */
  mode?: number;
}

export async function writeFileAtomically(path: string, content: string | Uint8Array, options?: AtomicWriteOptions): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tmpNameFor(path);
  const handle = await open(tmp, "w", options?.mode ?? 0o644);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // A write that failed leaves no temporary behind: nothing else would ever remove it.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function writeJsonFileAtomically(path: string, value: unknown, pretty = false): Promise<void> {
  await writeFileAtomically(path, JSON.stringify(value, null, pretty ? 2 : undefined));
}

export function writeFileAtomicallySync(path: string, content: string, options?: AtomicWriteOptions): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpNameFor(path);
  const fd = openSync(tmp, "w", options?.mode ?? 0o644);
  try {
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw err;
  }
}

export function writeJsonFileAtomicallySync(path: string, value: unknown, pretty = false): void {
  writeFileAtomicallySync(path, JSON.stringify(value, null, pretty ? 2 : undefined));
}
