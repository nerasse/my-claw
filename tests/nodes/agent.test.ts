import { describe, test, expect, beforeEach } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { nodeAgentsDir, removeNodeAgent, writeNodeAgent } from "../../src/nodes/agent.ts";
import { parseAgentFile } from "../../src/agents/loader.ts";
import type { NodeFacts, NodeRecord } from "../../src/nodes/types.ts";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "admin",
  version: "0.1.0",
  tools: [{ name: "bash", description: "Run a command", parameters: { type: "object" } }],
};

function record(nodeId: string, name: string): NodeRecord {
  return { nodeId, name, tokenHash: "x", createdAt: new Date().toISOString(), facts: FACTS };
}

beforeEach(async () => {
  await rm(join(MY_CLAW_DIR, "agents"), { recursive: true, force: true });
});

describe("node agent files", () => {
  test("the generated file parses as a node agent, with the machine named in the description", async () => {
    const name = await writeNodeAgent(record("node-1a2b3c4d", "Web 01"), FACTS);
    expect(name).toBe("node-web-01");

    const text = await readFile(join(nodeAgentsDir(), `${name}.md`), "utf-8");
    const parsed = parseAgentFile(text, name, "test");
    if ("rejected" in parsed) throw new Error(`rejected: ${parsed.rejected}`);
    expect(parsed.meta.base).toBe("node");
    expect(parsed.meta.node).toBe("node-1a2b3c4d");
    expect(parsed.meta.description).toContain("Web 01");
    expect(parsed.meta.description).toContain("bash");
    expect(parsed.prompt).toContain("Web 01");
  });

  test("a name already taken by another node moves to the next suffix", async () => {
    const first = await writeNodeAgent(record("node-aaaaaaaa", "web01"), FACTS);
    const second = await writeNodeAgent(record("node-bbbbbbbb", "web01"), FACTS);
    expect(first).toBe("node-web01");
    expect(second).toBe("node-web01-2");
  });

  test("re-pairing the same node keeps the owner's edits", async () => {
    const name = await writeNodeAgent(record("node-1a2b3c4d", "web01"), FACTS);
    const path = join(nodeAgentsDir(), `${name}.md`);
    const edited = (await readFile(path, "utf-8")).replace("Complete this description", "Owner text");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, edited);

    const again = await writeNodeAgent(record("node-1a2b3c4d", "web01"), FACTS);
    expect(again).toBe(name);
    expect(await readFile(path, "utf-8")).toContain("Owner text");
  });

  test("a revoke removes only the file that declares that node", async () => {
    const mine = await writeNodeAgent(record("node-1a2b3c4d", "web01"), FACTS);
    const other = await writeNodeAgent(record("node-ffffffff", "web01"), FACTS);
    expect(await removeNodeAgent("node-1a2b3c4d")).toBe(true);

    const { access } = await import("node:fs/promises");
    await expect(access(join(nodeAgentsDir(), `${mine}.md`))).rejects.toBeDefined();
    await access(join(nodeAgentsDir(), `${other}.md`));
    expect(await removeNodeAgent("node-1a2b3c4d")).toBe(false);
  });
});
