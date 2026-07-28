import { readFile, readdir, mkdir, copyFile, rm, access, rename } from "node:fs/promises";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

interface ManifestEntry {
  name: string;
  hash: string;
}

interface Manifest {
  entries: ManifestEntry[];
  syncedAt: string;
}

async function dirHash(dirPath: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? dirPath, e.name))
    .sort();
  for (const filePath of files) {
    const data = await readFile(filePath);
    hash.update(filePath.slice(dirPath.length));
    hash.update(data);
  }
  return hash.digest("hex");
}

async function scanRepoSkills(repoDir: string): Promise<Map<string, { path: string; hash: string }>> {
  const out = new Map<string, { path: string; hash: string }>();
  try {
    await access(repoDir);
  } catch {
    return out;
  }

  const entries = await readdir(repoDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(repoDir, entry.name, "SKILL.md");
    try {
      await access(skillFile);
      const hash = await dirHash(join(repoDir, entry.name));
      out.set(entry.name, { path: skillFile, hash });
    } catch {
      // skip
    }
  }

  return out;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

async function readManifest(builtinDir: string): Promise<Manifest | null> {
  const path = join(builtinDir, "manifest.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

async function writeManifest(builtinDir: string, entries: ManifestEntry[]): Promise<void> {
  const manifest: Manifest = {
    entries,
    syncedAt: new Date().toISOString(),
  };
  await writeFileAtomically(join(builtinDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

export async function syncBuiltIn(repoDir: string, builtinDir: string): Promise<string[]> {
  await mkdir(builtinDir, { recursive: true });

  const repoSkills = await scanRepoSkills(repoDir);
  const manifest = await readManifest(builtinDir);
  const currentEntries = new Map(manifest?.entries.map((e) => [e.name, e]) ?? []);

  const changed: string[] = [];
  const newEntries: ManifestEntry[] = [];

  for (const [name, { path, hash }] of repoSkills) {
    const existing = currentEntries.get(name);
    if (!existing || existing.hash !== hash) {
      const srcDir = dirname(path);
      const destDir = join(builtinDir, name);
      const tmpDir = destDir + ".tmp-" + Date.now();
      await copyDirRecursive(srcDir, tmpDir);
      await rm(destDir, { recursive: true, force: true });
      try {
        await rename(tmpDir, destDir);
      } catch {
        await rm(destDir, { recursive: true, force: true });
        await copyDirRecursive(tmpDir, destDir);
        await rm(tmpDir, { recursive: true, force: true });
      }
      changed.push(name);
    }
    newEntries.push({ name, hash });
  }

  for (const [name] of currentEntries) {
    if (!repoSkills.has(name)) {
      const destDir = join(builtinDir, name);
      try {
        await rm(destDir, { recursive: true, force: true });
      } catch {
        // may not exist
      }
      changed.push(name);
    }
  }

  await writeManifest(builtinDir, newEntries);
  return changed;
}
