/**
 * An image the phone cannot draw, drawn anyway -- docs/file-preview.md.
 *
 * The platform image view decodes what Android decodes (png, jpeg, webp, gif, heic, avif on
 * recent releases) and nothing else. A `.bmp`, a `.tiff` or a `.ico` is served through ffmpeg,
 * which is already here for the video thumbnails, and it is converted on the way out: the store
 * keeps the original bytes, and this only ever changes what a reader is handed.
 *
 * No cache: the conversion is one page of ffmpeg and these formats are rare. A cache would mean
 * another directory to invalidate when a thread is deleted, for a case that happens once a month.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The formats worth converting: what a phone's decoder does not know. */
export const EXOTIC_IMAGE_MIME = /^image\/(bmp|tiff|x-icon|vnd\.microsoft\.icon)$/i;

/** A first frame as PNG, or nothing when ffmpeg cannot read it (in which case: download). */
export async function imageToPng(sourcePath: string): Promise<Uint8Array | null> {
  const dir = await mkdtemp(join(tmpdir(), "image-png-"));
  const target = join(dir, "out.png");
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", sourcePath, "-frames:v", "1", target], { timeout: 20_000 });
    const bytes = await readFile(target);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
