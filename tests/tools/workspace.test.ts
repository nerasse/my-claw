import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveWorkspacePath } from "../../src/tools/workspace.ts";

test("resolveWorkspacePath: relative path resolves under the workspace", () => {
  const out = resolveWorkspacePath("notes/a.txt", "/ws/sub");
  assert.equal(out, "/ws/sub/notes/a.txt");
});

test("resolveWorkspacePath: a trailing slash on the workspace does not brick relative paths", () => {
  // Regression: "/ws/sub/" used to make the boundary check "/ws/sub//" and reject everything.
  const out = resolveWorkspacePath("notes/a.txt", "/ws/sub/");
  assert.equal(out, "/ws/sub/notes/a.txt");
});

test("resolveWorkspacePath: path escaping the workspace is rejected", () => {
  assert.throws(() => resolveWorkspacePath("../../etc/passwd", "/ws/sub"), /escapes workspace/);
});

test("resolveWorkspacePath: no workspace configured returns the input unchanged", () => {
  assert.equal(resolveWorkspacePath("/anything", undefined), "/anything");
});

test("resolveWorkspacePath: session attachment paths under the files root are allowed", () => {
  // The agent must read the files the user attaches without them living in the workspace.
  const filesRoot = resolveWorkspacePath("", "/ws").slice(0, 0) + process.env["MY_CLAW_DIR"] + "/files";
  const attachment = filesRoot + "/mobile/dev-x/thread-1/uuid.pdf";
  const out = resolveWorkspacePath(attachment, "/ws");
  assert.equal(out, attachment);
});
