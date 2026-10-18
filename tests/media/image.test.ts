import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { imageToBase64, readImageDimensions } from "../../src/media/image.ts";
import { unlink, stat, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { genPpmImage } from "../helpers/gen-test-image.ts";

const execFileAsync = promisify(execFile);

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
    // Counting img-* in the shared system tmpdir made this test fail whenever anything else
    // on the machine was resizing at the same time (two CI jobs on one runner). A private
    // TMPDIR keeps the count about this call only: mkdtemp resolves tmpdir() per call.
    const previousTmp = process.env["TMPDIR"];
    const scratch = await mkdtemp(join(tmpdir(), "img-scope-"));
    process.env["TMPDIR"] = scratch;
    try {
      const result = await imageToBase64(largeImagePath, { maxBytes: 50000 });
      expect(result.wasResized).toBe(true);
      expect((await readdir(scratch)).filter((name) => name.startsWith("img-"))).toEqual([]);
    } finally {
      if (previousTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmp;
      await rm(scratch, { recursive: true, force: true });
    }
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

  test("a small file with an oversize dimension is pulled under the provider ceiling", async () => {
    // The measured failure (2026-10-18): a full-page screenshot of a long page stays small in
    // bytes while clearing 8000 px, which the size rule never saw; the provider answered 400.
    const tallPath = join(tmpDir, "tall.png");
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x9000", "-frames:v", "1", tallPath]);
    try {
      const bytes = await readFile(tallPath);
      expect(readImageDimensions(bytes)).toEqual({ width: 64, height: 9000 });
      expect(bytes.length).toBeLessThan(2 * 1024 * 1024); // the byte rule alone would not have fired

      const result = await imageToBase64(tallPath);
      expect(result.wasResized).toBe(true);
      const out = Buffer.from(result.dataUrl.split(",")[1]!, "base64");
      const dims = readImageDimensions(out);
      expect(dims).not.toBeNull();
      expect(dims!.height).toBeLessThanOrEqual(7600);
      expect(dims!.width).toBeLessThanOrEqual(64);
    } finally {
      await unlink(tallPath).catch(() => {});
    }
  });
});

describe("readImageDimensions", () => {
  test("reads PNG, GIF and JPEG headers; unknown bytes are null", () => {
    const png = Buffer.alloc(24);
    png.write("PNG", 1, "latin1");
    png.writeUInt32BE(1200, 16);
    png.writeUInt32BE(3400, 20);
    expect(readImageDimensions(png)).toEqual({ width: 1200, height: 3400 });

    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "latin1");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(readImageDimensions(gif)).toEqual({ width: 320, height: 200 });

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(readImageDimensions(jpeg)).toEqual({ width: 1280, height: 900 });

    expect(readImageDimensions(Buffer.from("not an image at all, honestly"))).toBeNull();
    expect(readImageDimensions(Buffer.alloc(3))).toBeNull();
  });
});
