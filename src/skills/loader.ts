import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, SkillAudience, SkillMeta } from "./types.ts";
import { SKILL_AUDIENCES } from "./types.ts";
import { snapshot } from "../core/config-store.ts";
import { log } from "../utils/logger.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";

function parseAudiences(name: string, raw: string | undefined): SkillAudience[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const known: SkillAudience[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim().toLowerCase();
    if (!value) continue;
    if ((SKILL_AUDIENCES as readonly string[]).includes(value)) known.push(value as SkillAudience);
    else void log("warn", "skill names an unknown agent, dropped from its audience", { skill: name, agent: value });
  }
  // An entirely unknown list reads as "no gate" rather than "nobody": a typo must not make a
  // skill vanish from every prompt with nothing but a log line to explain it.
  return known.length > 0 ? known : undefined;
}

function parseSkill(text: string): { meta: SkillMeta; content: string } | null {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;

  const name = parsed.fields["name"];
  const description = parsed.fields["description"];
  if (name === undefined || description === undefined) return null;

  const agents = parseAudiences(name, parsed.fields["agents"]);

  return {
    meta: {
      name,
      description,
      version: parsed.fields["version"],
      ...(agents ? { agents } : {}),
    },
    content: parsed.body,
  };
}

/** Single definition of "this text is a loadable skill", so a writer can check what a reader will
 *  accept instead of re-implementing the frontmatter rules. */
export function parsesAsSkill(text: string): boolean {
  return parseSkill(text) !== null;
}

/** Last version of each SKILL.md that parsed. A reload rebuilds the registry wholesale, so without
 *  this a skill edited into a broken frontmatter just vanishes from `/skills` with no explanation. */
const lastGood = new Map<string, Skill>();

/** Only needed by tests: skill paths repeat across files and a kept version would leak. */
export function resetSkillLastGood(): void {
  lastGood.clear();
}

async function loadSkillFromFile(path: string, source: Skill["source"]): Promise<Skill | null> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    // Gone, not broken: forget it so a deleted skill really disappears.
    lastGood.delete(path);
    return null;
  }
  const parsed = parseSkill(text);
  if (!parsed) {
    const kept = lastGood.get(path);
    void log("warn", kept ? "SKILL.md no longer parses, keeping the last good version" : "SKILL.md does not parse", { path });
    return kept ?? null;
  }
  const skill: Skill = { meta: parsed.meta, content: parsed.content, path, source };
  lastGood.set(path, skill);
  // Built-ins are resynced from the repo by hash at every boot, so snapshotting them would archive
  // a copy of the release on each upgrade and churn the store for something already versioned here.
  if (source !== "built-in") void snapshot(path, { origin: "reload", note: parsed.meta.name });
  return skill;
}

async function scanDir(dir: string, source: Skill["source"], workspace?: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  // Both the existence check and the read live in the same try on purpose: `access` only proves
  // the directory is there, so an unreadable one (or one deleted in between) used to reject out
  // of `loadAllSkills` into the detached config-reload chain, which is a process-level killer.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return skills;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    const skill = await loadSkillFromFile(skillFile, source);
    if (skill) {
      if (workspace) skill.workspace = workspace;
      skills.push(skill);
    }
  }

  return skills;
}

/** One workspace skills layer: its key and its <workspace>/skills directory. */
export interface WorkspaceSkillLayer {
  key: string;
  dir: string;
}

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  /** The default workspace's skills layer, tagged "default" so secondary workspaces never see
   *  another project's skills while default-workspace runs keep the legacy single-workspace view. */
  workspaceDir?: string;
  workspaces?: WorkspaceSkillLayer[];
}

function mergeSkills(layers: Skill[][]): Map<string, Skill> {
  const merged = new Map<string, Skill>();
  for (const layer of layers) {
    for (const skill of layer) {
      // Workspace skills are keyed by workspace so the same name in workspace A and workspace B
      // never collides globally; built-in and custom stay on the shared name.
      const key = skill.workspace ? `${skill.workspace}/${skill.meta.name}` : skill.meta.name;
      merged.set(key, skill);
    }
  }
  return merged;
}

export async function loadAllSkills(options: SkillDirs): Promise<Map<string, Skill>> {
  const builtIn = await scanDir(options.builtInDir, "built-in");
  const custom = await scanDir(options.customDir, "custom");
  const layers: Skill[][] = [builtIn, custom];
  if (options.workspaceDir) layers.push(await scanDir(options.workspaceDir, "workspace", "default"));
  for (const workspace of options.workspaces ?? []) {
    layers.push(await scanDir(workspace.dir, "workspace", workspace.key));
  }
  return mergeSkills(layers);
}
