import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryConfig } from "../core/config.ts";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { getAllActive, getByHash, addEntry } from "./db.ts";
import { embed, embeddingSignature } from "./embedding.ts";
import { hashContent } from "./dedup.ts";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./types.ts";
import { log } from "../utils/logger.ts";

const CATEGORY_TITLES: Record<MemoryCategory, string> = {
  user: "User",
  environment: "Environment",
  convention: "Conventions",
  project: "Project",
  lesson: "Lessons",
};

const TITLE_TO_CATEGORY = new Map<string, MemoryCategory>(
  MEMORY_CATEGORIES.map((c) => [CATEGORY_TITLES[c].toLowerCase(), c]),
);

const HEADER =
  "<!-- Auto-generated from memory.db. Hand-edits add new facts on next boot; " +
  "deletions are ignored (use the memory tool to forget). -->";

function workspaceDir(): string {
  return process.env["MY_CLAW_WORKSPACE"] ?? join(MY_CLAW_DIR, "workspace");
}

export function memoryFilePath(): string {
  return join(workspaceDir(), "MEMORY.md");
}

/** Regenerate MEMORY.md from the database (source of truth), grouped by category. */
export async function exportToMarkdown(): Promise<void> {
  try {
    const entries = getAllActive();
    const sections: string[] = [HEADER, "# Memory"];

    for (const category of MEMORY_CATEGORIES) {
      const inCategory = entries.filter((e) => e.category === category);
      if (inCategory.length === 0) continue;
      sections.push(`## ${CATEGORY_TITLES[category]}`);
      sections.push(inCategory.map((e) => `- ${e.content}`).join("\n"));
    }

    const content = sections.join("\n\n") + "\n";
    // Unique temp per call so overlapping background exports never race on rename.
    await writeFileAtomically(memoryFilePath(), content, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  } catch (err) {
    void log("warn", "memory exportToMarkdown failed", { error: String(err) });
  }
}

/**
 * Import facts hand-written into MEMORY.md that are not yet in the database.
 * Additive and idempotent (exact-hash dedup). Deletions are not propagated.
 */
export async function importHandEdits(cfg?: MemoryConfig): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(memoryFilePath(), "utf-8");
  } catch {
    return 0;
  }

  let category: MemoryCategory = "lesson";
  let imported = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("##")) {
      const title = trimmed.replace(/^#+\s*/, "").toLowerCase();
      category = TITLE_TO_CATEGORY.get(title) ?? "lesson";
      continue;
    }
    if (!trimmed.startsWith("- ")) continue;
    const content = trimmed.slice(2).trim();
    if (!content) continue;

    const hash = hashContent(content);
    if (getByHash(hash)) continue;

    const embedding = await embed(content, cfg?.embedding);
    addEntry(content, category, embedding, hash, embeddingSignature(cfg?.embedding));
    imported += 1;
  }

  if (imported > 0) {
    void log("info", "memory imported hand-edits", { imported });
  }
  return imported;
}

const LEGACY_FILES: Array<{ name: string; category: MemoryCategory }> = [
  { name: "USER.md", category: "user" },
  { name: "MEMORY.md", category: "lesson" },
];

function isMeaningfulLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("#")) return false;
  if (line.startsWith("---")) return false;
  // Skip pure italic placeholders like *(notes...)*.
  if (/^\*.*\*$/.test(line)) return false;
  return true;
}

/**
 * One-time import of the pre-V2 freeform memory files from ~/.my-claw/prompt/.
 * Each meaningful line becomes an entry; processed files are renamed .migrated
 * so this is idempotent across boots.
 */
export async function migrateLegacyFiles(cfg?: MemoryConfig, dir?: string): Promise<number> {
  const legacyDir = dir ?? join(MY_CLAW_DIR, "prompt");
  let migrated = 0;

  for (const { name, category } of LEGACY_FILES) {
    const path = join(legacyDir, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.replace(/^[-*]\s+/, "").trim();
      if (!isMeaningfulLine(trimmed)) continue;
      const hash = hashContent(trimmed);
      if (getByHash(hash)) continue;
      const embedding = await embed(trimmed, cfg?.embedding);
      addEntry(trimmed, category, embedding, hash, embeddingSignature(cfg?.embedding));
      migrated += 1;
    }

    await rename(path, `${path}.migrated`).catch(() => {});
  }

  if (migrated > 0) {
    void log("info", "memory migrated legacy files", { migrated });
  }
  return migrated;
}
