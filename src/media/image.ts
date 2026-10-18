import { execFile } from "node:child_process";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Providers refuse a dimension above 8000 px; a full-page screenshot of a long page clears
 *  that while staying small in bytes, which the size rule below never saw (measured once,
 *  2026-10-18, an Anthropic 400 on a career page). */
const DEFAULT_HARD_MAX_DIMENSION = 7600;

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Magic-byte header parsing, no dependency: PNG, GIF, WEBP (VP8X) and JPEG's first SOF frame. */
export function readImageDimensions(bytes: Buffer): ImageDimensions | null {
  try {
    if (bytes.length >= 24 && bytes.toString("latin1", 1, 4) === "PNG") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.length >= 10 && bytes.toString("latin1", 0, 4) === "GIF8") {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
      if (bytes.toString("latin1", 12, 16) === "VP8X") {
        const u24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
        return { width: 1 + u24(24), height: 1 + u24(27) };
      }
      return null;
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + bytes.readUInt16BE(offset + 2);
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export interface ImageToBase64Result {
  dataUrl: string;
  wasResized: boolean;
}

export async function imageToBase64(
  path: string,
  options?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; hardMaxDimension?: number },
): Promise<ImageToBase64Result> {
  const maxWidth = options?.maxWidth ?? 2000;
  const maxHeight = options?.maxHeight ?? 2000;
  const maxBytes = options?.maxBytes ?? 2 * 1024 * 1024;
  const hardMaxDimension = options?.hardMaxDimension ?? DEFAULT_HARD_MAX_DIMENSION;

  const fileStat = await stat(path);
  const source = await readFile(path);
  const dimensions = readImageDimensions(source);
  const oversizeBytes = fileStat.size > maxBytes;
  const oversizeDimensions =
    dimensions !== null && (dimensions.width > hardMaxDimension || dimensions.height > hardMaxDimension);
  const needsResize = oversizeBytes || oversizeDimensions;

  let processedPath = path;
  let wasResized = false;
  let tmpDir: string | undefined;

  try {
    if (needsResize) {
      tmpDir = await mkdtemp(join(tmpdir(), "img-"));
      processedPath = join(tmpDir, `resized${extname(path) || ".jpg"}`);
      wasResized = true;

      // The aspect-preserving box: the byte rule keeps a normal picture small, the dimension
      // rule only has to pull the long side under the provider's ceiling.
      const box = oversizeBytes ? `${maxWidth}:${maxHeight}` : `${hardMaxDimension}:${hardMaxDimension}`;

      try {
        await execFileAsync("ffmpeg", [
          "-i", path,
          "-vf", `scale=${box}:force_original_aspect_ratio=decrease`,
          "-q:v", "2",
          processedPath,
        ]);
      } catch (err) {
        throw new Error(`Image resize failed: ${err}`);
      }
    }

    let bytes: Buffer;
    if (!needsResize) {
      bytes = source;
    } else {
      try {
        bytes = await readFile(processedPath);
      } catch (err) {
        throw new Error(`Image read failed: ${err}`);
      }
    }
    const base64 = bytes.toString("base64");
    const mimeType = inferMimeType(path);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return { dataUrl, wasResized };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
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
