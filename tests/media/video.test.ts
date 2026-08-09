import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { extractVideoFrames, extractVideoThumbnail } from "../../src/media/video.ts";
import { stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

let videoPath: string;
let tmpDir: string;

describe("extractVideoFrames", () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "video-test-"));
    videoPath = join(tmpDir, "test.mp4");

    // 6-second 1fps test video = 6 frames
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "testsrc=duration=6:size=320x240:rate=1",
      "-t", "6",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);
  });

  afterAll(async () => {
    await unlink(videoPath).catch(() => {});
  });

  test("extracts frames from a short video", async () => {
    const frames = await extractVideoFrames(videoPath, { fps: 1, maxFrames: 10 });

    expect(frames.length).toBeGreaterThanOrEqual(5);
    expect(frames.length).toBeLessThanOrEqual(10);

    for (const frame of frames) {
      expect(frame).toEndWith(".jpg");
      const s = await stat(frame);
      expect(s.size).toBeGreaterThan(0);
    }
  });

  test("respects maxFrames cap", async () => {
    const frames = await extractVideoFrames(videoPath, { fps: 1, maxFrames: 3 });

    expect(frames.length).toBeLessThanOrEqual(3);
  });

  test("throws for nonexistent video file", async () => {
    await expect(extractVideoFrames("/tmp/nonexistent-video-12345.mp4")).rejects.toThrow("Video frame extraction failed");
  });
});

describe("extractVideoThumbnail", () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "video-test-"));
    videoPath = join(tmpDir, "test.mp4");
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "testsrc=duration=6:size=320x240:rate=1",
      "-t", "6",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);
  });

  afterAll(async () => {
    await unlink(videoPath).catch(() => {});
  });

  test("writes a small jpeg preview", async () => {
    const out = join(tmpDir, "thumb.jpg");
    await extractVideoThumbnail(videoPath, out);
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(0);
    await unlink(out);
  });

  test("falls back to the first frame for a clip shorter than the seek point", async () => {
    const short = join(tmpDir, "short.mp4");
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "testsrc=duration=0.2:size=320x240:rate=1",
      "-t", "0.2",
      "-pix_fmt", "yuv420p",
      short,
    ]);
    const out = join(tmpDir, "short-thumb.jpg");
    await extractVideoThumbnail(short, out);
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(0);
    await unlink(out);
    await unlink(short);
  });

  test("throws for a video ffmpeg cannot read", async () => {
    const garbage = join(tmpDir, "garbage.mp4");
    await Bun.write(garbage, "not a video");
    await expect(extractVideoThumbnail(garbage, join(tmpDir, "garbage-thumb.jpg"))).rejects.toThrow(
      "Video thumbnail extraction failed",
    );
    await unlink(garbage);
  });
});
