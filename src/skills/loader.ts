import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, SkillMeta } from "./types.ts";
import { snapshot } from "../core/config-store.ts";
import { log } from "../utils/logger.ts";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function parseFrontmatter(text: string): { meta: SkillMeta; content: string } | null {
  const match = FRONTMATTER_RE.exec(text.trimStart());
  if (!match) return null;

  const rawYaml = match[1]!;
  const content = match[2]!.trimStart();

  const meta: Record<string, unknown> = {};
  for (const line of rawYaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    meta[key] = value;
  }

  const name = meta["name"];
  const description = meta["description"];
  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  return {
    meta: {
      name: name.trim(),
      description: description.trim(),
      version: typeof meta["version"] === "string" ? meta["version"].trim() : undefined,
    },
    content,
  };
}

/** Single definition of "this text is a loadable skill", so a writer can check what a reader will
 *  accept instead of re-implementing the frontmatter rules. */
export function parsesAsSkill(text: string): boolean {
  return parseFrontmatter(text) !== null;
}

/** Last version of each SKILL.md that parsed. A reload rebuilds the registry wholesale, so without
 *  this a skill edited into a broken frontmatter just vanishes from `/skills` with no explanation. */
const lastGood = new Map<string, Skill>();

/** Only needed by tests: skill paths repeat across files and a kept version would leak. */
export function resetSkillLastGood(): void {
  lastGood.clear();
}

async function loadSkillFromFile(path: string, source: Skill["source"]): Promise<Skill | null> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    // Gone, not broken: forget it so a deleted skill really disappears.
    lastGood.delete(path);
    return null;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    const kept = lastGood.get(path);
    void log("warn", kept ? "SKILL.md no longer parses, keeping the last good version" : "SKILL.md does not parse", { path });
    return kept ?? null;
  }
  const skill: Skill = { meta: parsed.meta, content: parsed.content, path, source };
  lastGood.set(path, skill);
  // Built-ins are resynced from the repo by hash at every boot, so snapshotting them would archive
  // a copy of the release on each upgrade and churn the store for something already versioned here.
  if (source !== "built-in") void snapshot(path, { origin: "reload", note: parsed.meta.name });
  return skill;
}

async function scanDir(dir: string, source: Skill["source"], workspace?: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    await access(dir);
  } catch {
    return skills;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    const skill = await loadSkillFromFile(skillFile, source);
    if (skill) {
      if (workspace) skill.workspace = workspace;
      skills.push(skill);
    }
  }

  return skills;
}

/** One workspace skills layer: its key and its <workspace>/skills directory. */
export interface WorkspaceSkillLayer {
  key: string;
  dir: string;
}

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  /** The default workspace's skills layer, tagged "default" so secondary workspaces never see
   *  another project's skills while default-workspace runs keep the legacy single-workspace view. */
  workspaceDir?: string;
  workspaces?: WorkspaceSkillLayer[];
}

function mergeSkills(layers: Skill[][]): Map<string, Skill> {
  const merged = new Map<string, Skill>();
  for (const layer of layers) {
    for (const skill of layer) {
      // Workspace skills are keyed by workspace so the same name in workspace A and workspace B
      // never collides globally; built-in and custom stay on the shared name.
      const key = skill.workspace ? `${skill.workspace}/${skill.meta.name}` : skill.meta.name;
      merged.set(key, skill);
    }
  }
  return merged;
}

export async function loadAllSkills(options: SkillDirs): Promise<Map<string, Skill>> {
  const builtIn = await scanDir(options.builtInDir, "built-in");
  const custom = await scanDir(options.customDir, "custom");
  const layers: Skill[][] = [builtIn, custom];
  if (options.workspaceDir) layers.push(await scanDir(options.workspaceDir, "workspace", "default"));
  for (const workspace of options.workspaces ?? []) {
    layers.push(await scanDir(workspace.dir, "workspace", workspace.key));
  }
  return mergeSkills(layers);
}
