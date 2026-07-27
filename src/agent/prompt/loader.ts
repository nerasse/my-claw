import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CORE_PROMPT } from "./core-prompts.ts";
import { scanForInjection } from "./anti-injection.ts";

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

/**
 * Always stats: an edit must land on the very next message, so there is no time-based
 * short-circuit. The cache only skips the read when mtime is unchanged, and the prompt is
 * built once per run, so this costs a handful of stat() calls per message.
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
    return content;
  } catch {
    cache.delete(path);
    return "";
  }
}

/** Drops the mtime cache. Only needed by tests: the cache is keyed on the workspace path,
 *  which they move around, and mtime equality cannot see two writes inside one tick. */
export function resetPromptFileCache(): void {
  cache.clear();
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
  return scanForInjection(content, "CORE.md");
}
