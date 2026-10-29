/**
 * `agents`: list, kill and reset of the persistent sub-agents, as one tool -- docs/subagents.md.
 *
 * They were three tools of one shape (an id, or nothing), called rarely and always together in the
 * owner's mind. Three definitions on every request of the orchestrator for that is what went
 * (2026-10-04). `spawn` and `send` stay their own: they are the hot path, with rich arguments.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAgentsTool } from "../../src/tools/agents.ts";
import type { SubAgentRunner } from "../../src/subagents/runner.ts";
import type { SubAgentRegistry } from "../../src/subagents/registry.ts";

function harness() {
  const calls: string[] = [];
  const runner = {
    list: async (_registry: unknown, caller: string) => {
      calls.push(`list ${caller}`);
      return [
        { id: "subagent/a-1", displayName: "a", type: "general", messageCount: 3, status: "idle", visibility: "global" },
        { id: "subagent/b-2", displayName: "b", type: "research", messageCount: 0, status: "running", visibility: "workspace", workspaceKey: "dev" },
      ];
    },
    kill: async (id: string, caller: string) => {
      calls.push(`kill ${id} ${caller}`);
      return id === "subagent/gone" ? "Error: Sub-agent subagent/gone not found" : `Killed ${id}`;
    },
    inspect: async (id: string, _registry: unknown, caller: string) => {
      calls.push(`inspect ${id} ${caller}`);
      if (id === "subagent/gone") return undefined;
      return {
        id: "subagent/a-1", displayName: "a", type: "general", messageCount: 3, status: "idle",
        visibility: "global", createdAt: new Date().toISOString(), lifecycle: "failed",
        lastTool: { name: "bash", ok: true }, resumable: true,
        nextActions: ["send(id) to resume", "send(id, message)"],
      };
    },
    reset: async (id: string, caller: string) => {
      calls.push(`reset ${id} ${caller}`);
      return `Reset ${id}`;
    },
  } as unknown as SubAgentRunner;
  return { tool: createAgentsTool(runner, {} as SubAgentRegistry), calls };
}

test("list names what this conversation can reach, scope included", async () => {
  const { tool, calls } = harness();
  const result = await tool.execute({ action: "list", __sessionId: "s1" });
  assert.equal(result.success, true);
  assert.match(result.output, /subagent\/a-1 \| a \| general \| 3 messages \| idle \| global/);
  assert.match(result.output, /subagent\/b-2 \| b \| research \| 0 messages \| running \| workspace:dev/);
  assert.deepEqual(calls, ["list s1"]);
});

test("kill and reset act on the id they are given, for the caller that asked", async () => {
  const { tool, calls } = harness();
  assert.deepEqual(await tool.execute({ action: "kill", id: "subagent/a-1", __sessionId: "s1" }), { success: true, output: "Killed subagent/a-1", error: undefined });
  assert.equal((await tool.execute({ action: "reset", id: "subagent/b-2", __sessionId: "s1" })).output, "Reset subagent/b-2");
  assert.deepEqual(calls, ["kill subagent/a-1 s1", "reset subagent/b-2 s1"]);
});

test("a refusal of the runner is a failure, with its words", async () => {
  const { tool } = harness();
  const result = await tool.execute({ action: "kill", id: "subagent/gone", __sessionId: "s1" });
  assert.equal(result.success, false);
  assert.equal(result.error, "Error: Sub-agent subagent/gone not found");
});

test("kill and reset without an id touch nothing, and say what is missing", async () => {
  const { tool, calls } = harness();
  for (const action of ["kill", "reset"]) {
    const result = await tool.execute({ action, __sessionId: "s1" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /id/);
  }
  assert.deepEqual(calls, []);
});

test("an action it does not know is refused, not taken for a list", async () => {
  const { tool, calls } = harness();
  const result = await tool.execute({ action: "delete", id: "subagent/a-1" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /list, inspect, kill or reset/);
  assert.deepEqual(calls, []);
});

test("the schema names the actions, and only `action` is required", () => {
  const { tool } = harness();
  const props = (tool.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] }).properties;
  assert.deepEqual(props["action"]!.enum, ["list", "inspect", "kill", "reset"]);
  assert.deepEqual((tool.parameters as { required: string[] }).required, ["action"]);
});

test("inspect needs an id, and says so instead of listing", async () => {
  const { tool, calls } = harness();
  const result = await tool.execute({ action: "inspect", __sessionId: "s1" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /id/);
  assert.deepEqual(calls, []);
});

test("inspect describes the agent the runner knows, and refuses one it does not", async () => {
  const { tool, calls } = harness();
  const detail = await tool.execute({ action: "inspect", id: "subagent/a-1", __sessionId: "s1" });
  assert.equal(detail.success, true);
  assert.match(detail.output, /subagent\/a-1 \| a \| general/);
  assert.match(detail.output, /state: failed/);
  assert.match(detail.output, /last tool: bash \(ok\)/);
  assert.match(detail.output, /resumable: yes/);
  assert.match(detail.output, /next: send\(id\) to resume/);
  assert.deepEqual(calls, ["inspect subagent/a-1 s1"]);

  const missing = await tool.execute({ action: "inspect", id: "subagent/gone", __sessionId: "s1" });
  assert.equal(missing.success, false);
  assert.match(missing.error ?? "", /not found/);
});

/**
 * A long install has dozens of shared workers. The filters and the page are what let a parent find
 * the one it just drove; none of them may change what an unfiltered `list` returns.
 */
test("list filters on what the roster carries, and pages with a footer that names the total", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `subagent/w-${i}`, displayName: `w${i}`, type: i % 2 === 0 ? "general" : "research",
    messageCount: 1, status: i < 5 ? "running" : "idle", visibility: "global" as const,
  }));
  const runner = { list: async () => many } as unknown as SubAgentRunner;
  const tool = createAgentsTool(runner, {} as SubAgentRegistry);

  const filtered = await tool.execute({ action: "list", query: "RESEARCH", __sessionId: "s1" });
  assert.equal(filtered.success, true);
  assert.match(filtered.output, /subagent\/w-1 /);
  assert.doesNotMatch(filtered.output, /subagent\/w-2 /);
  assert.equal(filtered.output.split("\n").filter((l) => l.startsWith("- ")).length, 30, "only the research half");
  assert.doesNotMatch(filtered.output, /Next page/, "a complete result needs no page footer");

  const running = await tool.execute({ action: "list", status: "running", __sessionId: "s1" });
  assert.equal(running.output.split("\n").filter((l) => l.startsWith("- ")).length, 5);

  const paged = await tool.execute({ action: "list", limit: 10, __sessionId: "s1" });
  assert.equal(paged.output.split("\n").filter((l) => l.startsWith("- ")).length, 10);
  assert.match(paged.output, /10 of 60 matching agents\. Next page: offset=10\./);

  const second = await tool.execute({ action: "list", limit: 10, offset: 10, __sessionId: "s1" });
  assert.match(second.output, /subagent\/w-10 /);
  assert.match(second.output, /offset=20/);

  const none = await tool.execute({ action: "list", query: "nothing-like-it", __sessionId: "s1" });
  assert.match(none.output, /No agent matches those filters/);
});
