import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../config.ts";

const PROMPT_DIR = join(MY_CLAW_DIR, "prompt");

const PROMPT_FILES = ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"] as const;

export type PromptFile = (typeof PROMPT_FILES)[number];

export async function loadPromptFile(name: PromptFile): Promise<string> {
  try {
    return await readFile(join(PROMPT_DIR, name), "utf-8");
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
