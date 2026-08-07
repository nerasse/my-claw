import { loadAllSkills, type WorkspaceSkillLayer } from "./loader.ts";
import type { SkillRegistry } from "./registry.ts";

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  /** The default workspace's skills layer, unscoped (legacy single-workspace behavior). */
  workspaceDir?: string;
  workspaces?: WorkspaceSkillLayer[];
}

/** The editable tier dirs the watcher must attach to, in watch order. */
export function editableTierDirs(dirs: SkillDirs): string[] {
  return [dirs.customDir, ...(dirs.workspaceDir ? [dirs.workspaceDir] : []), ...(dirs.workspaces ?? []).map((w) => w.dir)];
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
