import { access, cp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** The three skill tiers, mirroring src/skills/types.ts so the channel never imports the registry. */
export type SkillSource = "built-in" | "custom" | "workspace";

export interface SkillDirs {
  builtInDir: string;
  customDir: string;
  /** The default workspace's skills dir, used when no workspace key is given. */
  workspaceSkillsDir: string;
  /** Root of every named workspace (config.workspaces): key -> workspace directory. */
  workspaces?: Record<string, string>;
}

/**
 * The tier directory a skill lives in. A `workspace` key selects that workspace's skills dir;
 * "default" and an absent key both mean the default workspace. An unknown key returns null
 * rather than falling back, so a stale link can never read another workspace's file.
 */
export function skillDirFor(source: SkillSource, dirs: SkillDirs, workspace?: string): string | null {
  if (source === "built-in") return dirs.builtInDir;
  if (source === "custom") return dirs.customDir;
  if (!workspace || workspace === "default") return dirs.workspaceSkillsDir;
  const root = dirs.workspaces?.[workspace];
  return root ? join(root, "skills") : null;
}

/**
 * Absolute directory of one skill inside its tier, or null when the tier is unknown or the name
 * resolves outside it. Second fence after the adapter's format checks, exercised against the
 * real filesystem by the tests.
 */
function skillDirPath(source: SkillSource, name: string, dirs: SkillDirs, workspace?: string): string | null {
  const dir = skillDirFor(source, dirs, workspace);
  if (!dir) return null;
  const root = resolve(dir);
  const target = resolve(join(root, name));
  if (!target.startsWith(root + sep)) return null;
  return target;
}

/**
 * Raw SKILL.md of one skill, or null when it does not exist. The name is validated against the
 * source dir root so a crafted name can never read outside the tier: this is the second fence
 * after the adapter's format checks, which the tests exercise against the real filesystem.
 */
export async function resolveSkillFile(
  source: SkillSource,
  name: string,
  dirs: SkillDirs,
  workspace?: string,
): Promise<string | null> {
  const dir = skillDirPath(source, name, dirs, workspace);
  if (!dir) return null;
  try {
    return await readFile(join(dir, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

/** Where a transfer lands. Never `built-in`: that tier is resynced from the release by hash at
 *  every boot, so anything written there is silently overwritten on the next upgrade. */
export interface SkillTransferTarget {
  source: "custom" | "workspace";
  /** Workspace key when the target tier is `workspace`; absent or "default" means the default one. */
  workspace?: string;
}

export interface SkillTransfer {
  mode: "copy" | "move";
  source: SkillSource;
  name: string;
  /** Workspace key of the source, when its tier is `workspace`. */
  workspace?: string;
  target: SkillTransferTarget;
  /** Replaces an existing skill of the same name in the target tier. */
  overwrite?: boolean;
}

/** Why a transfer was refused. The app maps these to what it offers next (replace, or nothing). */
export type SkillTransferError =
  | "unknown-tier"
  | "unknown-source"
  | "same-place"
  | "built-in-is-read-only"
  | "target-exists";

export interface SkillTransferOutcome {
  /** Absolute directory the skill now lives in. */
  path: string;
  /** True when an existing skill of that name was replaced. */
  replaced: boolean;
}

export class SkillTransferRefused extends Error {
  constructor(readonly code: SkillTransferError) {
    super(code);
    this.name = "SkillTransferRefused";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves or copies one skill *directory* between tiers: a skill is a folder (SKILL.md plus its
 * references and scripts), so this is a recursive copy, never a file write.
 *
 * A move is a copy followed by a delete of the source, in that order: an interrupted transfer
 * then leaves a duplicate, which the owner can see and fix, rather than nothing at all. The
 * built-in tier is copy-from only, both ways: writing into it is undone by the next boot's hash
 * resync, and deleting from it brings the skill back on that same resync.
 */
export async function transferSkill(input: SkillTransfer, dirs: SkillDirs): Promise<SkillTransferOutcome> {
  if (input.mode === "move" && input.source === "built-in") {
    throw new SkillTransferRefused("built-in-is-read-only");
  }
  const from = skillDirPath(input.source, input.name, dirs, input.workspace);
  if (!from) throw new SkillTransferRefused("unknown-tier");
  const to = skillDirPath(input.target.source, input.name, dirs, input.target.workspace);
  if (!to) throw new SkillTransferRefused("unknown-tier");
  if (from === to) throw new SkillTransferRefused("same-place");
  if (!(await exists(join(from, "SKILL.md")))) throw new SkillTransferRefused("unknown-source");

  const replaced = await exists(to);
  if (replaced && !input.overwrite) throw new SkillTransferRefused("target-exists");

  await cp(from, to, { recursive: true, force: true });
  if (input.mode === "move") await rm(from, { recursive: true, force: true });
  return { path: to, replaced };
}
