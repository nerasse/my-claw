import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorePrompt } from "../../src/agent/prompt/loader.ts";
import { buildSystemPrompt, type PromptContext } from "../../src/agent/prompt/builder.ts";
import { CORE_PROMPT } from "../../src/agent/prompt/core-prompts.ts";

const prevWorkspace = process.env["MY_CLAW_WORKSPACE"];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (prevWorkspace === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = prevWorkspace;
});

async function workspaceWith(coreContent?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "core-md-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env["MY_CLAW_WORKSPACE"] = dir;
  if (coreContent !== undefined) await writeFile(join(dir, "CORE.md"), coreContent);
  return dir;
}

function ctx(): PromptContext {
  return { platform: "unknown", model: "m", sessionId: "s", tools: [], skills: [] };
}

test("missing CORE.md falls back to the hardcoded constant", async () => {
  await workspaceWith(undefined);
  // Since builtin became a runtime layer, "missing everywhere" resolves to the shipped template,
  // which is today byte-identical to CORE_PROMPT (modulo the file's trailing newline). The
  // assertion pins the result either way: if docs/prompt/CORE.md ever drifts, this fails loudly.
  assert.equal(await loadCorePrompt(), CORE_PROMPT);
});

test("blank CORE.md falls back to the hardcoded constant", async () => {
  await workspaceWith("   \n  \n");
  assert.equal(await loadCorePrompt(), CORE_PROMPT);
});

test("present CORE.md overrides the hardcoded constant", async () => {
  await workspaceWith("# My Core\nDo the thing.");
  const out = await loadCorePrompt();
  assert.match(out, /My Core/);
  assert.doesNotMatch(out, /Core Directives/);
});

test("CORE.md is normalised", async () => {
  // Proves the ingestion point is wired to normalizeUntrusted. It no longer blocks anything:
  // the pattern denylist was removed, see docs/untrusted-content.md.
  await workspaceWith("# Core\nBe use\u200bful.");
  const out = await loadCorePrompt();
  assert.match(out, /Be useful\./);
  assert.ok(!out.includes("\u200b"), "invisible character stripped");
});

test("buildSystemPrompt uses CORE.md content at layer 0 when present", async () => {
  await workspaceWith("# Custom Core Layer\nBehave.");
  const result = await buildSystemPrompt(ctx());
  assert.match(result, /Custom Core Layer/);
  assert.ok(result.indexOf("Custom Core Layer") < result.indexOf("Runtime:"), "core is layer 0");
});

test("buildSystemPrompt falls back to the constant when CORE.md is absent", async () => {
  await workspaceWith(undefined);
  const result = await buildSystemPrompt(ctx());
  assert.match(result, /Core Directives/);
});
