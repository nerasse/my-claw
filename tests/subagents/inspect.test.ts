/**
 * `agents(action='inspect')` reads how a run ended, off the run's own markers -- docs/subagents.md.
 *
 * The state that matters for orchestration is the one a caller chooses between waiting and deciding
 * on. `blocked` used to be derived from the owner's chat-level quota wait, which a sub-agent never
 * has: the branch could not light up, and a failed child always read as "needs a decision". The
 * bridge now writes the class on the `run_end` marker, so the roster reads the run rather than
 * inferring a reason from something that was never set.
 */

import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { metaOf, writeMeta } from "../../src/sessions/meta.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { deleteSession, type SessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { ToolEntry } from "../../src/sessions/log.ts";

const config = { whitelist: [], blacklist: [], channels: {}, llm: { provider: "x", baseUrl: "https://x", model: "m" }, agents: {}, memory: { enabled: false } } as unknown as MyClawConfig;
const voice = new VoiceManager(config);
const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voice, new SttPipeline(voice));
const idle = { isRunning: () => false };
const PARENT = "my-claw-app/thread/owner/main";
const made: string[] = [];

async function agent(id: string, opts: { running?: boolean } = {}): Promise<void> {
  made.push(id);
  await deleteSession(id);
  const at = new Date().toISOString();
  const session = {
    id, platform: "my-claw-app", chatType: "dm", createdAt: at, lastActiveAt: at,
    meta: { displayName: id.replace("subagent/", ""), type: "general", parentSessionId: PARENT, visibility: "global", createdAt: at },
  } as unknown as SessionData;
  const log = await sessionLogOf(id);
  log.append({ type: "user", prompt: true, text: "do the thing" });
  log.append({ type: "run_start", prompt: false });
  log.append<ToolEntry>({ type: "tool", prompt: true, callId: "c1", name: "bash", args: {}, output: "ok", truncated: false, ok: true, runId: "t1" });
  await log.flush();
  await writeMeta(id, metaOf(session, log.leaf(), undefined, { promptCount: 1 }));
  void opts;
}

/** The closing marker, written last so the log is what a real failed run leaves. */
async function endRun(id: string, reason: "done" | "error" | "aborted", failure?: string): Promise<void> {
  const log = await sessionLogOf(id);
  log.append({ type: "run_end", prompt: false, reason, ...(failure ? { failure } : {}) });
  await log.flush();
}

afterEach(async () => {
  for (const id of made.splice(0)) await deleteSession(id);
});

test("a run the provider refused on a spent plan reads as blocked, not failed", async () => {
  const id = "subagent/blocked-a1b2";
  await agent(id);
  await endRun(id, "error", "quota_exhausted");
  const detail = await runner.inspect(id, idle, PARENT);
  assert.equal(detail?.lifecycle, "blocked");
  assert.deepEqual(detail?.nextActions, ["wait for the quota", "send(id) to resume", "send(id, model=...) with fallback='forbid'"]);
});

/** Every other ending keeps its own state: "blocked" is one reason, not a synonym for "broke". */
test("the other endings keep their words", async () => {
  const cases: Array<[string, "done" | "error" | "aborted" | undefined, string | undefined, string]> = [
    ["subagent/done-a1b2", "done", undefined, "complete"],
    ["subagent/boom-a1b2", "error", "transport", "failed"],
    ["subagent/stop-a1b2", "aborted", undefined, "stopped"],
    // An error with no class is an internal fault: it is not a quota, so it is not blocked.
    ["subagent/bare-a1b2", "error", undefined, "failed"],
    // A run that never closed is the state a killed server leaves.
    ["subagent/lost-a1b2", undefined, undefined, "lost"],
  ];
  for (const [id, reason, failure, expected] of cases) {
    await agent(id);
    if (reason) await endRun(id, reason, failure);
    const detail = await runner.inspect(id, idle, PARENT);
    assert.equal(detail?.lifecycle, expected, `${id} should read as ${expected}`);
  }
});

test("an agent no run ever touched says so, instead of looking finished", async () => {
  const id = "subagent/fresh-a1b2";
  made.push(id);
  await deleteSession(id);
  const at = new Date().toISOString();
  const session = {
    id, platform: "my-claw-app", chatType: "dm", createdAt: at, lastActiveAt: at,
    meta: { displayName: "fresh", type: "general", parentSessionId: PARENT, visibility: "global", createdAt: at },
  } as unknown as SessionData;
  await writeMeta(id, metaOf(session, null, undefined, { promptCount: 0 }));
  const detail = await runner.inspect(id, idle, PARENT);
  assert.equal(detail?.lifecycle, "never-run");
  assert.equal(detail?.resumable, false);
});

/** What a caller needs beyond the state: the tool it stopped on, and what the log allows next. */
test("inspect names the last tool and whether the work is still resumable", async () => {
  const id = "subagent/tool-a1b2";
  await agent(id);
  await endRun(id, "error", "quota_exhausted");
  const detail = await runner.inspect(id, idle, PARENT);
  assert.deepEqual(detail?.lastTool, { name: "bash", ok: true });
  assert.equal(detail?.resumable, true, "the question is still unanswered, so a resume has something to pick up");
});

test("an agent this caller cannot reach is not described at all", async () => {
  const id = "subagent/private-a1b2";
  made.push(id);
  await deleteSession(id);
  const at = new Date().toISOString();
  const session = {
    id, platform: "my-claw-app", chatType: "dm", createdAt: at, lastActiveAt: at,
    meta: { displayName: "private", type: "general", parentSessionId: PARENT, visibility: "private", createdAt: at },
  } as unknown as SessionData;
  await writeMeta(id, metaOf(session, null));
  // A private agent belongs to its creator alone: another conversation sees nothing to inspect.
  assert.equal(await runner.inspect(id, idle, "my-claw-app/thread/other/main"), undefined);
  assert.ok(await runner.inspect(id, idle, PARENT));
});
