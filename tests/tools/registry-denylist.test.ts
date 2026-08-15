import { test } from "bun:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { resolveAgentMcp } from "../../src/core/config.ts";
import { applyHotReload } from "../../src/core/config-watcher.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { AgentToolType, MyClawConfig } from "../../src/core/config.ts";

function stub(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "" }),
  };
}

function registry(names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) r.register(stub(n));
  return r;
}

test("getForAgent without a denylist returns the full main set", () => {
  const r = registry(["read", "write", "bash", "browser"]);
  assert.equal(r.getForAgent("main").length, 4);
});

test("denylist filters tools out of the main set", () => {
  const r = registry(["read", "write", "bash", "browser"]);
  const names = r.getForAgent("main", ["browser", "bash"]).map((t) => t.name);
  assert.deepEqual(names.sort(), ["read", "write"]);
});

test("denylist stacks on top of the per-agent exclusion (research is read-only)", () => {
  const r = registry(["read", "search", "ls", "fetch", "web_search", "list_skills", "read_skill", "write", "bash"]);
  const research = r.getForAgent("research", ["fetch"]).map((t) => t.name);
  assert.ok(research.includes("read"));
  assert.ok(!research.includes("fetch"), "denylist removes fetch even from the read-only set");
  assert.ok(!research.includes("bash"), "research never exposes write tools");
});

test("an unknown disabled name is a harmless no-op", () => {
  const r = registry(["read", "write"]);
  assert.equal(r.getForAgent("main", ["does-not-exist"]).length, 2);
});

test("an agent name the chain does not know falls back to the sub-agent set, not the full one", () => {
  // The cast is the point: file-defined agents will hand this method names that no union covers,
  // and a typo must not be the difference between a sandboxed agent and a privileged one.
  const r = registry(["read", "write", "bash", "spawn", "memory", "manage_skills"]);
  const names = r.getForAgent("reviewer" as AgentToolType).map((t) => t.name);
  assert.ok(names.includes("read"));
  assert.ok(names.includes("bash"), "an unknown agent still gets the general baseline");
  for (const escalation of ["spawn", "memory", "manage_skills"]) {
    assert.ok(!names.includes(escalation), `an unknown agent must not receive ${escalation}`);
  }
});

function baseConfig(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: { provider: "p", baseUrl: "https://e.com", model: "m" },
    agents: {},
  };
}

test("tools section hot-reloads in place, preserving object identity", () => {
  const current = baseConfig();
  current.tools = { disabled: [] };
  const toolsRef = current.tools;

  const next = baseConfig();
  next.tools = { disabled: ["browser"] };

  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("tools"));
  assert.equal(current.tools, toolsRef, "tools reference must be preserved for live reads");
  assert.deepEqual(current.tools.disabled, ["browser"]);
});

test("adding a tools denylist at runtime is a hot change", () => {
  const current = baseConfig();
  const next = baseConfig();
  next.tools = { disabled: ["cron"] };

  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("tools"));
  assert.deepEqual(current.tools?.disabled, ["cron"]);
  assert.ok(!result.rebootRequired.includes("tools"));
});

// ── dynamic provider (external MCP tools) ────────────────────────────────────

const readOnlySet = ["read", "search", "ls", "fetch", "web_search", "list_skills", "read_skill", "bash"];

test("dynamic provider tools are added for every agent class the scope allows", () => {
  const r = registry(readOnlySet);
  r.setDynamicProvider(() => [stub("mcp__demo__echo")]);

  for (const type of ["main", "general", "cron", "research"] as const) {
    assert.ok(r.getForAgent(type).some((t) => t.name === "mcp__demo__echo"), type);
  }
});

test("research gets no MCP by default, but the rule now lives in resolveAgentMcp", () => {
  // It used to be hardcoded here. Moving it means the registry obeys whatever scope it is handed,
  // and the negative default for research is a config resolution decision instead.
  const r = registry(readOnlySet);
  r.setDynamicProvider(() => [stub("mcp__demo__echo")]);
  const config: MyClawConfig = { ...baseConfig(), agents: { orchestrator: { mcp: ["*"] } } };

  const scope = resolveAgentMcp(config, "research");
  assert.deepEqual(scope, []);
  assert.ok(!r.getForAgent("research", [], scope).some((t) => t.name === "mcp__demo__echo"));
  assert.ok(r.getForAgent("main", [], resolveAgentMcp(config, "main")).some((t) => t.name === "mcp__demo__echo"));
});

test("mcp scope filters by server, one server at a time", () => {
  const r = registry(["read"]);
  r.setDynamicProvider(() => [stub("mcp__alpha__a"), stub("mcp__beta__b"), stub("plain_plugin")]);

  const names = r.getForAgent("main", [], ["alpha"]).map((t) => t.name);
  assert.ok(names.includes("mcp__alpha__a"));
  assert.ok(!names.includes("mcp__beta__b"));
  // A plugin is not an MCP server: the scope must leave it alone or the same list would silently
  // gate owner-authored tools too.
  assert.ok(names.includes("plain_plugin"));
  assert.ok(names.includes("read"));
});

test("mcp scope: empty means no server, wildcard resolves to all upstream", () => {
  const r = registry(["read"]);
  r.setDynamicProvider(() => [stub("mcp__alpha__a")]);
  assert.ok(!r.getForAgent("main", [], []).some((t) => t.name === "mcp__alpha__a"));
  assert.ok(r.getForAgent("main", [], "all").some((t) => t.name === "mcp__alpha__a"));
});

test("denylist can disable a dynamic MCP tool by full name", () => {
  const r = registry(["read"]);
  r.setDynamicProvider(() => [stub("mcp__demo__echo")]);
  assert.ok(!r.getForAgent("main", ["mcp__demo__echo"]).some((t) => t.name === "mcp__demo__echo"));
});

test("get() resolves a dynamic MCP tool for execution", () => {
  const r = registry(["read"]);
  r.setDynamicProvider(() => [stub("mcp__demo__echo")]);
  assert.equal(r.get("mcp__demo__echo")?.name, "mcp__demo__echo");
  assert.equal(r.get("read")?.name, "read");
  assert.equal(r.get("nope"), undefined);
});

test("mcp section hot-reloads in place and is not reboot-only", () => {
  const current = baseConfig();
  const next = baseConfig();
  next.mcp = { weather: { transport: "http", url: "https://example.com/mcp" } };

  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("mcp"));
  assert.ok(!result.rebootRequired.includes("mcp"));
  assert.equal(current.mcp?.weather?.url, "https://example.com/mcp");
});
