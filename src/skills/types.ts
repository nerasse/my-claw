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
  /** Key of the workspace layer this skill came from (config.workspaces). Unset for the
   *  default workspace's skills, so a default-workspace session keeps seeing them as the
   *  legacy unscoped workspace tier. See docs/multi-workspace.md. */
  workspace?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  version?: string;
  source: Skill["source"];
  path: string;
  /** Key of the workspace this skill belongs to, when it is a secondary workspace's. */
  workspace?: string;
  /** Browse catalogs only (`listAll`): the workspaces where this global entry is masked by a
   *  workspace skill of the same name. Never set on the resolved view, which has no masked
   *  entry left to explain. */
  overriddenIn?: string[];
  /** Browse catalogs only: the global tier this workspace skill masks. */
  overrides?: "custom" | "built-in";
}
