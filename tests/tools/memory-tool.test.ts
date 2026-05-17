import { test } from "bun:test";
import assert from "node:assert/strict";
import { memoryTool } from "../../src/tools/memory.ts";

test("memory: empty file arg returns error about file required", async () => {
  const result = await memoryTool.execute({ file: "", action: "read" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("file is required"));
});

test("memory: empty action arg returns error about action required", async () => {
  const result = await memoryTool.execute({ file: "MEMORY.md", action: "" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("action is required"));
});

test("memory: append with empty content returns error about content required", async () => {
  const result = await memoryTool.execute({ file: "MEMORY.md", action: "append", content: "" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("content is required"));
});

test("memory: invalid action returns error about invalid action", async () => {
  const result = await memoryTool.execute({ file: "MEMORY.md", action: "delete" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("Invalid action"));
});
