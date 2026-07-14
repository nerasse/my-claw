import { test } from "bun:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { applyHotReload } from "../../src/core/config-watcher.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

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
  const r = registry(["read", "grep", "find", "ls", "fetch", "web_search", "list_skills", "read_skill", "write", "bash"]);
  const research = r.getForAgent("research", ["fetch"]).map((t) => t.name);
  assert.ok(research.includes("read"));
  assert.ok(!research.includes("fetch"), "denylist removes fetch even from the read-only set");
  assert.ok(!research.includes("bash"), "research never exposes write tools");
});

test("an unknown disabled name is a harmless no-op", () => {
  const r = registry(["read", "write"]);
  assert.equal(r.getForAgent("main", ["does-not-exist"]).length, 2);
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

test("dynamic provider tools are added for acting agents but not research", () => {
  const r = registry(["read", "grep", "find", "ls", "fetch", "web_search", "list_skills", "read_skill", "bash"]);
  r.setDynamicProvider(() => [stub("mcp__demo__echo")]);

  assert.ok(r.getForAgent("main").some((t) => t.name === "mcp__demo__echo"));
  assert.ok(r.getForAgent("general").some((t) => t.name === "mcp__demo__echo"));
  assert.ok(r.getForAgent("cron").some((t) => t.name === "mcp__demo__echo"));
  assert.ok(!r.getForAgent("research").some((t) => t.name === "mcp__demo__echo"),
    "read-only research agent must not see external MCP tools");
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
