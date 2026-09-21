/**
 * A sub-agent's own stop is not its caller's stop.
 *
 * The runner aborts a sub-agent's run for reasons of its own -- the owner stops that sub-agent's
 * card, its own budget, a pass that is asked to stop -- and that abort reaches the spawn/send tool
 * as an `AbortedError`. `rethrowIfAborted` used to read the shape alone, so it left the tool as if
 * the *caller's* run had been stopped: measured 2026-09-21, one sub-agent of three dying took its
 * parent's run down with it ("run stopped by user", nobody had stopped anything) and left the two
 * others unreported for 5 and 9 minutes. docs/stop.md.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSpawnTool } from "../../src/tools/spawn.ts";
import { createSendTool } from "../../src/tools/send.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { AgentInfo } from "../../src/agents/types.ts";

const parentMessage = (): UnifiedMessage => ({
  id: "m1",
  platform: "my-claw-app",
  userId: "owner",
  chatId: "owner",
  chatType: "dm",
  text: "go",
  attachments: [],
  isForwarded: false,
  raw: {},
});

// The tool checks the type against the live agent catalog, so the test has to offer one.
const catalog = (): AgentInfo[] => [
  { name: "research", description: "reads and reports", base: "research", source: "built-in", path: "research.md" },
];

/** The caller's signal is alive; only the child's run was stopped. */
function toolsThatFailAsTheChildWould(): { spawn: ReturnType<typeof createSpawnTool>; send: ReturnType<typeof createSendTool> } {
  const runner = {
    async spawn(): Promise<never> {
      throw new AbortedError();
    },
    async send(): Promise<never> {
      throw new AbortedError();
    },
  } as unknown as SubAgentRunner;
  const registry = new SubAgentRegistry();
  return { spawn: createSpawnTool(runner, registry, () => [], catalog), send: createSendTool(runner, registry) };
}

test("spawn: a sub-agent stopped on its own is a failure result, not the caller's Stop", async () => {
  const { spawn } = toolsThatFailAsTheChildWould();
  const run = new AbortController();
  const result = await spawn.execute({
    name: "child",
    type: "research",
    mode: "session",
    task: "go",
    __message: parentMessage(),
    __sessionId: "caller",
    __signal: run.signal,
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /stopped/);
  assert.equal(run.signal.aborted, false, "the caller's run is untouched");
});

test("send: same rule, the child's stop is not the caller's", async () => {
  const { send } = toolsThatFailAsTheChildWould();
  const run = new AbortController();
  const result = await send.execute({
    id: "subagent/x-1234",
    message: "go",
    __message: parentMessage(),
    __sessionId: "caller",
    __signal: run.signal,
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /stopped/);
});

test("a real Stop of the caller still leaves as an abort", async () => {
  const { spawn } = toolsThatFailAsTheChildWould();
  const run = new AbortController();
  run.abort();
  await assert.rejects(
    () => spawn.execute({
      name: "child",
      type: "research",
      mode: "session",
      task: "go",
      __message: parentMessage(),
      __sessionId: "caller",
      __signal: run.signal,
    }),
    AbortedError,
  );
});
