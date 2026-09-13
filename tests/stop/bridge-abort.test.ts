import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, UserEntry } from "../../src/sessions/log.ts";
import { contextEntries } from "../../src/sessions/projection.ts";

const SESSION_ID = "test-abort";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hello", attachments: [], isForwarded: false, raw: {} };
}

function createSession(): LegacySessionData {
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

function toolCallResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "slow", arguments: "{}" } }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
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

test("bridge: already-aborted signal stops before the first LLM call and emits agent:run:aborted", async () => {
  const registry = new ToolRegistry();
  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  let calls = 0;
  const fetchMock = mockFetch(async () => { calls++; return new Response("{}", { status: 200 }) as never; });

  let aborted = false;
  const onAbort = () => { aborted = true; };
  hooks.on("agent:run:aborted", onAbort);

  const c = new AbortController();
  c.abort();
  try {
    await assert.rejects(() => bridge.handleMessage(createMessage(), createSession(), c.signal), AbortedError);
    assert.equal(calls, 0);
    assert.equal(aborted, true);
  } finally {
    hooks.off("agent:run:aborted", onAbort);
    fetchMock.restore();
  }
});

test("bridge: abort mid-tool leaves the question on the branch and no entry for the call it cut", async () => {
  const registry = new ToolRegistry();
  // Sealing only happens once the assistant tool_call message is in the session, so the abort has
  // to land while the tool runs. A fixed delay made that a race: on a loaded machine it could fire
  // during the LLM call instead, leaving nothing to seal. The tool signals when it truly starts.
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  registry.register({
    name: "slow",
    description: "slow tool",
    parameters: {},
    async execute() {
      toolStarted();
      // Long enough that the abort below is observed before this resolves, whatever the load.
      await new Promise((r) => setTimeout(r, 200));
      return { success: true, output: "done" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  const fetchMock = mockFetch(async () => toolCallResponse() as never);

  const c = new AbortController();
  const session = createSession();
  try {
    const p = bridge.handleMessage(createMessage(), session, c.signal);
    await started;
    c.abort();
    await assert.rejects(() => p, AbortedError);

    // An abort moves no cursor: it writes its `run_end` and rethrows. The question is on the
    // branch because it was appended there, and the tool is absent because it never settled --
    // a tool entry is only written once its call has a result, so the stop leaves no half-entry
    // and nothing to seal.
    await log.flush();
    const entries = log.entries();
    const context = contextEntries(entries, log.leaf());

    const userEntry = context.find((e): e is UserEntry => e.type === "user");
    assert.ok(userEntry, "user turn should be in context");
    assert.equal(userEntry.text, "hello");

    const toolEntry = context.find((e) => e.type === "tool");
    assert.equal(toolEntry, undefined, "a call cut mid-flight settled into no entry");
  } finally {
    fetchMock.restore();
  }
});
