import { test } from "bun:test";
import assert from "node:assert/strict";
import { bashTool } from "../../src/tools/bash.ts";

test("bash: runs simple echo command", async () => {
  const result = await bashTool.execute({ command: "echo hello" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("hello"));
});

test("bash: failed command returns success false with exit code", async () => {
  const result = await bashTool.execute({ command: "exit 42" });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("exit code"));
});

test("bash: empty command returns success false", async () => {
  const result = await bashTool.execute({ command: "" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("required"));
});

test("bash: captures stderr", async () => {
  const result = await bashTool.execute({ command: "echo oops >&2" });
  assert.ok(result.output.includes("STDERR"));
});

test("bash: respects __workspaceDir for cwd", async () => {
  const result = await bashTool.execute({ command: "pwd", __workspaceDir: "/tmp" });
  assert.ok(result.success);
  assert.ok(result.output.trim().startsWith("/tmp"));
});

test("bash: absolute workdir sets cwd", async () => {
  const result = await bashTool.execute({ command: "pwd", workdir: "/tmp" });
  assert.ok(result.success);
  assert.ok(result.output.trim().startsWith("/tmp"));
});

test("bash: relative workdir resolves against workspace", async () => {
  const result = await bashTool.execute({ command: "pwd", workdir: ".", __workspaceDir: "/tmp" });
  assert.ok(result.success);
  assert.ok(result.output.trim().startsWith("/tmp"));
});

test("bash: non-existent workdir fails cleanly", async () => {
  const result = await bashTool.execute({ command: "pwd", workdir: "/no/such/dir/xyz" });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("does not exist"));
});
