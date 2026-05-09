import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROMPT_FILES = ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"] as const;

export type PromptFile = (typeof PROMPT_FILES)[number];

function promptDir(): string {
  return process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();
}

export async function loadPromptFile(name: PromptFile): Promise<string> {
  try {
    return await readFile(join(promptDir(), name), "utf-8");
  } catch {
    return "";
  }
}

export async function loadAllPromptFiles(): Promise<Record<PromptFile, string>> {
  const entries = await Promise.all(
    PROMPT_FILES.map(async (name) => [name, await loadPromptFile(name)] as const),
  );
  return Object.fromEntries(entries) as Record<PromptFile, string>;
}
