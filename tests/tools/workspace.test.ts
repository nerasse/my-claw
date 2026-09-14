import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveWorkspacePath } from "../../src/tools/workspace.ts";

test("resolveWorkspacePath: relative path resolves under the workspace", () => {
  assert.equal(resolveWorkspacePath("notes/a.txt", "/ws/sub"), "/ws/sub/notes/a.txt");
});

test("resolveWorkspacePath: a trailing slash on the workspace does not brick relative paths", () => {
  // Regression: "/ws/sub/" used to make the boundary check "/ws/sub//" and reject everything.
  assert.equal(resolveWorkspacePath("notes/a.txt", "/ws/sub/"), "/ws/sub/notes/a.txt");
});

test("resolveWorkspacePath: an absolute path outside the workspace is resolved as asked", () => {
  // There is no fence. `bash` never had one -- it spawns in the workspace and takes any absolute
  // path in its command -- so a boundary only the other tools obeyed turned "write this file"
  // into an error the agent worked around by shelling out, and prevented nothing (2026-09-14:
  // a sub-agent denied /tmp/steal_run.sh wrote it with `cat >` one call later).
  assert.equal(resolveWorkspacePath("/tmp/steal_run.sh", "/ws/sub"), "/tmp/steal_run.sh");
});

test("resolveWorkspacePath: climbing out with .. is resolved, not refused", () => {
  assert.equal(resolveWorkspacePath("../../etc/passwd", "/ws/sub"), "/etc/passwd");
});

test("resolveWorkspacePath: a symlink is resolved as a path, never followed for a check", () => {
  assert.equal(
    resolveWorkspacePath("/ws/sub/link/outside.txt", "/ws/sub"),
    "/ws/sub/link/outside.txt",
  );
});

test("resolveWorkspacePath: an absolute path with no workspace configured is itself", () => {
  assert.equal(resolveWorkspacePath("/anything", undefined), "/anything");
});

test("resolveWorkspacePath: a relative path with no workspace configured resolves against cwd", () => {
  assert.equal(resolveWorkspacePath("notes/a.txt", undefined), join(process.cwd(), "notes/a.txt"));
});
