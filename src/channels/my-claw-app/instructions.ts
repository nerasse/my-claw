import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import { contentSha, snapshot, journal, artifactId } from "../../core/config-store.ts";
import { resolvePromptFile } from "../../agent/prompt/loader.ts";
import { PROMPT_FILES, type PromptFile } from "../../agent/prompt/files.ts";
import type { WorkspacePromptPolicy } from "../../core/config.ts";

/**
 * The markdown files the app may edit: the four layers buildSystemPrompt actually reads, from the
 * canonical list in agent/prompt/files.ts. The match is exact, never a pattern, so no path fragment
 * can travel from a device. MEMORY.md is absent on purpose (generated from memory.db and rewritten
 * after every memory write), and so are SYSTEM.md and TOOLS.md, which no line of src/ reads.
 * See docs/instructions-page.md.
 */

/** Where the content shown for a file comes from. `off` means the policy drops the layer
 *  entirely: nothing is shown, nothing is read. */
export type InstructionOrigin = "own" | "inherited" | "fallback" | "off";

export interface InstructionRoots {
  /** The default workspace: it backs every fallback and is the only one seeded at boot. */
  defaultDir: string;
  /** config.workspaces, key -> absolute directory. */
  workspaces?: Record<string, string>;
  /** config.workspacePrompts: per-workspace per-file policies, so the page resolves exactly
   *  what the runtime does. */
  workspacePrompts?: Record<string, WorkspacePromptPolicy>;
}

export interface InstructionEntry {
  workspace: string;
  file: PromptFile;
  origin: InstructionOrigin;
  /** The workspace the content actually comes from, or "" for a fallback. */
  from: string;
  bytes: number;
  /** sha of the content shown, which a write must echo back to prove it is not stale. */
  sha: string;
}

export interface NestedInstruction {
  workspace: string;
  /** Path relative to the workspace root. Display and addressing only, never sent by a device. */
  path: string;
  bytes: number;
}

export type WriteResult =
  | { ok: true; sha: string; bytes: number }
  | { ok: false; error: string; conflict?: boolean };

/** A prompt above this is not an instruction file any more, whatever the device believes. */
export const MAX_INSTRUCTION_BYTES = 256 * 1024;

const NESTED_MAX_DEPTH = 3;
const NESTED_MAX_ENTRIES = 50;
const NESTED_SKIP = new Set(["node_modules", "dist", "build", "vendor", "target"]);

function isPromptFile(name: string): name is PromptFile {
  return (PROMPT_FILES as readonly string[]).includes(name);
}

/** Every workspace the page addresses, "default" included, in a stable order. */
export function workspaceRoots(roots: InstructionRoots): Array<{ key: string; dir: string }> {
  return [
    { key: "default", dir: roots.defaultDir },
    ...Object.entries(roots.workspaces ?? {})
      .filter(([key]) => key !== "default")
      .map(([key, dir]) => ({ key, dir })),
  ];
}

/**
 * Absolute path of one instruction file, or null when the request names something outside the
 * page. An unknown workspace key returns null instead of falling back to the default one: a typo
 * would otherwise edit the wrong workspace's prompt while the app showed the right name.
 */
export function instructionPath(roots: InstructionRoots, workspace: string, file: string): string | null {
  if (!isPromptFile(file)) return null;
  const entry = workspaceRoots(roots).find((w) => w.key === workspace);
  if (!entry) return null;
  const root = resolve(entry.dir);
  const target = resolve(join(root, file));
  // Second fence, like GET /skills: the name list above already forbids separators, and this
  // catches a workspace root that is itself a symlink or a relative leftover.
  if (!target.startsWith(root + sep)) return null;
  return target;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** The resolver answers with directories; the page addresses workspaces by key. */
function keyForDir(roots: InstructionRoots, dir: string): string {
  return workspaceRoots(roots).find((w) => resolve(w.dir) === dir)?.key ?? "";
}

/**
 * The content that actually applies for one file in one workspace, with where it comes from. This
 * shares the loader's resolution ladder (agent/prompt/loader.ts), so the page shows what the agent
 * reads: a named workspace only overrides what it needs, and the page must show the inherited copy
 * rather than an empty editor.
 */
export async function readInstruction(
  roots: InstructionRoots,
  workspace: string,
  file: string,
): Promise<{ content: string; origin: InstructionOrigin; from: string; sha: string } | null> {
  const path = instructionPath(roots, workspace, file);
  if (!path) return null;

  const entry = workspaceRoots(roots).find((w) => w.key === workspace);
  if (!entry) return null;

  const res = await resolvePromptFile(file, {
    workspaceDir: resolve(entry.dir),
    defaultWorkspaceDir: resolve(roots.defaultDir),
    workspaceKey: workspace,
    workspaces: roots.workspaces,
    workspacePrompts: roots.workspacePrompts,
  });
  return {
    content: res.content,
    origin: res.origin,
    from: keyForDir(roots, res.from),
    sha: contentSha(res.content),
  };
}

/** One entry per file per workspace: the page shows the whole resolution, never a hole. */
export async function listInstructions(roots: InstructionRoots): Promise<InstructionEntry[]> {
  const entries: InstructionEntry[] = [];
  for (const { key } of workspaceRoots(roots)) {
    for (const file of PROMPT_FILES) {
      const read = await readInstruction(roots, key, file);
      if (!read) continue;
      entries.push({
        workspace: key,
        file,
        origin: read.origin,
        from: read.from,
        bytes: Buffer.byteLength(read.content),
        sha: read.sha,
      });
    }
  }
  return entries;
}

async function scanDir(root: string, dir: string, depth: number, out: NestedInstruction[], workspace: string): Promise<void> {
  if (depth > NESTED_MAX_DEPTH || out.length >= NESTED_MAX_ENTRIES) return;
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (out.length >= NESTED_MAX_ENTRIES) return;
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name.startsWith(".") || NESTED_SKIP.has(item.name)) continue;
      await scanDir(root, full, depth + 1, out, workspace);
      continue;
    }
    if (item.name !== "AGENTS.md" || full === join(root, "AGENTS.md")) continue;
    const size = await stat(full).then((s) => s.size, () => 0);
    out.push({ workspace, path: relative(root, full), bytes: size });
  }
}

/**
 * The nested AGENTS.md of every workspace, read-only. The run-time collector is lazy -- it walks
 * up from the paths tools touch -- so there is no list to reuse and the page has to scan. The
 * bounds matter: a workspace is an arbitrary directory, and one pointing at a Node repo would
 * otherwise walk node_modules.
 */
export async function scanNestedInstructions(roots: InstructionRoots): Promise<NestedInstruction[]> {
  const out: NestedInstruction[] = [];
  for (const { key, dir } of workspaceRoots(roots)) {
    await scanDir(resolve(dir), resolve(dir), 0, out, key);
  }
  return out;
}

/**
 * Writes one instruction file. `expectedSha` is the sha of the content the editor loaded: the
 * write is refused when the file changed underneath, because AGENTS.md is a file the agent also
 * writes and last-writer-wins would drop what it appended with nothing on screen to say so.
 * An absent `expectedSha` means "create", and is refused if the file already exists.
 *
 * The previous content is snapshotted first, so a bad edit is visible in `/config diff` and
 * undoable with `/config rollback`, exactly like a config edit.
 */
export async function writeInstruction(
  roots: InstructionRoots,
  workspace: string,
  file: string,
  content: string,
  expectedSha: string | undefined,
): Promise<WriteResult> {
  const path = instructionPath(roots, workspace, file);
  if (!path) return { ok: false, error: `unknown instruction file: ${workspace}/${file}` };
  if (Buffer.byteLength(content) > MAX_INSTRUCTION_BYTES) {
    return { ok: false, error: `too large: max ${MAX_INSTRUCTION_BYTES} bytes` };
  }

  const current = await readIfPresent(path);
  if (expectedSha === undefined) {
    if (current !== null) {
      return { ok: false, error: "file already exists", conflict: true };
    }
  } else if (current === null) {
    return { ok: false, error: "file no longer exists", conflict: true };
  } else if (contentSha(current) !== expectedSha) {
    return { ok: false, error: "changed on the server since it was opened", conflict: true };
  }

  await snapshot(path, { origin: "pre-write", note: `avant edition ${workspace}/${file}` });
  const mode = await stat(path).then((s) => s.mode & 0o777, () => 0o600);
  await writeFileAtomically(path, content, { mode });
  await journal("edit", artifactId(path), { workspace, file, bytes: Buffer.byteLength(content) });
  return { ok: true, sha: contentSha(content), bytes: Buffer.byteLength(content) };
}

/** Raw content of a nested AGENTS.md, addressed by the path the last list returned. */
export async function readNestedInstruction(
  roots: InstructionRoots,
  workspace: string,
  relPath: string,
): Promise<string | null> {
  const entry = workspaceRoots(roots).find((w) => w.key === workspace);
  if (!entry) return null;
  const root = resolve(entry.dir);
  const target = resolve(join(root, relPath));
  if (!target.startsWith(root + sep)) return null;
  if (!target.endsWith(sep + "AGENTS.md")) return null;
  return readIfPresent(target);
}
