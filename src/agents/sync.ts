import { readFile, readdir, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomically } from "../utils/atomic-write.ts";

interface ManifestEntry {
  name: string;
  hash: string;
}

interface Manifest {
  entries: ManifestEntry[];
  syncedAt: string;
}

const MANIFEST = "manifest.json";

async function scanRepoAgents(repoDir: string): Promise<Map<string, { path: string; hash: string; body: string }>> {
  const out = new Map<string, { path: string; hash: string; body: string }>();
  try {
    await access(repoDir);
  } catch {
    return out;
  }

  const entries = await readdir(repoDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(repoDir, entry.name);
    const body = await readFile(path, "utf-8");
    out.set(entry.name, { path, body, hash: createHash("sha256").update(body).digest("hex") });
  }
  return out;
}

async function readManifest(builtinDir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(builtinDir, MANIFEST), "utf-8")) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Repo `src/agents/builtin/` into `$MY_CLAW_DIR/agents/.builtin/`, by content hash.
 *
 * Simpler than the skills sync because an agent is one file: no recursive copy, no temp directory
 * and no rename dance, since `writeFileAtomically` already gives the atomicity a whole directory
 * needed a rename for. Returns the names that changed.
 */
export async function syncBuiltInAgents(repoDir: string, builtinDir: string): Promise<string[]> {
  await mkdir(builtinDir, { recursive: true });

  const repoAgents = await scanRepoAgents(repoDir);
  const manifest = await readManifest(builtinDir);
  const current = new Map(manifest?.entries.map((e) => [e.name, e]) ?? []);

  const changed: string[] = [];
  const entries: ManifestEntry[] = [];

  for (const [name, { hash, body }] of repoAgents) {
    const existing = current.get(name);
    if (!existing || existing.hash !== hash) {
      await writeFileAtomically(join(builtinDir, name), body);
      changed.push(name);
    }
    entries.push({ name, hash });
  }

  // An agent dropped from the release must disappear here too, or an upgrade would leave a name
  // spawnable that the code no longer knows about.
  for (const [name] of current) {
    if (!repoAgents.has(name)) {
      await rm(join(builtinDir, name), { force: true });
      changed.push(name);
    }
  }

  const next: Manifest = { entries, syncedAt: new Date().toISOString() };
  await writeFileAtomically(join(builtinDir, MANIFEST), JSON.stringify(next, null, 2));
  return changed;
}
