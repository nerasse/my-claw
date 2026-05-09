import { readFile, writeFile, readdir, mkdir, copyFile, rm, access, stat } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { createHash } from "node:crypto";

interface ManifestEntry {
  name: string;
  hash: string;
  version?: string;
}

interface Manifest {
  entries: ManifestEntry[];
  syncedAt: string;
}

async function fileHash(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
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
      const hash = await fileHash(skillFile);
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
  await writeFile(join(builtinDir, "manifest.json"), JSON.stringify(manifest, null, 2));
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
      await rm(destDir, { recursive: true, force: true });
      await copyDirRecursive(srcDir, destDir);
      changed.push(name);
    }
    newEntries.push({ name, hash, version: undefined });
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
