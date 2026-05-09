import { execFile } from "node:child_process";
import { readFile, stat, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ImageToBase64Result {
  dataUrl: string;
  wasResized: boolean;
}

export async function imageToBase64(
  path: string,
  options?: { maxWidth?: number; maxHeight?: number; maxBytes?: number },
): Promise<ImageToBase64Result> {
  const maxWidth = options?.maxWidth ?? 2000;
  const maxHeight = options?.maxHeight ?? 2000;
  const maxBytes = options?.maxBytes ?? 2 * 1024 * 1024;

  const fileStat = await stat(path);
  const needsResize = fileStat.size > maxBytes;

  let processedPath = path;
  let wasResized = false;

  if (needsResize) {
    const tmpDir = await mkdtemp(join(tmpdir(), "img-"));
    processedPath = join(tmpDir, `resized${extname(path) || ".jpg"}`);
    wasResized = true;

    try {
      await execFileAsync("ffmpeg", [
        "-i", path,
        "-vf", `scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=decrease`,
        "-q:v", "2",
        processedPath,
      ]);
    } catch (err) {
      await unlink(processedPath).catch(() => {});
      throw new Error(`Image resize failed: ${err}`);
    }
  }

  try {
    const bytes = await readFile(processedPath);
    const base64 = bytes.toString("base64");
    const mimeType = inferMimeType(path);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    if (wasResized && processedPath !== path) {
      await unlink(processedPath).catch(() => {});
    }

    return { dataUrl, wasResized };
  } catch (err) {
    if (wasResized && processedPath !== path) {
      await unlink(processedPath).catch(() => {});
    }
    throw new Error(`Image read failed: ${err}`);
  }
}

function inferMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".jpg":
    case ".jpeg":
    default: return "image/jpeg";
  }
}
