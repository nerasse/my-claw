import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { saveSession, deleteSession, loadSession, type SessionData, type SubAgentMeta } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

/**
 * The rule under test is docs/subagent-visibility.md: a `workspace` sub-agent is reachable from
 * every conversation of the workspace that spawned it, and from no other.
 */
const config: MyClawConfig = {
  whitelist: ["owner"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  workspaces: { alpha: "/tmp/ws-alpha", beta: "/tmp/ws-beta" },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);

function runner(): SubAgentRunner {
  return new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
}

/** A conversation, which is what a caller session id resolves to. */
async function chat(id: string, workspace?: string): Promise<void> {
  const session: SessionData = {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    ...(workspace ? { workspace } : {}),
  };
  await saveSession(id, session);
}

async function subAgent(id: string, meta: Partial<SubAgentMeta>): Promise<void> {
  const session: SessionData = {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    meta: {
      displayName: "digger",
      type: "research",
      parentSessionId: "chat/alpha-1",
      visibility: "workspace",
      createdAt: new Date().toISOString(),
      ...meta,
    },
  };
  await saveSession(id, session);
}

const ids = [
  "subagent/ws-alpha",
  "subagent/ws-beta",
  "subagent/ws-default",
  "subagent/shared",
  "subagent/own",
];

beforeEach(async () => {
  for (const id of [...ids, "chat/alpha-1", "chat/alpha-2", "chat/beta-1", "chat/plain"]) {
    await deleteSession(id).catch(() => {});
  }
});

test("a workspace sub-agent is listed by another conversation of the same workspace", async () => {
  await chat("chat/alpha-1", "alpha");
  await chat("chat/alpha-2", "alpha");
  await subAgent("subagent/ws-alpha", { workspaceKey: "alpha", parentSessionId: "chat/alpha-1" });

  const listed = await runner().list(new SubAgentRegistry(), "chat/alpha-2");
  assert.deepEqual(listed.map((a) => a.id), ["subagent/ws-alpha"]);
  // The roster carries the scope, so the app can group by workspace without a second call.
  assert.equal(listed[0]!.visibility, "workspace");
  assert.equal(listed[0]!.workspaceKey, "alpha");
});

test("a workspace sub-agent is invisible to a conversation of another workspace", async () => {
  await chat("chat/alpha-1", "alpha");
  await chat("chat/beta-1", "beta");
  await subAgent("subagent/ws-alpha", { workspaceKey: "alpha" });

  assert.deepEqual(await runner().list(new SubAgentRegistry(), "chat/beta-1"), []);
});

test("the default workspace is a scope, not a wildcard", async () => {
  await chat("chat/plain");
  await chat("chat/alpha-1", "alpha");
  await subAgent("subagent/ws-default", { workspaceKey: undefined, parentSessionId: "chat/plain" });
  await subAgent("subagent/ws-alpha", { workspaceKey: "alpha", parentSessionId: "chat/alpha-1" });

  // An unkeyed agent belongs to the default workspace and stays there, both ways.
  assert.deepEqual(
    (await runner().list(new SubAgentRegistry(), "chat/plain")).map((a) => a.id),
    ["subagent/ws-default"],
  );
  assert.deepEqual(
    (await runner().list(new SubAgentRegistry(), "chat/alpha-1")).map((a) => a.id),
    ["subagent/ws-alpha"],
  );
});

test("global and private keep their meaning next to the new scope", async () => {
  await chat("chat/alpha-1", "alpha");
  await chat("chat/beta-1", "beta");
  await subAgent("subagent/shared", { visibility: "global", workspaceKey: undefined });
  await subAgent("subagent/own", { visibility: "private", parentSessionId: "chat/beta-1" });

  const fromBeta = (await runner().list(new SubAgentRegistry(), "chat/beta-1")).map((a) => a.id).sort();
  assert.deepEqual(fromBeta, ["subagent/own", "subagent/shared"]);
  // A private agent of another conversation is absent even inside the same workspace.
  const fromAlpha = (await runner().list(new SubAgentRegistry(), "chat/alpha-1")).map((a) => a.id);
  assert.deepEqual(fromAlpha, ["subagent/shared"]);
});

test("driving and deleting answer 'not found' across a workspace boundary", async () => {
  await chat("chat/alpha-1", "alpha");
  await chat("chat/beta-1", "beta");
  await subAgent("subagent/ws-alpha", { workspaceKey: "alpha" });

  const r = runner();
  // The same wording as a nonexistent id, so the refusal does not confirm the agent exists.
  assert.match(await r.kill("subagent/ws-alpha", "chat/beta-1"), /not found/);
  assert.match(await r.reset("subagent/ws-alpha", "chat/beta-1"), /not found/);
  const registry = new SubAgentRegistry();
  const sent = await r.send(
    "subagent/ws-alpha",
    "hello",
    undefined,
    {
      id: "m1",
      platform: "my-claw-app",
      userId: "owner",
      chatId: "owner",
      chatType: "dm",
      text: "hello",
      attachments: [],
      isForwarded: false,
      raw: {},
    },
    registry,
    "chat/beta-1",
  );
  assert.match(sent, /not found/);

  // And the agent is still there for its own workspace: the refusal was a scope check, not a
  // deletion that half happened.
  assert.deepEqual(
    (await r.list(registry, "chat/alpha-1")).map((a) => a.id),
    ["subagent/ws-alpha"],
  );
});

test("spawn scopes a workspace agent to the caller's workspace, not to where it runs", async () => {
  // The agent is pinned to `beta` by config, while the conversation asking for it lives in
  // `alpha`. Those are two different things: the pin moves its filesystem, the caller decides
  // who may drive it afterwards.
  const pinned: MyClawConfig = { ...config, agents: { research: { workspace: "beta" } } };
  const r = new SubAgentRunner(pinned, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  await chat("chat/alpha-1", "alpha");
  await chat("chat/beta-1", "beta");

  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }), { status: 200 }) as never,
  );
  let id: string;
  try {
    ({ id } = await r.spawn({
      displayName: "scoped",
      type: "research",
      mode: "session",
      task: "init",
      parentMessage: {
        id: "m1",
        platform: "my-claw-app",
        userId: "owner",
        chatId: "owner",
        chatType: "dm",
        text: "init",
        attachments: [],
        isForwarded: false,
        raw: {},
      },
      existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e),
      parentSessionId: "chat/alpha-1",
      visibility: "workspace",
    }));
  } finally {
    fetchMock.restore();
  }

  const stored = await loadSession(id);
  assert.equal(stored?.meta?.workspaceKey, "alpha");
  // Reachable from its own workspace, not from the one it happens to run in.
  assert.deepEqual((await r.list(reg, "chat/alpha-1")).map((a) => a.id), [id]);
  assert.deepEqual(await r.list(reg, "chat/beta-1"), []);
  await deleteSession(id);
});

test("a caller whose session cannot be read sees the default scope, not every scope", async () => {
  await subAgent("subagent/ws-alpha", { workspaceKey: "alpha" });
  await subAgent("subagent/ws-default", { workspaceKey: undefined });

  // No session file for this id: it must not become a passe-partout.
  assert.deepEqual(
    (await runner().list(new SubAgentRegistry(), "chat/ghost")).map((a) => a.id),
    ["subagent/ws-default"],
  );
});
