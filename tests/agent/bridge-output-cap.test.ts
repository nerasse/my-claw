import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { SessionLog, ToolEntry } from "../../src/sessions/log.ts";
import { MESSAGE_CEILING_CHARS, readToolOutput, toolOutputPath } from "../../src/sessions/tool-output.ts";

const SESSION_ID = "test-output-cap";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
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
  runRegistry.clear();
});

test("bridge: an oversized tool output is archived whole, and both views are cut from it", async () => {
  const registry = new ToolRegistry();
  const huge = "z".repeat(200_000);
  registry.register({
    name: "flood",
    description: "returns a huge blob",
    parameters: {},
    async execute() {
      return { success: true, output: huge };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let call = 0;
  const bodies: string[] = [];
  const fetchMock = mockFetch(async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    if (call++ === 0) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "flood", arguments: "{}" } }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(createMessage(), session, signal);
    
    await log.flush();
    const entries = (await log.all());
    const toolEntry = entries.find((e): e is ToolEntry => e.type === "tool" && e.callId === "tc1");
    assert.ok(toolEntry, "tool result recorded");
    assert.ok(toolEntry.truncated, "marked as truncated");

    // The entry is the cheap view: a replayed history pays for the extract, not for the output.
    assert.ok(toolEntry.output.length < 8_000, `entry stubbed, got ${toolEntry.output.length}`);
    assert.ok(toolEntry.output.includes("read that file"), "the stub names the recovery path");

    // The archive is the whole of it. A cut file cannot answer the marker that points at it, and
    // it is exactly what a head-only cap ahead of the spill used to produce.
    assert.equal(toolEntry.outputPath, toolOutputPath(SESSION_ID, "tc1"));
    assert.equal((await readToolOutput(SESSION_ID, "tc1"))?.length, huge.length);

    // The run that made the call still saw far more than the entry keeps, bounded by the ceiling.
    assert.ok(bodies[1], "a second call was made with the tool result");
    const toolMessage = (JSON.parse(bodies[1]) as { messages: Array<{ role: string; content: string }> })
      .messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "the tool result reached the prompt");
    assert.ok(toolMessage.content.length > 50_000, `live view kept, got ${toolMessage.content.length}`);
    assert.ok(toolMessage.content.length <= MESSAGE_CEILING_CHARS + 500, "live view bounded by the ceiling");
  } finally {
    fetchMock.restore();
    end();
  }
});
