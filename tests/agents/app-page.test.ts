import { test } from "bun:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { resolveAgent } from "../../src/agents/resolve.ts";
import type { FileAgent } from "../../src/agents/types.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

function agent(name: string, over: Partial<FileAgent> = {}, meta: Partial<FileAgent["meta"]> = {}): FileAgent {
  return {
    name,
    meta: { description: `${name} agent`, base: "general", instructions: ["CORE", "SOUL", "AGENTS", "USER"], ...meta },
    prompt: "",
    path: `/a/${name}.md`,
    source: "custom",
    ...over,
  };
}

function config(agents: MyClawConfig["agents"] = {}): MyClawConfig {
  return { whitelist: [], blacklist: [], channels: {}, llm: { provider: "t", baseUrl: "u", model: "m" }, agents } as MyClawConfig;
}

test("the config entry wins over the file, which wins over the default", () => {
  const registry = new AgentRegistry(new Map([
    ["writer", agent("writer", {}, { skills: ["a"], mcp: ["srv"], maxIterations: 20, workspace: "proj" })],
  ]));

  const fromFile = resolveAgent(config(), registry, "writer");
  assert.deepEqual(fromFile.skills, ["a"]);
  assert.equal(fromFile.maxIterations, 20);
  assert.equal(fromFile.workspace, "proj");

  // The app and `/model <agent>` both write here, so config has to be the stronger layer.
  const overridden = resolveAgent(config({ writer: { skills: ["b"], maxIterations: 5 } }), registry, "writer");
  assert.deepEqual(overridden.skills, ["b"]);
  assert.equal(overridden.maxIterations, 5);
  assert.equal(overridden.workspace, "proj", "an untouched field still comes from the file");
});

test("a file cannot widen the tool set, only narrow it", () => {
  const registry = new AgentRegistry(new Map([
    // `spawn` is outside the general baseline and `bash` is inside it.
    ["greedy", agent("greedy", {}, { tools: ["bash", "spawn", "memory"] })],
  ]));
  const resolved = resolveAgent(config(), registry, "greedy");
  assert.equal(resolved.base, "general");
  assert.deepEqual(resolved.allow, ["bash", "spawn", "memory"]);
  // The intersection happens in getForAgent; what matters here is that the baseline is unchanged
  // and the allow list is carried as a filter rather than as a grant.
});

test("a research-based agent keeps the read-only baseline its file asked for", () => {
  const registry = new AgentRegistry(new Map([["auditor", agent("auditor", {}, { base: "research" })]]));
  const resolved = resolveAgent(config(), registry, "auditor");
  assert.equal(resolved.base, "research");
  // The research carve-out applies by baseline, not by name: no MCP without an explicit grant.
  assert.deepEqual(resolved.mcp, []);
});

test("an agent nobody defined resolves to the sub-agent baseline, not the orchestrator's", () => {
  const resolved = resolveAgent(config(), new AgentRegistry(), "ghost");
  assert.equal(resolved.base, "general");
  assert.equal(resolved.known, false, "so a caller can report the spawn instead of running it");
});

test("the reserved roles resolve without a file and are never looked up in the registry", () => {
  const registry = new AgentRegistry(new Map([["main", agent("main")], ["cron", agent("cron")]]));
  // Even if such files existed, the loader refuses those names; the resolver must not read them.
  assert.equal(resolveAgent(config(), registry, "main").base, "main");
  assert.equal(resolveAgent(config(), registry, "cron").base, "cron");
  assert.equal(resolveAgent(config(), registry, "main").prompt, undefined);
});

test("listAll marks the tier so the page can show where an agent comes from", () => {
  const registry = new AgentRegistry(new Map([
    ["shipped", agent("shipped", { source: "built-in" })],
    ["proj/local", agent("local", { source: "workspace", layer: "proj" })],
  ]));
  const rows = registry.listAll();
  assert.deepEqual(rows.map((r) => r.name), ["local", "shipped"]);
  assert.equal(rows.find((r) => r.name === "local")?.layer, "proj");
  assert.equal(rows.find((r) => r.name === "shipped")?.source, "built-in");
});
