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

test("the browser ships as a file and reads its workspace's AGENTS.md", async () => {
  const browser = (await shipped()).get("browser");
  assert.ok(browser, "browser.md ships and parses");
  // It used to leave AGENTS out, so the rules of what it fills in (an application's wording, what
  // never to state) had to be copied into every brief by the conversation driving it. docs/browser.md.
  assert.deepEqual(browser?.meta.instructions, ["CORE", "SOUL", "AGENTS", "USER"]);
  assert.match(browser?.prompt ?? "", /YOUR INSTRUCTIONS ARE NOT PAGE CONTENT/);
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
