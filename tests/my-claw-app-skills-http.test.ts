import { test, afterEach, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillFile } from "../src/channels/my-claw-app/skills.ts";

let dirs: { root: string; builtInDir: string; customDir: string; workspaceSkillsDir: string };

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-http-"));
  dirs = {
    root,
    builtInDir: join(root, "builtin"),
    customDir: join(root, "custom"),
    workspaceSkillsDir: join(root, "ws-skills"),
  };
});

afterEach(async () => {
  await rm(dirs.root, { recursive: true, force: true });
});

test("reads SKILL.md from the tier directory", async () => {
  await mkdir(join(dirs.customDir, "forgejo"), { recursive: true });
  await writeFile(join(dirs.customDir, "forgejo", "SKILL.md"), "# Forgejo\n");
  assert.equal(await resolveSkillFile("custom", "forgejo", dirs), "# Forgejo\n");
});

test("returns null for a missing skill instead of throwing", async () => {
  assert.equal(await resolveSkillFile("built-in", "nope", dirs), null);
});

test("a crafted name cannot escape the tier root", async () => {
  await mkdir(dirs.customDir, { recursive: true });
  await writeFile(join(dirs.root, "pwned.txt"), "x");
  // "../pwned.txt" resolves outside the tier root: refused without a read attempt.
  assert.equal(await resolveSkillFile("custom", "../pwned.txt", dirs), null);
  assert.equal(await resolveSkillFile("custom", "..", dirs), null);
});
