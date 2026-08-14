import { test, afterEach, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferSkill, SkillTransferRefused, type SkillDirs } from "../src/channels/my-claw-app/skills.ts";

let root: string;
let dirs: SkillDirs & { root: string };

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`);
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof SkillTransferRefused, `expected a refusal, got ${String(err)}`);
    return err.code;
  }
  throw new Error("expected a refusal, the transfer went through");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-transfer-"));
  dirs = {
    root,
    builtInDir: join(root, "builtin"),
    customDir: join(root, "custom"),
    workspaceSkillsDir: join(root, "workspace", "skills"),
    workspaces: { sofa: join(root, "SOFA") },
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("copy promotes a workspace skill to custom, leaving the original in place", async () => {
  await writeSkill(join(root, "SOFA", "skills"), "deploy", "from sofa");

  const outcome = await transferSkill(
    { mode: "copy", source: "workspace", name: "deploy", workspace: "sofa", target: { source: "custom" } },
    dirs,
  );

  assert.equal(outcome.path, join(dirs.customDir, "deploy"));
  assert.equal(outcome.replaced, false);
  assert.ok(await present(join(dirs.customDir, "deploy", "SKILL.md")));
  assert.ok(await present(join(root, "SOFA", "skills", "deploy", "SKILL.md")), "a copy keeps the source");
});

test("a copy carries the whole skill directory, not just SKILL.md", async () => {
  const source = join(root, "SOFA", "skills", "deploy");
  await writeSkill(join(root, "SOFA", "skills"), "deploy", "from sofa");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(join(source, "references", "format.md"), "# Format\n");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "scripts", "run.sh"), "echo hi\n");

  await transferSkill(
    { mode: "copy", source: "workspace", name: "deploy", workspace: "sofa", target: { source: "custom" } },
    dirs,
  );

  assert.equal(await readFile(join(dirs.customDir, "deploy", "references", "format.md"), "utf-8"), "# Format\n");
  assert.ok(await present(join(dirs.customDir, "deploy", "scripts", "run.sh")));
});

test("move between two workspaces leaves nothing behind", async () => {
  await writeSkill(dirs.workspaceSkillsDir, "deploy", "from default");

  await transferSkill(
    { mode: "move", source: "workspace", name: "deploy", target: { source: "workspace", workspace: "sofa" } },
    dirs,
  );

  assert.ok(await present(join(root, "SOFA", "skills", "deploy", "SKILL.md")));
  assert.equal(await present(join(dirs.workspaceSkillsDir, "deploy")), false);
});

test("an existing skill of the same name is refused, then replaced on overwrite", async () => {
  await writeSkill(join(root, "SOFA", "skills"), "deploy", "from sofa");
  await writeSkill(dirs.customDir, "deploy", "already here");

  const transfer = {
    mode: "copy" as const,
    source: "workspace" as const,
    name: "deploy",
    workspace: "sofa",
    target: { source: "custom" as const },
  };
  assert.equal(await refusalOf(() => transferSkill(transfer, dirs)), "target-exists");
  assert.ok((await readFile(join(dirs.customDir, "deploy", "SKILL.md"), "utf-8")).includes("already here"));

  const outcome = await transferSkill({ ...transfer, overwrite: true }, dirs);
  assert.equal(outcome.replaced, true);
  assert.ok((await readFile(join(dirs.customDir, "deploy", "SKILL.md"), "utf-8")).includes("from sofa"));
});

test("a built-in skill can be forked but never moved", async () => {
  await writeSkill(dirs.builtInDir, "forgejo", "shipped");

  // A move would delete from the tier the next boot resyncs from the release: the skill would
  // come back and the move would look undone.
  assert.equal(
    await refusalOf(() =>
      transferSkill({ mode: "move", source: "built-in", name: "forgejo", target: { source: "custom" } }, dirs),
    ),
    "built-in-is-read-only",
  );
  assert.ok(await present(join(dirs.builtInDir, "forgejo", "SKILL.md")));

  const outcome = await transferSkill(
    { mode: "copy", source: "built-in", name: "forgejo", target: { source: "custom" } },
    dirs,
  );
  assert.equal(outcome.path, join(dirs.customDir, "forgejo"));
});

test("an unknown workspace key, an unknown skill and a no-op transfer are refused", async () => {
  await writeSkill(dirs.customDir, "deploy", "here");

  assert.equal(
    await refusalOf(() =>
      transferSkill({ mode: "copy", source: "custom", name: "deploy", target: { source: "workspace", workspace: "ghost" } }, dirs),
    ),
    "unknown-tier",
  );
  assert.equal(
    await refusalOf(() => transferSkill({ mode: "copy", source: "custom", name: "absent", target: { source: "workspace" } }, dirs)),
    "unknown-source",
  );
  assert.equal(
    await refusalOf(() => transferSkill({ mode: "copy", source: "custom", name: "deploy", target: { source: "custom" } }, dirs)),
    "same-place",
  );
});

test("a crafted name cannot write outside the tier root", async () => {
  await writeSkill(dirs.customDir, "deploy", "here");
  await writeFile(join(root, "victim.txt"), "keep me");

  assert.equal(
    await refusalOf(() =>
      transferSkill({ mode: "copy", source: "custom", name: "../victim.txt", target: { source: "workspace" } }, dirs),
    ),
    "unknown-tier",
  );
  assert.equal(await readFile(join(root, "victim.txt"), "utf-8"), "keep me");
});
