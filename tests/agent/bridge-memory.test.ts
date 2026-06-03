import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, mkdtempSync } from "node:fs";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import { remember } from "../../src/memory/index.ts";
import { closeMemoryDb, clearAllEntries } from "../../src/memory/db.ts";
import { clearRecallCache } from "../../src/memory/cache.ts";

const DB = join(tmpdir(), `mc-bridge-mem-${process.pid}-${Date.now()}.db`);
let workspace: string;
let savedWs: string | undefined;
let savedDb: string | undefined;

function baseConfig(memory: MyClawConfig["memory"]): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
    agents: {},
    memory,
  };
}

function createMessage(text: string): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text,
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(): SessionData {
  return {
    id: "telegram/dm/u1",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

/** Capture the user message content sent to the LLM. */
async function runAndCaptureUser(config: MyClawConfig, text: string): Promise<string> {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  let userContent = "";
  const fetchMock = mockFetch(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content: string }>;
    };
    userContent = body.messages.find((m) => m.role === "user")?.content ?? "";
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });
  try {
    await bridge.handleMessage(createMessage(text), createSession());
  } finally {
    fetchMock.restore();
  }
  return userContent;
}

beforeAll(() => {
  savedWs = process.env["MY_CLAW_WORKSPACE"];
  savedDb = process.env["MY_CLAW_MEMORY_DB"];
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  workspace = mkdtempSync(join(tmpdir(), "mc-bridge-ws-"));
  process.env["MY_CLAW_WORKSPACE"] = workspace;
  closeMemoryDb();
});
afterAll(() => {
  closeMemoryDb();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  rmSync(workspace, { recursive: true, force: true });
  if (savedDb === undefined) delete process.env["MY_CLAW_MEMORY_DB"];
  else process.env["MY_CLAW_MEMORY_DB"] = savedDb;
  if (savedWs === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = savedWs;
});
beforeEach(() => {
  clearAllEntries();
  clearRecallCache();
});

test("e2e: relevant memory is recalled and injected into the LLM user message", async () => {
  await remember("User prefers responses in French", "user");
  const userContent = await runAndCaptureUser(
    baseConfig({}),
    "what language should you answer in for this user",
  );
  expect(userContent).toContain("<memory-context>");
  expect(userContent).toContain("responses in French");
  // Original message text is preserved after the memory block.
  expect(userContent).toContain("what language should you answer");
});

test("e2e: no injection when nothing relevant is stored", async () => {
  await remember("The database uses WAL mode", "environment");
  const userContent = await runAndCaptureUser(baseConfig({}), "tell me a joke about cats");
  expect(userContent).not.toContain("<memory-context>");
});

test("e2e: no injection when memory is disabled", async () => {
  await remember("User prefers responses in French", "user");
  const userContent = await runAndCaptureUser(
    baseConfig({ enabled: false }),
    "what language should you answer in",
  );
  expect(userContent).not.toContain("<memory-context>");
});

test("e2e: trivial queries skip recall (no injection)", async () => {
  await remember("User prefers responses in French", "user");
  const userContent = await runAndCaptureUser(baseConfig({}), "/start");
  expect(userContent).not.toContain("<memory-context>");
});

test("e2e: injected memory is ephemeral (not persisted to session history)", async () => {
  await remember("User prefers responses in French", "user");
  const config = baseConfig({});
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const session = createSession();
  const fetchMock = mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );
  try {
    await bridge.handleMessage(createMessage("which language do you use with this user"), session);
  } finally {
    fetchMock.restore();
  }
  const stored = session.messages.find((m) => m.role === "user");
  expect(stored?.content).not.toContain("<memory-context>");
  expect(stored?.content).toContain("which language");
});
