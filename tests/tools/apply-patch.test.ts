/**
 * The tool that replaces "rewrite the whole file with write" and the python heredocs the agent
 * was driving through bash. Its whole value is what it refuses: a patch that would land in the
 * wrong place must leave the file untouched and say why.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyPatchTool } from "../../src/tools/apply-patch.ts";

const TMP = mkdtempSync(join(tmpdir(), "my-claw-patch-"));

async function file(name: string, content: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const path = join(TMP, name);
  await writeFile(path, content);
  return path;
}

test("apply_patch: replaces an anchored block and reports the line delta", async () => {
  const path = await file("a.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  try {
    const result = await applyPatchTool.execute({
      path,
      edits: [{ old: "const b = 2;", new: "const b = 22;\nconst b2 = 23;" }],
    });
    assert.equal(result.success, true);
    assert.equal(await readFile(path, "utf-8"), "const a = 1;\nconst b = 22;\nconst b2 = 23;\nconst c = 3;\n");
    assert.match(result.output, /4 -> 5 lines, \+1/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: several edits in one call apply in order", async () => {
  const path = await file("b.ts", "one\ntwo\nthree\n");
  try {
    const result = await applyPatchTool.execute({
      path,
      edits: [
        { old: "one", new: "1" },
        { old: "three", new: "3" },
      ],
    });
    assert.equal(result.success, true);
    assert.equal(await readFile(path, "utf-8"), "1\ntwo\n3\n");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: an ambiguous anchor is refused with its line numbers, and nothing is written", async () => {
  const original = "x = 1;\ny = 0;\nz = 1;\ny = 0;\n";
  const path = await file("c.ts", original);
  try {
    const result = await applyPatchTool.execute({ path, edits: [{ old: "y = 0;", new: "y = 9;" }] });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /appears 2 times/);
    assert.match(result.error ?? "", /lines 2, 4/);
    assert.equal(await readFile(path, "utf-8"), original, "an ambiguous patch must not touch the file");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: all=true takes every occurrence", async () => {
  const path = await file("d.ts", "y = 0;\nz = 1;\ny = 0;\n");
  try {
    const result = await applyPatchTool.execute({ path, edits: [{ old: "y = 0;", new: "y = 9;", all: true }] });
    assert.equal(result.success, true);
    assert.equal(await readFile(path, "utf-8"), "y = 9;\nz = 1;\ny = 9;\n");
    assert.match(result.output, /2 occurrences replaced/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: a later edit that misses rolls back the earlier ones", async () => {
  const original = "alpha\nbeta\n";
  const path = await file("e.ts", original);
  try {
    const result = await applyPatchTool.execute({
      path,
      edits: [
        { old: "alpha", new: "ALPHA" },
        { old: "does not exist", new: "x" },
      ],
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /edits\[1\]: anchor not found/);
    // Half a patch is worse than none: the model would then reason about a file that is neither
    // the version it read nor the one it asked for.
    assert.equal(await readFile(path, "utf-8"), original);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: dollar sequences in the replacement are written as they are", async () => {
  // String.replace reads $&, $`, $' and $$ in a string replacement as patterns: $` alone pasted the
  // whole head of a note back into the middle of it.
  const path = await file("dollar.sh", "head\nMARK\ntail\n");
  try {
    const replacement = "a=$& b=$` c=$' d=$$ e=$1 f=${HOME}";
    const result = await applyPatchTool.execute({ path, edits: [{ old: "MARK", new: replacement }] });
    assert.equal(result.success, true);
    assert.equal(await readFile(path, "utf-8"), `head\n${replacement}\ntail\n`);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: an empty replacement deletes the block", async () => {
  const path = await file("f.ts", "keep\ndrop me\nkeep too\n");
  try {
    const result = await applyPatchTool.execute({ path, edits: [{ old: "drop me\n", new: "" }] });
    assert.equal(result.success, true);
    assert.equal(await readFile(path, "utf-8"), "keep\nkeep too\n");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: a missing file points at write instead of a retry", async () => {
  const result = await applyPatchTool.execute({
    path: join(TMP, "nope", "ghost.ts"),
    edits: [{ old: "a", new: "b" }],
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /File not found/);
  assert.match(result.error ?? "", /write/);
});

test("apply_patch: an edit that changes nothing is refused, not written", async () => {
  const path = await file("g.ts", "same\n");
  try {
    const result = await applyPatchTool.execute({ path, edits: [{ old: "same", new: "same" }] });
    assert.equal(result.success, false);
    assert.match(result.output, /changes nothing/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: malformed edits are named rather than silently skipped", async () => {
  const path = await file("h.ts", "content\n");
  try {
    assert.equal((await applyPatchTool.execute({ path, edits: [] })).success, false);
    assert.equal((await applyPatchTool.execute({ path, edits: "nope" })).success, false);
    assert.equal((await applyPatchTool.execute({ path, edits: [{ old: "", new: "x" }] })).success, false);
    assert.equal((await applyPatchTool.execute({ path, edits: [{ old: "content" }] })).success, false);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("apply_patch: a path outside the workspace is edited as asked", async () => {
  const outside = join(TMP, "..", `outside-${Date.now()}.txt`);
  await writeFile(outside, "localhost\n");
  try {
    const result = await applyPatchTool.execute({
      path: outside,
      edits: [{ old: "localhost", new: "nope" }],
      __workspaceDir: join(TMP, "workspace"),
    });
    assert.equal(result.success, true);
    assert.equal(await readFile(outside, "utf-8"), "nope\n");
  } finally {
    await rm(outside, { force: true });
  }
});
