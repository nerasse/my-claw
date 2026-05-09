import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { imageToBase64 } from "../../src/media/image.ts";
import { writeFile, unlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

let smallImagePath: string;
let largeImagePath: string;
let tmpDir: string;

describe("imageToBase64", () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "media-test-"));
    smallImagePath = join(tmpDir, "small.jpg");
    largeImagePath = join(tmpDir, "large.jpg");

    // 1x1 red JPEG (tiny, no resize needed)
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "color=c=red:s=1x1",
      "-q:v", "5",
      "-frames:v", "1",
      smallImagePath,
    ]);

    // 4000x4000 red JPEG (large, triggers resize if maxBytes low)
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "color=c=red:s=4000x4000",
      "-q:v", "1",
      "-frames:v", "1",
      largeImagePath,
    ]);
  });

  afterAll(async () => {
    await unlink(smallImagePath).catch(() => {});
    await unlink(largeImagePath).catch(() => {});
  });

  test("returns base64 data URL for small image without resize", async () => {
    const result = await imageToBase64(smallImagePath);

    expect(result.wasResized).toBe(false);
    expect(result.dataUrl).toStartWith("data:image/jpeg;base64,");
    const base64Part = result.dataUrl.split(",")[1];
    expect(base64Part!.length).toBeGreaterThan(0);
  });

  test("resizes image when file exceeds maxBytes", async () => {
    const largeStat = await stat(largeImagePath);
    expect(largeStat.size).toBeGreaterThan(50000); // > 50KB

    const result = await imageToBase64(largeImagePath, { maxBytes: 50000 });

    expect(result.wasResized).toBe(true);
    expect(result.dataUrl).toStartWith("data:image/jpeg;base64,");
  });

  test("throws for nonexistent file", async () => {
    await expect(imageToBase64("/tmp/nonexistent-image-12345.jpg")).rejects.toThrow();
  });

  test("infers PNG mime type from extension", async () => {
    const pngPath = join(tmpDir, "test.png");
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "color=c=blue:s=2x2",
      "-frames:v", "1",
      pngPath,
    ]);

    try {
      const result = await imageToBase64(pngPath);
      expect(result.dataUrl).toStartWith("data:image/png;base64,");
    } finally {
      await unlink(pngPath).catch(() => {});
    }
  });
});
