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
  assert.match(result.error ?? "", /list, kill or reset/);
  assert.deepEqual(calls, []);
});

test("the schema says which action wants the id", () => {
  const { tool } = harness();
  const props = (tool.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] }).properties;
  assert.deepEqual(props["action"]!.enum, ["list", "kill", "reset"]);
  assert.deepEqual((tool.parameters as { required: string[] }).required, ["action"]);
});
