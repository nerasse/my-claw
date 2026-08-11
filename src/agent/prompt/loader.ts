import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_PROMPT } from "./core-prompts.ts";
import { normalizeUntrusted } from "./normalize-untrusted.ts";
import { WORKSPACE_PROMPT_FILES, type WorkspacePromptFile } from "./files.ts";
import { resolvePromptPolicy, type WorkspacePromptPolicy } from "../../core/config.ts";
import { snapshot, isTracked } from "../../core/config-store.ts";
import { log } from "../../utils/logger.ts";

function promptRoot(workspaceDir?: string): string {
  return workspaceDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
/** Paths already reported as unreadable. The loader runs on every message, so an unconditional
 *  log would flood; one line per failure streak is enough to see a layer went missing. */
const warned = new Set<string>();

/**
 * Always stats: an edit must land on the very next message, so there is no time-based
 * short-circuit. The cache only skips the read when mtime is unchanged, and the prompt is
 * built once per run, so this costs a handful of stat() calls per message.
 *
 * On a read failure the last good content is kept rather than dropped. Deleting it returned "" and
 * silently removed a whole prompt layer (`builder.ts` skips empty layers), so a truncated SOUL.md
 * used to mute the agent's personality with nothing logged anywhere.
 */
async function readPromptPath(path: string, name: string): Promise<string | null> {
  const cached = cache.get(path);

  try {
    const s = await stat(path);
    if (cached && s.mtimeMs === cached.mtimeMs) {
      return cached.content;
    }
    const content = await readFile(path, "utf-8");
    cache.set(path, { content, mtimeMs: s.mtimeMs });
    warned.delete(path);
    // Tracked-only, like the write tool: boot registers the workspace prompt files, so this keeps
    // history for an external edit without creating a store entry for whatever cwd happens to be.
    if (await isTracked(path)) void snapshot(path, { origin: "reload", note: name });
    return content;
  } catch (err) {
    if (!warned.has(path)) {
      warned.add(path);
      void log("warn", "prompt file unreadable", {
        path,
        error: String(err),
        keptPreviousContent: cached !== undefined,
      });
    }
    return null;
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** The docs/prompt/<name> template, and the hardcoded CORE_PROMPT when even that is missing:
 *  CORE is the one layer the builder refuses to leave empty. */
async function readShippedTemplate(name: string): Promise<string> {
  const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const template = await readIfPresent(join(repoRoot, "docs", "prompt", name));
  if (template !== null) return template;
  return name === "CORE.md" ? CORE_PROMPT : "";
}

export interface PromptResolveOptions {
  /** The run's workspace. Absent falls back to MY_CLAW_WORKSPACE, then cwd. */
  workspaceDir?: string;
  /** The default workspace, the fallback layer for every workspace. */
  defaultWorkspaceDir?: string;
  /** The run's workspace key (config.workspaces), the key the prompt policy is indexed by. */
  workspaceKey?: string;
  /** config.workspaces: resolves an inherited source key to its directory. */
  workspaces?: Record<string, string>;
  /** config.workspacePrompts: the per-workspace per-file policies. */
  workspacePrompts?: Record<string, WorkspacePromptPolicy>;
}

export interface PromptFileResolution {
  content: string;
  /** `own` is a file in this workspace, `inherited` another workspace's, `fallback` the template. */
  origin: "own" | "inherited" | "fallback";
  /** Workspace directory the content came from, "" for a template. */
  from: string;
}

/**
 * The resolution ladder, the one implementation shared by the loader and the instructions page:
 * the workspace's own file, then the configured source (docs/workspace-prompt-inheritance.md),
 * then the last known good. `shippedTemplate` is the page-only tail until `builtin` becomes the
 * runtime's default last resort (phase 2 of docs/workspace-prompt-inheritance.md) -- today a layer
 * no workspace owns is empty for the agent but shown as the template on the page, which is exactly
 * the divergence that ladder is there to close.
 */
export async function resolvePromptFile(
  name: string,
  opts: PromptResolveOptions,
  shippedTemplate: boolean,
): Promise<PromptFileResolution> {
  const primaryDir = promptRoot(opts.workspaceDir);
  const primary = join(primaryDir, name);
  const fromPrimary = await readPromptPath(primary, name);
  if (fromPrimary !== null) return { content: fromPrimary, origin: "own", from: primaryDir };

  // The configured source replaces the hardcoded default-workspace step. One hop: only the
  // source's own file is read, never the source's own inheritance, so cycles are impossible by
  // construction. "none" ends the ladder; "builtin" reads the shipped template as the source.
  // `off` is phase 2 and deliberately not honored yet.
  const policy = resolvePromptPolicy(opts.workspacePrompts, opts.workspaceKey, name);
  let sourceTail = policy.inherit === "none" || policy.inherit === "builtin";
  if (policy.inherit !== "none") {
    if (policy.inherit === "builtin") {
      const template = await readShippedTemplate(name);
      if (template !== "") return { content: template, origin: "fallback", from: "" };
    } else {
      const sourceDir = policy.inherit === "default" ? opts.defaultWorkspaceDir : opts.workspaces?.[policy.inherit];
      if (sourceDir !== undefined && sourceDir !== primaryDir) {
        const fromSource = await readPromptPath(join(sourceDir, name), name);
        if (fromSource !== null) return { content: fromSource, origin: "inherited", from: sourceDir };
      }
    }
  }

  const lastGood = cache.get(primary);
  if (lastGood !== undefined) return { content: lastGood.content, origin: "own", from: primaryDir };

  if (sourceTail) return { content: "", origin: "fallback", from: "" };
  if (!shippedTemplate) return { content: "", origin: "fallback", from: "" };

  return { content: await readShippedTemplate(name), origin: "fallback", from: "" };
}

/**
 * The content that applies for one prompt file in one workspace. With a secondary workspace, the
 * file is looked up there first and falls back per the workspace's prompt policy (absent policy:
 * the default workspace, which is what every workspace did before config.workspacePrompts
 * existed). The mtime cache is keyed on absolute paths, so every workspace coexists in it.
 */
export async function loadPromptFile(name: string, opts: PromptResolveOptions = {}): Promise<string> {
  return (await resolvePromptFile(name, opts, false)).content;
}

/** Drops the mtime cache. Only needed by tests: the cache is keyed on the workspace path,
 *  which they move around, and mtime equality cannot see two writes inside one tick. */
export function resetPromptFileCache(): void {
  cache.clear();
  warned.clear();
}

export async function loadAllPromptFiles(opts: PromptResolveOptions = {}): Promise<Record<WorkspacePromptFile, string>> {
  const entries = await Promise.all(
    WORKSPACE_PROMPT_FILES.map(async (name) => [name, await loadPromptFile(name, opts)] as const),
  );
  return Object.fromEntries(entries) as Record<WorkspacePromptFile, string>;
}

/**
 * Layer 0 core directives. Read live from the workspace CORE.md (mtime cache, hot like the
 * other prompt files) and normalised since it is owner-editable. Falls back to the hardcoded
 * CORE_PROMPT when the file is missing or blank, so the structural prompt can never be silently
 * emptied. OWNER_STEERING stays in code by design.
 */
export async function loadCorePrompt(opts: PromptResolveOptions = {}): Promise<string> {
  const content = (await loadPromptFile("CORE.md", opts)).trim();
  if (!content) return CORE_PROMPT;
  return normalizeUntrusted(content, "CORE.md");
}
