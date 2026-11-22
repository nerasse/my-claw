import type { Skill, SkillAudience, SkillInfo } from "./types.ts";
import { scopeAllows, type AgentScope } from "../core/config.ts";

function keyFor(name: string, workspace?: string): string {
  return workspace ? `${workspace}/${name}` : name;
}

function toInfo(skill: Skill): SkillInfo {
  return {
    name: skill.meta.name,
    description: skill.meta.description,
    ...(skill.meta.version ? { version: skill.meta.version } : {}),
    ...(skill.meta.agents ? { agents: [...skill.meta.agents] } : {}),
    source: skill.source,
    path: skill.path,
    ...(skill.workspace ? { workspace: skill.workspace } : {}),
  };
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
   * (the loader, the `skills` tool's writes, the boot scope validation) go through here. Anything that hands
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
   *
   * One entry per name, resolved like `get()`: the run's workspace layer shadows the global
   * entry, which the loader already resolved as custom over built-in. Listing both would put the
   * same name twice in the prompt with two different descriptions, for a `skills` read that can
   * only ever return the workspace one.
   */
  list(scope: AgentScope = "all", workspace?: string, audience?: SkillAudience): SkillInfo[] {
    const effective = workspace ?? "default";
    const byName = new Map<string, Skill>();
    for (const skill of this.skills.values()) {
      if (!scopeAllows(scope, skill.meta.name)) continue;
      if (audience && skill.meta.agents && !skill.meta.agents.includes(audience)) continue;
      if (skill.workspace !== undefined && skill.workspace !== effective) continue;
      // Insertion order already puts the workspace layer last, but a partial reload must not be
      // able to flip the priority, so the shadowing is stated rather than inherited.
      const seen = byName.get(skill.meta.name);
      if (seen && seen.workspace !== undefined && skill.workspace === undefined) continue;
      byName.set(skill.meta.name, skill);
    }
    return Array.from(byName.values()).map(toInfo);
  }

  exists(name: string, workspace?: string): boolean {
    return this.get(name, workspace) !== undefined;
  }

  /**
   * The whole catalog, every workspace included. For browse surfaces (the app's skills page)
   * rather than agent runs: an agent must never be handed skills outside its own workspace,
   * which is what `list(scope, workspace)` is for.
   *
   * Unresolved on purpose, and therefore annotated: each entry carries which workspaces mask it
   * (`overriddenIn`) or which global tier it masks (`overrides`). Showing the copies without
   * saying which one wins is what makes a browse catalog misleading.
   */
  listAll(): SkillInfo[] {
    const owners = new Map<string, string[]>();
    for (const skill of this.skills.values()) {
      if (skill.workspace === undefined) continue;
      const list = owners.get(skill.meta.name);
      if (list) list.push(skill.workspace);
      else owners.set(skill.meta.name, [skill.workspace]);
    }
    return Array.from(this.skills.values()).map((skill) => {
      const info = toInfo(skill);
      if (skill.workspace === undefined) {
        const masked = owners.get(skill.meta.name);
        if (masked && masked.length > 0) info.overriddenIn = [...masked].sort();
        return info;
      }
      const global = this.skills.get(keyFor(skill.meta.name));
      if (global) info.overrides = global.source === "built-in" ? "built-in" : "custom";
      return info;
    });
  }

  /** Every known skill name, unscoped. For the boot check that reports scope entries matching nothing. */
  names(): string[] {
    return Array.from(
      new Set(Array.from(this.skills.values()).map((s) => s.meta.name)),
    );
  }
}
