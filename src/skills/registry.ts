import type { Skill, SkillInfo } from "./types.ts";
import { scopeAllows, type AgentScope } from "../core/config.ts";

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
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * The skills an agent may see. The default keeps every existing caller unrestricted, so a missing
   * scope can never silently narrow a prompt. See docs/agent-scoping.md.
   */
  list(scope: AgentScope = "all"): SkillInfo[] {
    return Array.from(this.skills.values())
      .filter((s) => scopeAllows(scope, s.meta.name))
      .map((s) => ({
        name: s.meta.name,
        description: s.meta.description,
        source: s.source,
        path: s.path,
      }));
  }

  exists(name: string): boolean {
    return this.skills.has(name);
  }

  /** Every known skill name, unscoped. For the boot check that reports scope entries matching nothing. */
  names(): string[] {
    return Array.from(this.skills.keys());
  }
}
