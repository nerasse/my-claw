import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CORE_PROMPT } from "./core-prompts.ts";
import { scanForeign } from "./anti-injection.ts";
import { snapshot, isTracked } from "../../core/config-store.ts";
import { log } from "../../utils/logger.ts";

const PROMPT_FILES = ["SOUL.md", "AGENTS.md", "USER.md"] as const;

export type PromptFile = (typeof PROMPT_FILES)[number];

function promptDir(): string {
  return process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();
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
export async function loadPromptFile(name: string): Promise<string> {
  const path = join(promptDir(), name);
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
    return cached?.content ?? "";
  }
}

/** Drops the mtime cache. Only needed by tests: the cache is keyed on the workspace path,
 *  which they move around, and mtime equality cannot see two writes inside one tick. */
export function resetPromptFileCache(): void {
  cache.clear();
  warned.clear();
}

export async function loadAllPromptFiles(): Promise<Record<PromptFile, string>> {
  const entries = await Promise.all(
    PROMPT_FILES.map(async (name) => [name, await loadPromptFile(name)] as const),
  );
  return Object.fromEntries(entries) as Record<PromptFile, string>;
}

/**
 * Layer 0 core directives. Read live from the workspace CORE.md (mtime cache, hot like the
 * other prompt files) and scanned for injection since it is owner-editable. Falls back to
 * the hardcoded CORE_PROMPT when the file is missing or blank, so the structural prompt can
 * never be silently emptied. OWNER_STEERING/anti-injection stay in code by design.
 */
export async function loadCorePrompt(): Promise<string> {
  const content = (await loadPromptFile("CORE.md")).trim();
  if (!content) return CORE_PROMPT;
  return scanForeign(content, "CORE.md");
}
