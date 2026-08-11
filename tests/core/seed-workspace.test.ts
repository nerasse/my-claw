import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorkspaceTemplates } from "../../src/core/config.ts";
import { PROMPT_FILES } from "../../src/agent/prompt/files.ts";

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seed-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("seedWorkspaceTemplates", () => {
  test("a fresh workspace gets the four prompt files plus SYSTEM and MEMORY", async () => {
    const dir = await tmpDir();
    await seedWorkspaceTemplates(dir);
    const names = (await readdir(dir)).sort();
    for (const f of PROMPT_FILES) {
      expect(names).toContain(f);
      expect((await readFile(join(dir, f), "utf-8")).length).toBeGreaterThan(0);
    }
    expect(names).toContain("SYSTEM.md");
    expect(names).toContain("MEMORY.md");
  });

  test("existing files are never overwritten", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "SOUL.md"), "je suis moi", "utf-8");
    await seedWorkspaceTemplates(dir);
    expect(await readFile(join(dir, "SOUL.md"), "utf-8")).toBe("je suis moi");
  });

  test("a missing template file leaves the destination empty instead of failing", async () => {
    const dir = await tmpDir();
    await seedWorkspaceTemplates(dir);
    await seedWorkspaceTemplates(dir);
    expect((await readdir(dir)).length).toBeGreaterThanOrEqual(PROMPT_FILES.length);
  });
});
