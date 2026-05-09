import type { Skill, SkillInfo } from "./types.ts";

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

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): SkillInfo[] {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      source: s.source,
      path: s.path,
    }));
  }

  exists(name: string): boolean {
    return this.skills.has(name);
  }
}
