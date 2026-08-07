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

test("a named workspace's skill is read from that workspace, not the default", async () => {
  const sofa = join(dirs.root, "SOFA");
  await mkdir(join(sofa, "skills", "deploy"), { recursive: true });
  await writeFile(join(sofa, "skills", "deploy", "SKILL.md"), "# Deploy SOFA\n");
  await mkdir(join(dirs.workspaceSkillsDir, "deploy"), { recursive: true });
  await writeFile(join(dirs.workspaceSkillsDir, "deploy", "SKILL.md"), "# Deploy default\n");

  const withWorkspaces = { ...dirs, workspaces: { sofa } };
  assert.equal(await resolveSkillFile("workspace", "deploy", withWorkspaces, "sofa"), "# Deploy SOFA\n");
  assert.equal(await resolveSkillFile("workspace", "deploy", withWorkspaces, "default"), "# Deploy default\n");
  assert.equal(await resolveSkillFile("workspace", "deploy", withWorkspaces), "# Deploy default\n");
});

test("an unknown workspace key reads nothing rather than falling back", async () => {
  await mkdir(join(dirs.workspaceSkillsDir, "deploy"), { recursive: true });
  await writeFile(join(dirs.workspaceSkillsDir, "deploy", "SKILL.md"), "# Deploy default\n");
  // Falling back to the default workspace would serve another project's file under its name.
  assert.equal(await resolveSkillFile("workspace", "deploy", dirs, "ghost"), null);
});
