/**
 * One stop per cycle, at the runner's own authority -- docs/stop.md.
 *
 * A child the spawn/send tools drive is tracked by `activeRuns` and holds no controller in the
 * registry, so it used to answer through a boolean with no memory of the cycle: two stops in a
 * row both answered "stopped". The answer is derived from the runs themselves now -- an aborted
 * controller stays aborted until the run departs -- and this is the test that was missing.
 */

import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const config: MyClawConfig = {
  whitelist: ["owner"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: { research: { llm: { defaultModel: "research-model" } } },
  memory: { enabled: false },
};

const PARENT = "my-claw-app/thread/owner/main";

function subSession(id: string): LegacySessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    meta: {
      displayName: "digger",
      type: "research",
      parentSessionId: PARENT,
      visibility: "global",
      createdAt: new Date().toISOString(),
    },
  };
}

function parentMessage(): UnifiedMessage {
  return {
    id: "msg-1",
    platform: "my-claw-app",
    userId: "owner",
    chatId: "owner",
    chatType: "dm",
    threadId: "main",
    text: "task",
    attachments: [],
    isForwarded: false,
    raw: null,
  };
}

beforeEach(() => {
  runRegistry.clear();
});

afterEach(() => {
  runRegistry.clear();
});

test("a runner-driven child answers stopped, then stopping, then stopped again on its next run", async () => {
  const id = "subagent/stop-cycle-a1b2";
  await writeLegacySessionFile(id, subSession(id));
  const setup = await setupSessionLog(id);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), new VoiceManager(config), new SttPipeline(new VoiceManager(config)));
  const registry = new SubAgentRegistry();

  // One trigger per run: the LLM call hangs until the run's signal aborts, which is what keeps
  // the work in flight while the stops are claimed.
  const calls: Array<() => void> = [];
  const started = (): Promise<void> => new Promise<void>((resolve) => calls.push(resolve));
  let firstCall: Promise<void>;
  let secondCall: Promise<void>;
  const fetchMock = mockFetch((_url, init) => {
    const notify = calls.shift();
    notify?.();
    return new Promise((_resolve, reject) => {
      const sig = (init as RequestInit | undefined)?.signal;
      sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }) as never;
  });

  try {
    firstCall = started();
    const first = runner.send(id, "first", undefined, parentMessage(), registry, PARENT);
    await firstCall;

    // The cycle's first stop takes the abort; every request after it changes nothing and says so.
    assert.equal(runner.stopSession(id), "stopped");
    assert.equal(runner.stopSession(id), "stopping");
    assert.equal(runner.stopSession(id), "stopping");

    await assert.rejects(first, AbortedError);
    // The run has departed: nothing left to take, and no leftover "stopping" either.
    assert.equal(runner.stopSession(id), "idle");

    // A second run of the same child is a new cycle: it gets a first stop of its own, which is
    // exactly what a stored flag lifted at the wrong moment would swallow.
    secondCall = started();
    const second = runner.send(id, "second", undefined, parentMessage(), registry, PARENT);
    await secondCall;
    assert.equal(runner.stopSession(id), "stopped");
    await assert.rejects(second, AbortedError);
    assert.equal(runner.stopSession(id), "idle");
  } finally {
    fetchMock.restore();
    setup.cleanup();
    await deleteSession(id);
  }
});
