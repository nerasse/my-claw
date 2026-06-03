import { writeFile, mkdir, rename } from "node:fs/promises";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export async function writeJsonFileAtomically(path: string, value: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : undefined));
  await rename(tmp, path);
}

export async function writeFileAtomically(path: string, content: string, tmpSuffix = ".tmp"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}${tmpSuffix}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export function writeJsonFileAtomicallySync(path: string, value: unknown, pretty = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : undefined));
  renameSync(tmp, path);
}
