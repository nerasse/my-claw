import { loadAllAgents, type AgentDirs } from "./loader.ts";
import type { AgentRegistry } from "./registry.ts";

export type { AgentDirs, WorkspaceAgentLayer } from "./loader.ts";

/**
 * The tiers a watcher should follow. The built-in tier is deliberately absent: it is repo-synced at
 * boot only. Shared with the watcher so the two cannot disagree on what is editable.
 */
export function editableAgentTierDirs(dirs: AgentDirs): string[] {
  return [
    dirs.customDir,
    ...(dirs.workspaceDir ? [dirs.workspaceDir] : []),
    ...(dirs.workspaces ?? []).map((workspace) => workspace.dir),
  ];
}

/** Rebuilds the registry wholesale. `list()` is read live per run, so a swap takes effect next run. */
export async function reloadAgents(dirs: AgentDirs, registry: AgentRegistry): Promise<number> {
  const all = await loadAllAgents(dirs);
  registry.setAll(all);
  return all.size;
}
