import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, appendMessages, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, PhaseEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-interrupted";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return { id: "m2", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "encore", attachments: [], isForwarded: false, raw: {} };
}

function createSession(): LegacySessionData {
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
});

/**
 * Tool entries are only written when the tool completes, so a run killed during tool execution
 * leaves phases and no tool entry. That cannot project to a dangling tool_call -- the calls are
 * derived from the entries carrying the results.
 *
 * The turn it leaves says nothing and asks for nothing, and that turn is dropped rather than sent:
 * Anthropic refuses a request holding one ("text content blocks must be non-empty") and the retry
 * reposts the same prompt, so an unsettled call used to take the whole conversation down. This
 * test verifies both halves: nothing dangling, nothing empty, and a new run proceeds.
 */
test("bridge: a run killed mid-tool leaves no dangling tool_calls in the log", async () => {
  // Simulate an interrupted run: user turn + phase (the LLM requested a tool call)
  // but no tool entry (the tool never completed)
  log.append({ type: "user", prompt: true, text: "lance le build" } as any);
  log.append({ type: "phase", prompt: true, text: "", runId: "dead-run" } as any);
  await log.flush();

  const entries = (await log.all());
  const prompt = promptOf(entries, log.leaf());

  // Nothing dangling, and nothing empty either: the turn carried no prose and its call never
  // settled, so there is nothing left of it to send.
  assert.equal(prompt.find((m) => m.role === "assistant"), undefined, "the empty turn is dropped");
  assert.deepEqual(prompt.map((m) => m.role), ["user"]);

  // Now run the bridge - it should work without issues
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const fetchMock = mockFetch(async () => 
    new Response(JSON.stringify({ choices: [{ message: { content: "reparti" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "reparti");
    
    // Verify the new run completed successfully
    await log.flush();
    const newEntries = (await log.all());
    const phases = newEntries.filter((e): e is PhaseEntry => e.type === "phase");
    // Should have the old phase + the new phase
    assert.ok(phases.length >= 2, "new phase was added");
  } finally {
    fetchMock.restore();
  }
});

/**
 * This test pins the shape that used to cause problems: an assistant with tool_calls
 * but no tool results. With the new log system, this shape cannot occur because
 * tool_calls are derived from tool entries, not stored directly.
 */
test("the old dangling-tool-call shape cannot occur with the log system", async () => {
  // With the log system, tool_calls in the prompt are derived from ToolEntry records.
  // A ToolEntry is only written when the tool completes with a result.
  // Therefore, every tool_call in the prompt has a corresponding tool result.
  
  // Simulate a phase that was meant to call a tool (conceptually) but the tool never ran
  log.append({ type: "user", prompt: true, text: "lance le build" } as any);
  log.append({ type: "phase", prompt: true, text: "", runId: "r1" } as any);
  // No tool entry - this is what happens when a run is killed mid-tool
  log.append({ type: "user", prompt: true, text: "encore" } as any);

  const prompt = promptOf(await log.all(), log.leaf());
  
  // Count tool_calls and tool results
  const toolCallCount = prompt.reduce((count, m) => 
    count + (m.role === "assistant" && "tool_calls" in m ? (m.tool_calls?.length ?? 0) : 0), 0);
  const toolResultCount = prompt.filter((m) => m.role === "tool").length;
  
  // They must match - every tool_call has a result
  assert.equal(toolCallCount, toolResultCount, "tool_calls and tool results are balanced");
});
