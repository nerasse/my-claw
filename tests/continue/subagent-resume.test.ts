/**
 * A sub-agent resumed where it stopped, through `send` with no message -- docs/continue.md.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionLog, ToolEntry } from "../../src/sessions/log.ts";
import { createSendTool } from "../../src/tools/send.ts";

const config: MyClawConfig = {
  whitelist: ["owner"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {}, memory: { enabled: false },
};
const voice = new VoiceManager(config);
const stt = new SttPipeline(voice);
const PARENT = "my-claw-app/thread/owner/main";
const ID = "subagent/wttj-4f2a";

const sub = (): LegacySessionData => ({
  id: ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [],
  meta: { displayName: "wttj", type: "research", parentSessionId: PARENT, visibility: "global", createdAt: new Date().toISOString() },
});
const parentMessage: UnifiedMessage = { id: "p1", platform: "my-claw-app", userId: "owner", chatId: "owner", chatType: "dm", text: "", attachments: [], isForwarded: false, raw: {} };

let log: SessionLog;
let cleanup: () => void;
beforeEach(async () => {
  runRegistry.clear();
  await deleteSession(ID);
  await writeLegacySessionFile(ID, sub());
  ({ log, cleanup } = await setupSessionLog(ID));
});
afterEach(async () => {
  cleanup();
  await deleteSession(ID);
  runRegistry.clear();
});

function interruptedRun(): void {
  log.append({ type: "user", prompt: true, text: "liste les offres LLM sur WTTJ" });
  log.append({ type: "run_start", prompt: false });
  log.append({ type: "phase", prompt: true, text: "", runId: "t1" });
  log.append<ToolEntry>({ type: "tool", prompt: true, callId: "c1", name: "fetch", args: {}, output: "9 offres lues sur 14", truncated: false, ok: true, runId: "t1" });
  log.append({ type: "run_end", prompt: false, reason: "aborted" });
}

test("resumed with no message: no new turn, the run picks up after its last result", async () => {
  interruptedRun();
  const bodies: Array<{ messages: Array<{ role: string }> }> = [];
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "14 offres, 5 retenues." } }] }), { status: 200 }) as never;
  });
  try {
    const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voice, stt);
    const out = await runner.send(ID, undefined, undefined, parentMessage, new SubAgentRegistry(), PARENT);
    expect(out).toBe("14 offres, 5 retenues.");
    expect(bodies[0]!.messages.at(-1)!.role).toBe("tool");
    await log.flush();
    const users = log.entries().filter((e) => e.type === "user");
    expect(users).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("one that had finished answers with what it said, without running again", async () => {
  log.append({ type: "user", prompt: true, text: "t" });
  log.append({ type: "run_start", prompt: false });
  log.append({ type: "phase", prompt: true, text: "Terminé : 5 offres.", runId: "t1" });
  log.append({ type: "run_end", prompt: false, reason: "done" });
  let calls = 0;
  const mock = mockFetch(async () => { calls++; return new Response("{}") as never; });
  try {
    const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voice, stt);
    expect(await runner.send(ID, undefined, undefined, parentMessage, new SubAgentRegistry(), PARENT)).toBe("Terminé : 5 offres.");
    expect(calls).toBe(0);
  } finally {
    mock.restore();
  }
});

test("the id is found the way models write it: without its prefix, or by its name", async () => {
  log.append({ type: "user", prompt: true, text: "t" });
  log.append({ type: "run_start", prompt: false });
  log.append({ type: "phase", prompt: true, text: "fini", runId: "t1" });
  log.append({ type: "run_end", prompt: false, reason: "done" });
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voice, stt);
  expect(await runner.send("wttj-4f2a", undefined, undefined, parentMessage, new SubAgentRegistry(), PARENT)).toBe("fini");
  expect(await runner.send("wttj", undefined, undefined, parentMessage, new SubAgentRegistry(), PARENT)).toBe("fini");
});

test("the send tool resumes when the message is left out or blank", async () => {
  const seen: Array<string | undefined> = [];
  const runner = { send: async (_id: string, message: string | undefined) => { seen.push(message); return "ok"; } } as unknown as SubAgentRunner;
  const tool = createSendTool(runner, new SubAgentRegistry());
  await tool.execute({ id: ID, __message: parentMessage });
  await tool.execute({ id: ID, message: "  ", __message: parentMessage });
  await tool.execute({ id: ID, message: "va plus loin", __message: parentMessage });
  expect(seen).toEqual([undefined, undefined, "va plus loin"]);
});
