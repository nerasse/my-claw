import { test } from "bun:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "../../src/mcp/manager.ts";
import { mcpToolName } from "../../src/mcp/connection.ts";
import type { McpServerConfig } from "../../src/core/config.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-server.ts");
const stdioServer = (): McpServerConfig => ({ transport: "stdio", command: "bun", args: [SERVER] });

test("mcpToolName namespaces to avoid collisions", () => {
  assert.equal(mcpToolName("weather", "forecast"), "mcp__weather__forecast");
});

test("manager connects a stdio server and adapts its tools", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    const tools = mgr.getTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["mcp__demo__boom", "mcp__demo__echo"]);
    assert.ok(tools.find((t) => t.name === "mcp__demo__echo")!.description.includes("Echo"));
  } finally {
    await mgr.stop();
  }
});

test("adapted tool executes a real MCP call", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    const echo = mgr.getTools().find((t) => t.name === "mcp__demo__echo")!;
    const res = await echo.execute({ text: "hi" });
    assert.equal(res.success, true);
    assert.equal(res.output, "echo: hi");
  } finally {
    await mgr.stop();
  }
});

test("a tool that reports isError maps to a failed ToolResult", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    const boom = mgr.getTools().find((t) => t.name === "mcp__demo__boom")!;
    const res = await boom.execute({});
    assert.equal(res.success, false);
    assert.ok(res.output.includes("kaboom"));
  } finally {
    await mgr.stop();
  }
});

test("sync removes a server that is dropped from config", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    assert.equal(mgr.serverNames().length, 1);
    await mgr.sync({});
    assert.equal(mgr.serverNames().length, 0);
    assert.equal(mgr.getTools().length, 0);
  } finally {
    await mgr.stop();
  }
});

test("sync leaves an unchanged server connected (no needless reconnect)", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    const before = mgr.getTools().find((t) => t.name === "mcp__demo__echo");
    await mgr.sync({ demo: stdioServer() });
    const after = mgr.getTools().find((t) => t.name === "mcp__demo__echo");
    // Same identity: the connection object was reused, so the adapted tool object is the same.
    assert.equal(before, after);
  } finally {
    await mgr.stop();
  }
});

test("a disabled server is not connected", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: { ...stdioServer(), enabled: false } });
    assert.equal(mgr.serverNames().length, 0);
  } finally {
    await mgr.stop();
  }
});

test("a failing server does not throw and leaves the manager usable", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ bad: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" } });
    assert.equal(mgr.serverNames().length, 0);
    // Manager still works for a good server afterwards.
    await mgr.sync({ demo: stdioServer() });
    assert.equal(mgr.serverNames().length, 1);
  } finally {
    await mgr.stop();
  }
});
