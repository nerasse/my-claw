import { test } from "bun:test";
import assert from "node:assert/strict";
import { bashTool } from "../../src/tools/bash.ts";
import { AbortedError } from "../../src/core/aborted.ts";

test("bash: abort kills a long-running command quickly", async () => {
  const c = new AbortController();
  const startedAt = Date.now();
  const p = bashTool.execute({ command: "sleep 30", __signal: c.signal });
  setTimeout(() => c.abort(), 50);
  await assert.rejects(() => p, AbortedError);
  assert.ok(Date.now() - startedAt < 5000, "returned promptly after abort");
});

test("bash: already-aborted signal throws AbortedError without running", async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => bashTool.execute({ command: "echo hi", __signal: c.signal }), AbortedError);
});

test("bash: kills the whole process group (no orphaned child)", async () => {
  const c = new AbortController();
  // Marker file written by a grandchild after a delay; if the group is killed it never appears.
  const marker = `/tmp/myclaw-stop-test-${crypto.randomUUID()}`;
  const p = bashTool.execute({ command: `(sleep 1; echo x > ${marker}) & wait`, __signal: c.signal });
  setTimeout(() => c.abort(), 50);
  await assert.rejects(() => p, AbortedError);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await Bun.file(marker).exists(), false, "grandchild was killed with the group");
});
