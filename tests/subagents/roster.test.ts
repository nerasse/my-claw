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
import { deleteSession, type SessionData } from "../../src/sessions/store.ts";
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
