import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { imageToBase64 } from "../../src/media/image.ts";
import { unlink, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { genPpmImage } from "../helpers/gen-test-image.ts";

let smallImagePath: string;
let largeImagePath: string;
let tmpDir: string;

describe("imageToBase64", () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "media-test-"));
    smallImagePath = join(tmpDir, "small.ppm");
    largeImagePath = join(tmpDir, "large.ppm");

    // 1x1 red image (tiny, no resize needed)
    await genPpmImage(smallImagePath, 1, 1, { r: 255, g: 0, b: 0 });

    // 4000x4000 red image (large, triggers resize if maxBytes low)
    await genPpmImage(largeImagePath, 4000, 4000, { r: 255, g: 0, b: 0 });
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

  test("removes its temp dir after a resize", async () => {
    const countImgDirs = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith("img-")).length;

    const before = await countImgDirs();
    const result = await imageToBase64(largeImagePath, { maxBytes: 50000 });
    expect(result.wasResized).toBe(true);
    expect(await countImgDirs()).toBe(before);
  });

  test("infers PNG mime type from extension", async () => {
    const pngPath = join(tmpDir, "test.png");
    await genPpmImage(pngPath, 2, 2, { r: 0, g: 0, b: 255 });

    try {
      const result = await imageToBase64(pngPath);
      expect(result.dataUrl).toStartWith("data:image/png;base64,");
    } finally {
      await unlink(pngPath).catch(() => {});
    }
  });
});
