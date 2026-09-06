import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllAgents } from "../../src/agents/loader.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";

const BUILTIN = join(import.meta.dir, "..", "..", "src", "agents", "builtin");

async function shipped(): Promise<AgentRegistry> {
  return new AgentRegistry(await loadAllAgents({
    builtInDir: BUILTIN,
    customDir: join(tmpdir(), "no-such-agents-dir"),
  }));
}

test("the browser ships as a file and keeps its AGENTS.md omission as a field", async () => {
  const browser = (await shipped()).get("browser");
  assert.ok(browser, "browser.md ships and parses");
  // The hardcoded second prompt builder expressed this by listing SOUL and USER by hand.
  assert.deepEqual(browser?.meta.instructions, ["CORE", "SOUL", "USER"]);
  assert.ok(!browser?.meta.instructions.includes("AGENTS"), "a workspace AGENTS.md is not the browser's business");
  assert.match(browser?.prompt ?? "", /You are a web browsing assistant/);
  assert.match(browser?.prompt ?? "", /DISMISS OVERLAYS FIRST/);
  // Its toolbox is the browser base, closed by construction; its budget is the file's until
  // `browser.maxSteps` says otherwise.
  assert.equal(browser?.meta.base, "browser");
  assert.equal(browser?.meta.maxIterations, 60);
});

test("the browser is not offered as a spawn target, but stays a real entry", async () => {
  const registry = await shipped();
  // Spawning it would produce an agent with the browser's prompt and none of its tools: those
  // live in a private registry its own runner builds.
  assert.ok(!registry.list().some((a) => a.name === "browser"));
  // It is still resolvable and still listed by the browse surfaces, or editing it would be blind.
  assert.ok(registry.get("browser"));
  assert.ok(registry.listAll().some((a) => a.name === "browser"));
  assert.ok(registry.names().includes("browser"));
});

test("the spawn catalog is exactly the agents a spawn can create", async () => {
  assert.deepEqual((await shipped()).list().map((a) => a.name), ["general", "research"]);
});
