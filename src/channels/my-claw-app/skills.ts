import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The three skill tiers, mirroring src/skills/types.ts so the channel never imports the registry. */
export type SkillSource = "built-in" | "custom" | "workspace";

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  workspaceSkillsDir: string;
}

export function skillDirFor(source: SkillSource, dirs: SkillDirs): string {
  if (source === "built-in") return dirs.builtInDir;
  if (source === "custom") return dirs.customDir;
  return dirs.workspaceSkillsDir;
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
): Promise<string | null> {
  const root = resolve(skillDirFor(source, dirs));
  const target = resolve(join(root, name, "SKILL.md"));
  if (target !== root && !target.startsWith(root + "/")) return null;
  try {
    return await readFile(target, "utf-8");
  } catch {
    return null;
  }
}
