/**
 * A run's file snapshot and its log marker carry one id.
 *
 * `/undo` reads the `run_start` markers after the turn it takes back and finds that turn's
 * snapshots by their id. The snapshot used to take a random id of its own, so `/undo` could only
 * guess with the newest snapshot of the session -- another branch's, or a turn already undone.
 */
import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { snapshotOfRuns, clearSessionSnapshots } from "../../src/snapshots/store.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { RunStartEntry } from "../../src/sessions/log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const SESSION_ID = "my-claw-app/thread/u1/run-snapshot";
let workspace: string;
let cleanupLog: () => void;

function createSession(): LegacySessionData {
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "run-snapshot-ws-"));
  await writeFile(join(workspace, "note.txt"), "v0\n");
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  cleanupLog = (await setupSessionLog(SESSION_ID)).cleanup;
});

afterEach(async () => {
  cleanupLog();
  runRegistry.clear();
  await clearSessionSnapshots(SESSION_ID);
  await rm(workspace, { recursive: true, force: true });
});

test("the run's marker names the snapshot of the files as they were before it", async () => {
  const config: MyClawConfig = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
    agents: {},
    memory: { enabled: false },
    workspace,
  };
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const message: UnifiedMessage = { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
  const fetchMock = mockFetch(async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\ndata: [DONE]\n`;
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
  });

  try {
    await bridge.handleMessageStreaming(message, createSession(), async () => {}, undefined, signal);
    const markers = (await sessionLogOf(SESSION_ID)).entries().filter((entry): entry is RunStartEntry => entry.type === "run_start");
    assert.equal(markers.length, 1);
    const snapshot = await snapshotOfRuns(SESSION_ID, [markers[0]!.runId!]);
    assert.ok(snapshot, "no snapshot under the marker's run id");
    assert.equal(snapshot.before.root, workspace);
  } finally {
    fetchMock.restore();
    end();
  }
});
