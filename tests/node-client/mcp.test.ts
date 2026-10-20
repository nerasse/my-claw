/**
 * The MCP servers a node runs on its own machine -- docs/remote-nodes.md.
 *
 * Exercised against the real stdio fixture the server's own MCP tests use: the node starts it,
 * lists what it offers, and a call travels back through the same dispatch a `node.call` takes.
 */

import { describe, test, expect } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "../../src/core/config.ts";
import { NodeMcpHub } from "../../src/node-client/mcp.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "fixtures", "echo-server.ts");
const IMAGE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "fixtures", "image-server.ts");
const stdioServer = (): McpServerConfig => ({ transport: "stdio", command: "bun", args: [SERVER] });

describe("NodeMcpHub", () => {
  test("a real server comes up, its tools join the manifest, and a call runs there", async () => {
    const hub = new NodeMcpHub({ log: () => {} });
    try {
      await hub.apply({ demo: stdioServer() });
      expect(hub.manifest().map(tool => tool.name).sort()).toEqual(["mcp__demo__boom", "mcp__demo__echo"]);
      expect(hub.manifest().find(tool => tool.name === "mcp__demo__echo")?.description).toContain("Echo");
      expect(hub.statuses()).toEqual([{ name: "demo", ok: true, tools: 2 }]);

      expect(await hub.call("mcp__demo__echo", { text: "hi" })).toEqual({ ok: true, output: "echo: hi" });
      const failed = await hub.call("mcp__demo__boom", {});
      expect(failed?.ok).toBe(false);
      expect(failed?.error).toContain("kaboom");
      // Anything that is not namespaced is not the hub's business.
      expect(await hub.call("bash", { command: "ls" })).toBeNull();
    } finally {
      await hub.closeAll();
    }
  });

  test("a server that cannot start says why, and offers no tool", async () => {
    const hub = new NodeMcpHub({ log: () => {} });
    try {
      await hub.apply({ broken: { transport: "stdio", command: "/nonexistent-mcp-binary" } });
      expect(hub.manifest()).toEqual([]);
      const [status] = hub.statuses();
      expect(status?.name).toBe("broken");
      expect(status?.ok).toBe(false);
      expect(status?.error?.length).toBeGreaterThan(0);
    } finally {
      await hub.closeAll();
    }
  });

  test("a server removed from the list is closed and its tools leave the manifest", async () => {
    const hub = new NodeMcpHub({ log: () => {} });
    try {
      await hub.apply({ demo: stdioServer() });
      expect(hub.manifest()).toHaveLength(2);
      await hub.apply({});
      expect(hub.manifest()).toEqual([]);
      expect(hub.statuses()).toEqual([]);
      expect(await hub.call("mcp__demo__echo", { text: "hi" })).toBeNull();
    } finally {
      await hub.closeAll();
    }
  });

  test("an image an MCP tool returns is uploaded, and reads as an attachment", async () => {
    const uploaded: Array<{ filename: string; bytes: number }> = [];
    const hub = new NodeMcpHub({
      log: () => {},
      upload: async (bytes, filename) => {
        uploaded.push({ filename, bytes: bytes.byteLength });
        return { type: "image", path: `/srv/nodes/files/${filename}`, filename };
      },
    });
    try {
      await hub.apply({ pix: { transport: "stdio", command: "bun", args: [IMAGE_SERVER] } });
      const result = await hub.call("mcp__pix__screenshot", {});
      expect(result?.ok).toBe(true);
      expect(result?.output).toContain("[image attached: image/png]");
      expect(result?.attachments?.[0]).toMatchObject({ type: "image", path: "/srv/nodes/files/pix.png" });
      expect(uploaded[0]?.bytes).toBeGreaterThan(0);
    } finally {
      await hub.closeAll();
    }
  });
});
