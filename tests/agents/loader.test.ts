import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  loadAllAgents,
  parseAgentFile,
  agentNameOf,
  MAX_AGENTS_PER_TIER,
  MAX_AGENT_BYTES,
  MAX_DESCRIPTION_LENGTH,
  type AgentDirs,
} from "../../src/agents/loader.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";

async function setupDir(): Promise<string> {
  const dir = join("/tmp", `agents-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeAgent(dir: string, file: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
}

function dirs(root: string): AgentDirs {
  return { builtInDir: join(root, "builtin"), customDir: join(root, "custom") };
}

const MINIMAL = `---
description: Does one thing
---

Body.`;

test("the name comes from the filename, never from a frontmatter field", async () => {
  const root = await setupDir();
  // A `name:` field would be the skills trap: registry keyed on frontmatter, addressed by path.
  await writeAgent(join(root, "custom"), "reviewer.md", `---
name: something-else
description: Reviews diffs
---

Review.`);

  const agents = await loadAllAgents(dirs(root));
  assert.ok(agents.has("reviewer"));
  assert.equal(agents.size, 1);
  await rm(root, { recursive: true, force: true });
});

test("only the description is required; everything else has a default", async () => {
  const parsed = parseAgentFile(MINIMAL, "minimal", "/tmp/minimal.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  assert.equal(parsed.meta.base, "general");
  assert.deepEqual(parsed.meta.instructions, ["CORE", "SOUL", "AGENTS", "USER"]);
  assert.equal(parsed.meta.tools, undefined, "absent tools means the whole baseline");
  assert.equal(parsed.prompt, "Body.");
});

test("a file without a description does not define an agent", async () => {
  const parsed = parseAgentFile(`---\nbase: research\n---\n\nBody.`, "x", "/tmp/x.md");
  assert.ok("rejected" in parsed && parsed.rejected === "no-description");
});

test("a file without frontmatter does not define an agent", async () => {
  const parsed = parseAgentFile("Just a prompt, no header.", "x", "/tmp/x.md");
  assert.ok("rejected" in parsed && parsed.rejected === "no-frontmatter");
});

test("reserved role names are refused", () => {
  for (const reserved of ["orchestrator.md", "cron.md", "main.md"]) {
    const resolved = agentNameOf(reserved);
    assert.ok("rejected" in resolved && resolved.rejected === "reserved-name", reserved);
  }
});

test("a name that is not typeable is refused rather than registered", () => {
  for (const bad of ["My Agent.md", "UPPER.md", "trailing-.md", "agent.txt"]) {
    assert.ok("rejected" in agentNameOf(bad), bad);
  }
  assert.deepEqual(agentNameOf("code-reviewer-2.md"), { name: "code-reviewer-2" });
});

test("lists are comma-separated and a wildcard becomes the all scope", () => {
  const parsed = parseAgentFile(`---
description: d
tools: read, grep , find
skills: *
mcp: alpha, beta
---
`, "x", "/tmp/x.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  assert.deepEqual(parsed.meta.tools, ["read", "grep", "find"]);
  assert.equal(parsed.meta.skills, "all");
  assert.deepEqual(parsed.meta.mcp, ["alpha", "beta"]);
});

test("an empty list is nothing, not unset", () => {
  const parsed = parseAgentFile(`---\ndescription: d\nmcp:\n---\n`, "x", "/tmp/x.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  // Reading `mcp:` as absent would grant every server to an agent meant to have none.
  assert.deepEqual(parsed.meta.mcp, []);
});

test("instructions select prompt layers and keep the builder's order", () => {
  const parsed = parseAgentFile(`---\ndescription: d\ninstructions: user, core\n---\n`, "x", "/tmp/x.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  assert.deepEqual(parsed.meta.instructions, ["CORE", "USER"]);
});

test("instructions: none drops every workspace layer", () => {
  const parsed = parseAgentFile(`---\ndescription: d\ninstructions: none\n---\n`, "x", "/tmp/x.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  assert.deepEqual(parsed.meta.instructions, []);
});

test("an unknown base falls back to general instead of guessing read-only", () => {
  const parsed = parseAgentFile(`---\ndescription: d\nbase: nonsense\n---\n`, "x", "/tmp/x.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  assert.equal(parsed.meta.base, "general");
});

test("a file over the size cap is refused", () => {
  const huge = `---\ndescription: d\n---\n\n${"x".repeat(MAX_AGENT_BYTES)}`;
  const parsed = parseAgentFile(huge, "x", "/tmp/x.md");
  assert.ok("rejected" in parsed && parsed.rejected === "too-large");
});

test("an overlong description is truncated, not rejected: it rides in every prompt", () => {
  const parsed = parseAgentFile(`---\ndescription: ${"d".repeat(MAX_DESCRIPTION_LENGTH + 50)}\n---\n`, "x", "/tmp/x.md");
  assert.ok(!("rejected" in parsed));
  if ("rejected" in parsed) return;
  assert.equal(parsed.meta.description.length, MAX_DESCRIPTION_LENGTH);
});

test("a higher tier replaces a lower one wholesale, it does not merge fields", async () => {
  const root = await setupDir();
  await writeAgent(join(root, "builtin"), "general.md", `---
description: Built-in general
base: general
model: builtin-model
---

Built-in body.`);
  await writeAgent(join(root, "custom"), "general.md", `---
description: My general
---

My body.`);

  const agents = await loadAllAgents(dirs(root));
  const general = agents.get("general");
  assert.equal(general?.meta.description, "My general");
  assert.equal(general?.prompt, "My body.");
  // Extension would have kept the built-in's model. Replacement does not.
  assert.equal(general?.meta.model, undefined);
  assert.equal(general?.source, "custom");
  await rm(root, { recursive: true, force: true });
});

test("the same name in two workspaces does not collide globally", async () => {
  const root = await setupDir();
  const a = join(root, "wsA");
  const b = join(root, "wsB");
  await writeAgent(a, "helper.md", `---\ndescription: A helper\n---\n`);
  await writeAgent(b, "helper.md", `---\ndescription: B helper\n---\n`);

  const registry = new AgentRegistry(await loadAllAgents({
    ...dirs(root),
    workspaces: [{ key: "wsA", dir: a }, { key: "wsB", dir: b }],
  }));

  assert.equal(registry.get("helper", "wsA")?.meta.description, "A helper");
  assert.equal(registry.get("helper", "wsB")?.meta.description, "B helper");
  await rm(root, { recursive: true, force: true });
});

test("a workspace never sees another workspace's agents", async () => {
  const root = await setupDir();
  await writeAgent(join(root, "custom"), "shared.md", `---\ndescription: Global\n---\n`);
  const a = join(root, "wsA");
  await writeAgent(a, "only-a.md", `---\ndescription: A only\n---\n`);

  const registry = new AgentRegistry(await loadAllAgents({
    ...dirs(root),
    workspaces: [{ key: "wsA", dir: a }],
  }));

  const namesB = registry.list("wsB").map((agent) => agent.name);
  assert.ok(namesB.includes("shared"));
  assert.ok(!namesB.includes("only-a"));
  await rm(root, { recursive: true, force: true });
});

test("the per-tier cap drops the overflow instead of inflating every prompt", async () => {
  const root = await setupDir();
  for (let i = 0; i < MAX_AGENTS_PER_TIER + 5; i++) {
    await writeAgent(join(root, "custom"), `agent-${String(i).padStart(3, "0")}.md`, `---\ndescription: d${i}\n---\n`);
  }
  const agents = await loadAllAgents(dirs(root));
  assert.equal(agents.size, MAX_AGENTS_PER_TIER);
  await rm(root, { recursive: true, force: true });
});

test("non-markdown files and the builtin manifest are ignored", async () => {
  const root = await setupDir();
  await writeAgent(join(root, "custom"), "real.md", MINIMAL);
  await writeAgent(join(root, "custom"), "manifest.json", "{}");
  await writeAgent(join(root, "custom"), "notes.txt", "hello");
  const agents = await loadAllAgents(dirs(root));
  assert.deepEqual([...agents.keys()], ["real"]);
  await rm(root, { recursive: true, force: true });
});

test("the listing is sorted so the spawn enum does not reorder between runs", async () => {
  const root = await setupDir();
  for (const name of ["zebra", "alpha", "middle"]) {
    await writeAgent(join(root, "custom"), `${name}.md`, `---\ndescription: ${name}\n---\n`);
  }
  const registry = new AgentRegistry(await loadAllAgents(dirs(root)));
  assert.deepEqual(registry.list().map((agent) => agent.name), ["alpha", "middle", "zebra"]);
  await rm(root, { recursive: true, force: true });
});
