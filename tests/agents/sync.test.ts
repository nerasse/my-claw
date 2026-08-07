import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { mkdir, writeFile, rm, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltInAgents } from "../../src/agents/sync.ts";
import { loadAllAgents } from "../../src/agents/loader.ts";

async function setupDir(): Promise<string> {
  const dir = join("/tmp", `agents-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test("the built-in tier is copied from the repo and reports what changed", async () => {
  const root = await setupDir();
  const repo = join(root, "repo");
  const builtin = join(root, "builtin");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "general.md"), `---\ndescription: General\n---\n\nBody.`);

  assert.deepEqual(await syncBuiltInAgents(repo, builtin), ["general.md"]);
  assert.match(await readFile(join(builtin, "general.md"), "utf-8"), /description: General/);
  await rm(root, { recursive: true, force: true });
});

test("an unchanged agent is not recopied on the next boot", async () => {
  const root = await setupDir();
  const repo = join(root, "repo");
  const builtin = join(root, "builtin");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "general.md"), `---\ndescription: General\n---\n`);

  await syncBuiltInAgents(repo, builtin);
  assert.deepEqual(await syncBuiltInAgents(repo, builtin), [], "same content, nothing to do");
  await rm(root, { recursive: true, force: true });
});

test("an agent dropped from the release stops being spawnable after an upgrade", async () => {
  const root = await setupDir();
  const repo = join(root, "repo");
  const builtin = join(root, "builtin");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "retired.md"), `---\ndescription: Retired\n---\n`);
  await syncBuiltInAgents(repo, builtin);

  await rm(join(repo, "retired.md"));
  assert.deepEqual(await syncBuiltInAgents(repo, builtin), ["retired.md"]);
  await assert.rejects(() => access(join(builtin, "retired.md")));
  await rm(root, { recursive: true, force: true });
});

test("the manifest sits in the built-in dir without becoming an agent", async () => {
  const root = await setupDir();
  const repo = join(root, "repo");
  const builtin = join(root, "builtin");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "general.md"), `---\ndescription: General\n---\n`);
  await syncBuiltInAgents(repo, builtin);

  assert.ok((await readdir(builtin)).includes("manifest.json"));
  const agents = await loadAllAgents({ builtInDir: builtin, customDir: join(root, "none") });
  assert.deepEqual([...agents.keys()], ["general"]);
  await rm(root, { recursive: true, force: true });
});

test("the shipped built-ins parse as agents", async () => {
  // Guards the release artifact itself: a typo in general.md would otherwise only surface at boot.
  const agents = await loadAllAgents({
    builtInDir: join(import.meta.dir, "..", "..", "src", "agents", "builtin"),
    customDir: join("/tmp", "does-not-exist"),
  });
  const general = agents.get("general");
  const research = agents.get("research");
  assert.ok(general, "general.md ships and parses");
  assert.ok(research, "research.md ships and parses");
  assert.equal(general?.meta.base, "general");
  assert.equal(research?.meta.base, "research");
});
