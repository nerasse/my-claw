import { readFile, readdir, access } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Skill, SkillMeta } from "./types.ts";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function parseFrontmatter(text: string): { meta: SkillMeta; content: string } | null {
  const match = FRONTMATTER_RE.exec(text.trimStart());
  if (!match) return null;

  const rawYaml = match[1]!;
  const content = match[2]!.trimStart();

  const meta: Record<string, unknown> = {};
  for (const line of rawYaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    meta[key] = value;
  }

  const name = meta["name"];
  const description = meta["description"];
  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  return {
    meta: {
      name: name.trim(),
      description: description.trim(),
      version: typeof meta["version"] === "string" ? meta["version"].trim() : undefined,
    },
    content,
  };
}

async function loadSkillFromFile(path: string): Promise<Skill | null> {
  try {
    const text = await readFile(path, "utf-8");
    const parsed = parseFrontmatter(text);
    if (!parsed) return null;
    return {
      meta: parsed.meta,
      content: parsed.content,
      path,
      source: "custom",
    };
  } catch {
    return null;
  }
}

async function scanDir(dir: string, source: Skill["source"]): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    await access(dir);
  } catch {
    return skills;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    const skill = await loadSkillFromFile(skillFile);
    if (skill) {
      skill.source = source;
      skills.push(skill);
    }
  }

  return skills;
}

function mergeSkills(layers: Skill[][]): Map<string, Skill> {
  const merged = new Map<string, Skill>();
  for (const layer of layers) {
    for (const skill of layer) {
      merged.set(skill.meta.name, skill);
    }
  }
  return merged;
}

export async function loadAllSkills(options: {
  builtInDir: string;
  customDir: string;
  workspaceDir: string;
}): Promise<Map<string, Skill>> {
  const builtIn = await scanDir(options.builtInDir, "built-in");
  const custom = await scanDir(options.customDir, "custom");
  const workspace = await scanDir(options.workspaceDir, "workspace");

  return mergeSkills([builtIn, custom, workspace]);
}
