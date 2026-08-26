import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { toolOutputDir, toolOutputPath } from "../../src/sessions/tool-output.ts";
import { resolveWorkspacePath, resolveReadOnlyPath } from "../../src/tools/workspace.ts";

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
  const attachment = filesRoot + "/my-claw-app/owner-x/thread-1/uuid.pdf";
  const out = resolveWorkspacePath(attachment, "/ws");
  assert.equal(out, attachment);
});

describe("resolveReadOnlyPath: the tool-output widening", () => {
  const SESSION = "my-claw-app/thread/owner/read-only";
  const OTHER = "my-claw-app/thread/owner/someone-else";

  beforeEach(async () => {
    await mkdir(toolOutputDir(SESSION), { recursive: true });
    await mkdir(toolOutputDir(OTHER), { recursive: true });
  });

  test("a file in this session's tool output is reachable", async () => {
    const path = toolOutputPath(SESSION, "call_1");
    await writeFile(path, "spilled");
    assert.equal(resolveReadOnlyPath(path, "/ws", SESSION), path);
  });

  test("a name the store has not written yet resolves, so the read reports a missing file", () => {
    // The elision marker names a path; refusing to resolve it would answer "escapes the workspace"
    // where the honest answer is that this call never spilled.
    const path = toolOutputPath(SESSION, "call_absent");
    assert.equal(resolveReadOnlyPath(path, "/ws", SESSION), path);
  });

  test("another session's tool output is refused", async () => {
    const path = toolOutputPath(OTHER, "call_1");
    await writeFile(path, "not yours");
    assert.throws(() => resolveReadOnlyPath(path, "/ws", SESSION), /escapes workspace/);
  });

  test("climbing out with .. is refused", () => {
    const climb = join(toolOutputDir(SESSION), "..", "..", "..", "config.json");
    assert.throws(() => resolveReadOnlyPath(climb, "/ws", SESSION), /escapes workspace/);
  });

  test("a symlink in the directory is refused", async () => {
    // The leaf is a link. The first version of this check tested exactly this case and no other.
    const secret = join(MY_CLAW_DIR, "config.json");
    await writeFile(secret, "{}");
    const link = join(toolOutputDir(SESSION), "leaf-link");
    await symlink(secret, link);
    assert.throws(() => resolveReadOnlyPath(link, "/ws", SESSION), /escapes workspace/);
  });

  test("a symlink on a directory of the path is refused", async () => {
    // The case the first version let through: `lstat` on the full path follows the link on the
    // directory and reports a plain file, so the leaf test saw nothing to object to.
    const outside = join(MY_CLAW_DIR, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "readable");
    const linkedDir = join(toolOutputDir(SESSION), "dir-link");
    await symlink(outside, linkedDir);
    assert.throws(() => resolveReadOnlyPath(join(linkedDir, "secret.txt"), "/ws", SESSION), /escapes workspace/);
  });

  test("without a session there is no widening at all", () => {
    const path = toolOutputPath(SESSION, "call_1");
    assert.throws(() => resolveReadOnlyPath(path, "/ws"), /escapes workspace/);
  });

  test("the workspace still resolves the same way", () => {
    assert.equal(resolveReadOnlyPath("notes/a.txt", "/ws/sub", SESSION), "/ws/sub/notes/a.txt");
  });
});
