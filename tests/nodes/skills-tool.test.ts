import { describe, test, expect, beforeEach } from "bun:test";
import { rm } from "node:fs/promises";
import { composeSystemPrompt } from "../../src/agent/prompt/builder.ts";
import { nodeServerToolsFor, nodeToolsFor } from "../../src/nodes/tools.ts";
import { attachNodeSocket, handleNodeFrame, resetNodeHub } from "../../src/nodes/hub.ts";
import { mintNode, nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSkillsTool } from "../../src/tools/skills.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";
import type { ServerWebSocket } from "bun";
import type { NodeSocketData } from "../../src/nodes/hub.ts";
import type { Tool } from "../../src/tools/types.ts";

/**
 * The invariant this file exists for: the prompt and the tool set must agree.
 *
 * Layer 5 of the system prompt lists every skill in the agent's scope and says it MUST call
 * `skills(name)` to load one. A node agent's set was the machine's manifest alone, so it was told
 * to call a tool it did not hold -- for every node, on every run, since the base existed.
 */

const CONFIG: MyClawConfig = { whitelist: [], blacklist: [], channels: {}, llm: {}, agents: {} };

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "user",
  version: "0.1.0",
  tools: [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
  ],
};

function stub(name: string): Tool {
  return { name, description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) };
}

function registryWithSkills(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createSkillsTool(new SkillRegistry(), CONFIG, {
    builtinDir: "/nonexistent/builtin",
    customDir: "/nonexistent/custom",
    workspaceSkillsDir: "/nonexistent/workspace",
  }));
  for (const name of ["read", "bash", "write", "memory"]) registry.register(stub(name));
  return registry;
}

function connect(nodeId: string): void {
  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: () => undefined,
    close: () => undefined,
  } as unknown as ServerWebSocket<NodeSocketData>;
  attachNodeSocket(ws);
  handleNodeFrame(ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
}

async function paired(): Promise<string> {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error(minted.error);
  connect(minted.minted.record.nodeId);
  return minted.minted.record.nodeId;
}

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  resetNodeHub();
});

describe("a node agent and the skills catalog", () => {
  test("the set carries skills, so the layer-5 instruction has a tool behind it", async () => {
    const nodeId = await paired();
    const tools = nodeToolsFor(nodeId, { serverTools: nodeServerToolsFor(registryWithSkills()) });
    expect(tools?.map((t) => t.name)).toContain("skills");
  });

  test("it is the read-only shape: the writes stay the orchestrator's", async () => {
    const nodeId = await paired();
    const tools = nodeToolsFor(nodeId, { serverTools: nodeServerToolsFor(registryWithSkills()) }) ?? [];
    const skills = tools.find((t) => t.name === "skills");
    expect(skills).toBeDefined();
    const action = (skills!.parameters["properties"] as Record<string, { enum?: string[] }>)["action"];
    expect(action?.enum).toBeUndefined();

    const refused = await skills!.execute({ action: "create", name: "x", description: "d", instructions: "i" });
    expect(refused.success).toBe(false);
    expect(refused.output).toContain("Only the orchestrator writes skills");
  });

  test("a file's tools: stays the ceiling: naming read and bash does not hand out skills", async () => {
    const nodeId = await paired();
    const tools = nodeToolsFor(nodeId, {
      allow: ["read", "bash"],
      serverTools: nodeServerToolsFor(registryWithSkills()),
    });
    expect(tools?.map((t) => t.name)).toEqual(["read", "bash"]);
  });

  test("the config denylist still removes it", async () => {
    const nodeId = await paired();
    const tools = nodeToolsFor(nodeId, {
      disabled: ["skills"],
      serverTools: nodeServerToolsFor(registryWithSkills()),
    });
    expect(tools?.map((t) => t.name)).not.toContain("skills");
  });

  test("a registry without the tool adds nothing rather than inventing one", async () => {
    const nodeId = await paired();
    const bare = new ToolRegistry();
    expect(nodeServerToolsFor(bare)).toEqual([]);
    const tools = nodeToolsFor(nodeId, { serverTools: nodeServerToolsFor(bare) });
    expect(tools?.map((t) => t.name)).toEqual(["read", "bash", "send_file_to_node"]);
  });

  test("the prompt layer that lists skills is the reason the set must carry the tool", async () => {
    // The general shape of the bug, not its node instance: whenever the catalog is advertised, the
    // tool it names has to be in the set. A future base that loses `skills` fails here.
    const parts = await composeSystemPrompt({
      platform: "my-claw-app",
      model: "m",
      sessionId: "s",
      skills: [{ name: "remote-nodes", description: "d", source: "built-in", path: "/p" }],
    });
    const advertised = parts.find((part) => part.id === "skills")?.text ?? "";
    expect(advertised).toContain("skills(name)");
    expect(advertised).toContain("remote-nodes");

    const nodeId = await paired();
    const tools = nodeToolsFor(nodeId, { serverTools: nodeServerToolsFor(registryWithSkills()) }) ?? [];
    expect(tools.map((tool) => tool.name)).toContain("skills");
  });
});
