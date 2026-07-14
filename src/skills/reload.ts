import { loadAllSkills } from "./loader.ts";
import type { SkillRegistry } from "./registry.ts";

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  workspaceDir: string;
}

// Single source of truth for "rescan skill dirs and swap the registry contents".
// Shared by the manage_skills tool (reload action) and the skills fs watcher so
// both refresh identically. list() is read live per run, so a swap is effective
// on the next agent run.
export async function reloadSkills(dirs: SkillDirs, registry: SkillRegistry): Promise<number> {
  const all = await loadAllSkills(dirs);
  registry.setAll(all);
  return all.size;
}
