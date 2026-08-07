import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The three skill tiers, mirroring src/skills/types.ts so the channel never imports the registry. */
export type SkillSource = "built-in" | "custom" | "workspace";

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  /** The default workspace's skills dir, used when no workspace key is given. */
  workspaceSkillsDir: string;
  /** Root of every named workspace (config.workspaces): key -> workspace directory. */
  workspaces?: Record<string, string>;
}

/**
 * The tier directory a skill lives in. A `workspace` key selects that workspace's skills dir;
 * "default" and an absent key both mean the default workspace. An unknown key returns null
 * rather than falling back, so a stale link can never read another workspace's file.
 */
export function skillDirFor(source: SkillSource, dirs: SkillDirs, workspace?: string): string | null {
  if (source === "built-in") return dirs.builtInDir;
  if (source === "custom") return dirs.customDir;
  if (!workspace || workspace === "default") return dirs.workspaceSkillsDir;
  const root = dirs.workspaces?.[workspace];
  return root ? join(root, "skills") : null;
}

/**
 * Raw SKILL.md of one skill, or null when it does not exist. The name is validated against the
 * source dir root so a crafted name can never read outside the tier: this is the second fence
 * after the adapter's format checks, which the tests exercise against the real filesystem.
 */
export async function resolveSkillFile(
  source: SkillSource,
  name: string,
  dirs: SkillDirs,
  workspace?: string,
): Promise<string | null> {
  const dir = skillDirFor(source, dirs, workspace);
  if (!dir) return null;
  const root = resolve(dir);
  const target = resolve(join(root, name, "SKILL.md"));
  if (target !== root && !target.startsWith(root + "/")) return null;
  try {
    return await readFile(target, "utf-8");
  } catch {
    return null;
  }
}
