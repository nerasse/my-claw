/**
 * The roster a thread asks for: what it may reach, read off meta.json. The app asks at every run
 * end, and at every level of a sub-agent tree (a sub-agent's chat lists its own browser tasks).
 */

import { afterEach, expect, test } from "bun:test";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { metaOf, writeMeta } from "../../src/sessions/meta.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { deleteSession, loadSession, type SessionData } from "../../src/sessions/store.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const config = { whitelist: [], blacklist: [], channels: {}, llm: { provider: "x", baseUrl: "https://x", model: "m" }, agents: {}, memory: { enabled: false } } as unknown as MyClawConfig;
const voice = new VoiceManager(config);
const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voice, new SttPipeline(voice));
const idle = { isRunning: () => false };
const ROOT = "cron/0123456789ab/1";
const VOLET = "subagent/volet-a1b2";
const BROWSER = "subagent/browser-c3d4";
const made: string[] = [];

async function subagent(id: string, parent: string, visibility: "global" | "private", promptCount: number, logged: number): Promise<void> {
  made.push(id);
  await deleteSession(id);
  const at = new Date().toISOString();
  const session = { id, platform: "cron", chatType: "dm", createdAt: at, lastActiveAt: at, meta: { displayName: id, type: "general", parentSessionId: parent, visibility, createdAt: at } } as unknown as SessionData;
  const log = await sessionLogOf(id);
  for (let i = 0; i < logged; i++) log.append({ type: "user", prompt: true, text: `t${i}` });
  await log.flush();
  await writeMeta(id, metaOf(session, log.leaf(), undefined, { promptCount }));
}

afterEach(async () => {
  for (const id of made.splice(0)) await deleteSession(id);
});

test("a sub-agent's chat lists the browser tasks it started; its caller's does not", async () => {
  await subagent(VOLET, ROOT, "global", 1, 1);
  await subagent(BROWSER, VOLET, "private", 1, 1);
  expect((await runner.list(idle, VOLET)).map((a) => a.id)).toContain(BROWSER);
  expect((await runner.list(idle, ROOT)).map((a) => a.id)).not.toContain(BROWSER);
});

test("an idle agent's count is the one in meta.json: the log is not opened to list it", async () => {
  await subagent(VOLET, ROOT, "global", 7, 2);
  const row = (await runner.list(idle, ROOT)).find((a) => a.id === VOLET);
  expect(row?.messageCount).toBe(7);
  // A running one moves faster than its meta, so its log is the count.
  const live = (await runner.list({ isRunning: () => true }, ROOT)).find((a) => a.id === VOLET);
  expect(live?.messageCount).toBe(2);
});

/**
 * A running agent's row names the model it is calling, not the pin it started on -- the roster is
 * the only place that says so while the run is going, and a tag pin walked on a wall changes it
 * mid-run (docs/provider-failures.md).
 */
test("a running agent's row carries the live model, an idle one keeps its pin", async () => {
  await subagent(VOLET, ROOT, "global", 1, 1);
  // What a run recorded at start: the tag it was pinned to, which names no single account.
  const session = (await loadSession(VOLET))!;
  session.modelOverride = "tag:Quota";
  await writeMeta(VOLET, metaOf(session, (await sessionLogOf(VOLET)).leaf(), undefined, { promptCount: 1 }));

  const idleRow = (await runner.list(idle, ROOT)).find((a) => a.id === VOLET);
  expect(idleRow?.model).toBe("tag:Quota");
  expect(idleRow?.modelLive).toBeUndefined();

  const { signal, end } = runRegistry.startRoot(ROOT);
  runRegistry.enter(signal, "volet", 1, VOLET, "claude-2/claude-fable-5-2");
  try {
    const liveRow = (await runner.list({ isRunning: () => true }, ROOT)).find((a) => a.id === VOLET);
    expect(liveRow?.model).toBe("claude-2/claude-fable-5-2");
    expect(liveRow?.modelLive).toBe(true);
  } finally {
    end();
    runRegistry.clear();
  }
});

/**
 * When the agent last spoke: the roster is ordered by it now.
 *
 * The app used to group the list named-before-temporary and then by agent type, so the agent that
 * answered a minute ago sat wherever its type alphabetically fell. A date is the only thing the
 * reader sorts by, and the meta mirrors it so an idle roster costs no log open.
 */
test("an idle row carries the last message date from its meta, and a run in flight from its log", async () => {
  await subagent(VOLET, ROOT, "global", 3, 3);
  const row = (await runner.list(idle, ROOT)).find((a) => a.id === VOLET);
  const fromMeta = Date.parse(row!.lastMessageAt!);
  expect(Number.isFinite(fromMeta)).toBe(true);
  // The log's own answer for a running one: the meta is written at the run's end, so during it the
  // date it holds is the previous turn's.
  const log = await sessionLogOf(VOLET);
  const logged = log.lastUserAt();
  log.append({ type: "user", prompt: true, text: "later" });
  await log.flush();
  const live = (await runner.list({ isRunning: () => true }, ROOT)).find((a) => a.id === VOLET);
  expect(Date.parse(live!.lastMessageAt!)).toBeGreaterThan(logged!);
});
