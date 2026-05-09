export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  // Future gating support:
  // requires?: { bins?: string[]; env?: string[]; platform?: string[] };
}

export interface Skill {
  meta: SkillMeta;
  content: string;
  path: string;
  source: "built-in" | "custom" | "workspace";
}

export interface SkillInfo {
  name: string;
  description: string;
  source: Skill["source"];
  path: string;
}
