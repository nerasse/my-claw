import { describe, test, expect } from "bun:test";
import { parseAgentFile } from "../../src/agents/loader.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { resolveAgent } from "../../src/agents/resolve.ts";
import { fieldsOfMeta, serializeAgentFile } from "../../src/agents/edit.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { FileAgent } from "../../src/agents/types.ts";

const CONFIG: MyClawConfig = { whitelist: [], blacklist: [], channels: {}, llm: {}, agents: {} };

function parse(text: string, name = "node-web01") {
  return parseAgentFile(text, name, `/agents/${name}.md`);
}

describe("the node agent base", () => {
  test("base: node with a node field is accepted, and the id is kept", () => {
    const parsed = parse(`---
description: Remote node web01
base: node
node: node-1a2b3c4d
---

You work on web01.`);
    if ("rejected" in parsed) throw new Error(`rejected: ${parsed.rejected}`);
    expect(parsed.meta.base).toBe("node");
    expect(parsed.meta.node).toBe("node-1a2b3c4d");
  });

  test("base: node without a node field falls back to general", () => {
    const parsed = parse(`---
description: Remote node web01
base: node
---

Body.`);
    if ("rejected" in parsed) throw new Error(`rejected: ${parsed.rejected}`);
    expect(parsed.meta.base).toBe("general");
    expect(parsed.meta.node).toBeUndefined();
  });

  test("a node field under another base is dropped", () => {
    const parsed = parse(`---
description: Remote node web01
base: research
node: node-1a2b3c4d
---

Body.`);
    if ("rejected" in parsed) throw new Error(`rejected: ${parsed.rejected}`);
    expect(parsed.meta.base).toBe("research");
    expect(parsed.meta.node).toBeUndefined();
  });

  test("the field survives an edit round-trip through the app serializer", () => {
    const fields = fieldsOfMeta({ description: "Remote node", base: "node", node: "node-1a2b3c4d" });
    const text = serializeAgentFile(fields, "Body.");
    expect(text).toContain("node: node-1a2b3c4d");
    const parsed = parse(text);
    if ("rejected" in parsed) throw new Error(`rejected: ${parsed.rejected}`);
    expect(parsed.meta.node).toBe("node-1a2b3c4d");
  });

  test("resolveAgent closes MCP for a node agent and carries the node id", () => {
    const file: FileAgent = {
      name: "node-web01",
      source: "custom",
      path: "/agents/node-web01.md",
      prompt: "You work on web01.",
      meta: { description: "Remote node", base: "node", node: "node-1a2b3c4d", instructions: ["CORE"] },
    };
    const registry = new AgentRegistry(new Map([["node-web01", file]]));
    const resolved = resolveAgent(CONFIG, registry, "node-web01");
    expect(resolved.base).toBe("node");
    expect(resolved.node).toBe("node-1a2b3c4d");
    expect(resolved.mcp).toEqual([]);
  });

  test("getForAgent answers nothing for the node base: the bridge builds the set", () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "read",
      description: "Read",
      parameters: { type: "object" },
      execute: async () => ({ success: true, output: "" }),
    });
    expect(tools.getForAgent("node")).toEqual([]);
  });
});
