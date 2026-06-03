import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const PROMPT_FILES = ["SOUL.md", "AGENTS.md", "USER.md"] as const;
const CACHE_TTL_MS = 30_000;

export type PromptFile = (typeof PROMPT_FILES)[number];

function promptDir(): string {
  return process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function loadPromptFile(name: PromptFile): Promise<string> {
  const path = join(promptDir(), name);
  const now = Date.now();
  const cached = cache.get(path);

  if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  try {
    const s = await stat(path);
    if (cached && s.mtimeMs === cached.mtimeMs) {
      cached.checkedAt = now;
      return cached.content;
    }
    const content = await readFile(path, "utf-8");
    cache.set(path, { content, mtimeMs: s.mtimeMs, checkedAt: now });
    return content;
  } catch {
    cache.delete(path);
    return "";
  }
}

export async function loadAllPromptFiles(): Promise<Record<PromptFile, string>> {
  const entries = await Promise.all(
    PROMPT_FILES.map(async (name) => [name, await loadPromptFile(name)] as const),
  );
  return Object.fromEntries(entries) as Record<PromptFile, string>;
}
