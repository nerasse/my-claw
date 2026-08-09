import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExtractVideoFramesOptions {
  fps?: number;
  maxFrames?: number;
  maxWidth?: number;
}

export async function extractVideoFrames(
  videoPath: string,
  options?: ExtractVideoFramesOptions,
): Promise<string[]> {
  const fps = options?.fps ?? 1 / 3; // 1 frame every 3 seconds
  const maxFrames = options?.maxFrames ?? 20;
  const maxWidth = options?.maxWidth ?? 1920;

  const tmpDir = await mkdtemp(join(tmpdir(), "video-frames-"));
  const outputPattern = join(tmpDir, "frame_%03d.jpg");

  try {
    await execFileAsync("ffmpeg", [
      "-i", videoPath,
      "-vf", `fps=${fps},scale=${maxWidth}:-1:flags=lanczos`,
      "-frames:v", String(maxFrames),
      "-q:v", "2",
      outputPattern,
    ]);

    const entries = await readdir(tmpDir);
    const frames = entries
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => join(tmpDir, f));

    return frames;
  } catch (err) {
    throw new Error(`Video frame extraction failed: ${err}`);
  }
}

const THUMB_SCALE = "scale=480:-2:flags=lanczos";

/**
 * Extracts a single preview frame into `outPath`. Seek starts 1 second in, away from the
 * opening black frame; a clip too short to reach it yields nothing, and falls back to 0.
 */
export async function extractVideoThumbnail(videoPath: string, outPath: string): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-ss", "1", "-i", videoPath,
      "-vframes", "1", "-q:v", "4", "-vf", THUMB_SCALE,
      outPath,
    ]);
    await stat(outPath);
  } catch {
    try {
      await execFileAsync("ffmpeg", [
        "-i", videoPath,
        "-vframes", "1", "-q:v", "4", "-vf", THUMB_SCALE,
        outPath,
      ]);
      await stat(outPath);
    } catch (err) {
      throw new Error(`Video thumbnail extraction failed: ${err}`);
    }
  }
}
