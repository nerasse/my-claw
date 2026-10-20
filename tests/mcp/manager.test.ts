import { test } from "bun:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "../../src/mcp/manager.ts";
import { mcpToolName } from "../../src/mcp/transport.ts";
import type { McpServerConfig } from "../../src/core/config.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-server.ts");
const stdioServer = (): McpServerConfig => ({ transport: "stdio", command: "bun", args: [SERVER] });
const DYING_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dying-server.ts");

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

// --- Per-server status (docs/agent-scoping.md, feeds /mcp) ---

test("status reports a connected server with its tool count", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    const [demo] = mgr.status();
    assert.equal(demo?.name, "demo");
    assert.equal(demo?.state, "connected");
    assert.equal(demo?.transport, "stdio");
    assert.equal(demo?.toolCount, 2);
    assert.equal(demo?.lastError, undefined);
    assert.ok(demo?.lastAttemptAt);
  } finally {
    await mgr.stop();
  }
});

test("status keeps a failed server visible, with the reason", async () => {
  // The whole point: a failed connect used to be logged and dropped, so listing live connections
  // hid exactly the servers worth reporting.
  const mgr = new McpManager();
  try {
    await mgr.sync({ broken: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" } });
    assert.deepEqual(mgr.serverNames(), []);
    const [broken] = mgr.status();
    assert.equal(broken?.name, "broken");
    assert.equal(broken?.state, "failed");
    assert.equal(broken?.toolCount, 0);
    assert.ok(broken?.lastError && broken.lastError.length > 0);
  } finally {
    await mgr.stop();
  }
});

test("status reports a declared but disabled server, and disabled outranks a past failure", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ off: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" } });
    assert.equal(mgr.status()[0]?.state, "failed");

    // Switching a broken server off is not a problem to keep reporting.
    await mgr.sync({ off: { transport: "stdio", command: "definitely-not-a-real-binary-xyz", enabled: false } });
    const [off] = mgr.status();
    assert.equal(off?.state, "disabled");
    assert.equal(off?.toolCount, 0);
  } finally {
    await mgr.stop();
  }
});

test("status covers connected and failed side by side, in config order", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({
      broken: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" },
      demo: stdioServer(),
    });
    assert.deepEqual(mgr.status().map((s) => [s.name, s.state]), [["broken", "failed"], ["demo", "connected"]]);
  } finally {
    await mgr.stop();
  }
});

test("status forgets a failure once the server connects", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" } });
    assert.equal(mgr.status()[0]?.state, "failed");
    // Same name, new wiring: the entry is reconnected and the stale reason must not survive.
    await mgr.sync({ demo: stdioServer() });
    const [demo] = mgr.status();
    assert.equal(demo?.state, "connected");
    assert.equal(demo?.lastError, undefined);
  } finally {
    await mgr.stop();
  }
});

test("status drops a server removed from config", async () => {
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: stdioServer() });
    assert.equal(mgr.status().length, 1);
    await mgr.sync({});
    assert.deepEqual(mgr.status(), []);
  } finally {
    await mgr.stop();
  }
});

test("a server that dies is noticed, and its tools stop being offered", async () => {
  // Nothing used to notice. A stdio server that exited kept its tools listed and every call failed
  // one at a time, forever, because the connection was never marked gone.
  const mgr = new McpManager();
  try {
    await mgr.sync({ demo: { transport: "stdio", command: "bun", args: [DYING_SERVER] } });
    assert.equal(mgr.status()[0]?.state, "connected");
    assert.equal(mgr.getTools().length, 1);

    // The fixture exits on its own once told to.
    const quit = mgr.getTools().find((t) => t.name === "mcp__demo__quit")!;
    await quit.execute({}).catch(() => undefined);

    await waitFor(() => mgr.status()[0]?.state === "failed");
    assert.equal(mgr.getTools().length, 0, "a dead server offers nothing");
    assert.equal(mgr.status()[0]?.lastError, "connection lost");
  } finally {
    await mgr.stop();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 25));
  }
}
