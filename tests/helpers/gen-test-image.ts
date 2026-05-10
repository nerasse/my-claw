import { writeFile } from "node:fs/promises";

/**
 * Generate a minimal PPM image file.
 * PPM format is universally supported and requires no external tools.
 */
export async function genPpmImage(
  path: string,
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<void> {
  const header = `P6\n${width} ${height}\n255\n`;
  const pixel = Buffer.from([color.r, color.g, color.b]);
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixel.copy(data, i * 3);
  }
  await writeFile(path, Buffer.concat([Buffer.from(header), data]));
}
