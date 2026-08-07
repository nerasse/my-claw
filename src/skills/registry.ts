import type { Skill, SkillInfo } from "./types.ts";
import { scopeAllows, type AgentScope } from "../core/config.ts";

function keyFor(name: string, workspace?: string): string {
  return workspace ? `${workspace}/${name}` : name;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(skills?: Map<string, Skill>) {
    if (skills) {
      this.skills = new Map(skills);
    }
  }

  setAll(skills: Map<string, Skill>): void {
    this.skills = new Map(skills);
  }

  /**
   * Unscoped on purpose: this is the skill store, and callers that legitimately need every skill
   * (the loader, `manage_skills`, the boot scope validation) go through here. Anything that hands
   * skills to an agent must use `list(scope)` / `getInScope` instead.
   *
   * `workspace` resolves within one workspace's layers: the workspace's own skill shadows the
   * shared name for that workspace, the global entry (built-in/custom) remains for everyone else.
   * A default-workspace run (no key) sees its own layer too, keeping the legacy
   * workspace > custom > built-in priority. See docs/multi-workspace.md.
   */
  get(name: string, workspace?: string): Skill | undefined {
    if (workspace) {
      const scoped = this.skills.get(keyFor(name, workspace));
      if (scoped) return scoped;
    }
    if (!workspace) {
      const defaultLayer = this.skills.get(keyFor(name, "default"));
      if (defaultLayer) return defaultLayer;
    }
    return this.skills.get(keyFor(name));
  }

  /**
   * The skills an agent may see: built-in + custom + the skills of the run's workspace. The
   * default workspace's skills are tagged "default" and seen by default-workspace runs only, so a
   * secondary workspace never inherits another project's skills. The default keeps every existing
   * caller unrestricted, so a missing scope can never silently narrow a prompt.
   * See docs/agent-scoping.md.
   */
  list(scope: AgentScope = "all", workspace?: string): SkillInfo[] {
    const effective = workspace ?? "default";
    return Array.from(this.skills.values())
      .filter((s) => scopeAllows(scope, s.meta.name))
      .filter((s) => s.workspace === undefined || s.workspace === effective)
      .map((s) => ({
        name: s.meta.name,
        description: s.meta.description,
        ...(s.meta.version ? { version: s.meta.version } : {}),
        source: s.source,
        path: s.path,
        ...(s.workspace ? { workspace: s.workspace } : {}),
      }));
  }

  exists(name: string, workspace?: string): boolean {
    return this.get(name, workspace) !== undefined;
  }

  /**
   * The whole catalog, every workspace included. For browse surfaces (the app's skills page)
   * rather than agent runs: an agent must never be handed skills outside its own workspace,
   * which is what `list(scope, workspace)` is for.
   */
  listAll(): SkillInfo[] {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      ...(s.meta.version ? { version: s.meta.version } : {}),
      source: s.source,
      path: s.path,
      ...(s.workspace ? { workspace: s.workspace } : {}),
    }));
  }

  /** Every known skill name, unscoped. For the boot check that reports scope entries matching nothing. */
  names(): string[] {
    return Array.from(
      new Set(Array.from(this.skills.values()).map((s) => s.meta.name)),
    );
  }
}
