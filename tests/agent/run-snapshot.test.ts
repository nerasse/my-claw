/**
 * A run's file snapshot and its log marker carry one id.
 *
 * `/undo` reads the `run_start` markers after the turn it takes back and finds that turn's
 * snapshots by their id. The snapshot used to take a random id of its own, so `/undo` could only
 * guess with the newest snapshot of the session -- another branch's, or a turn already undone.
 *
 * The capture is started with the run but awaited only before its first tool: it used to be
 * awaited at run start, which put a `git add --all` of every depot in front of the first token
 * (0.6 s idle, 18 s after a build, 198 s measured under disk pressure). What the test pins is the
 * part that matters -- when a run's tools have run, the marker's snapshot is the state *before*
 * the first of them wrote anything.
 */
import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { snapshotOfRuns, clearSessionSnapshots, snapshotsRoot } from "../../src/snapshots/store.ts";
import { restoreDepot } from "../../src/snapshots/capture.ts";
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

function createMessage(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
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

test("the run's marker names the snapshot of the files as they were before its first tool", async () => {
  const config: MyClawConfig = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
    agents: {},
    memory: { enabled: false },
    workspace,
  };
  const registry = new ToolRegistry();
  // A tool that writes through the test file API, standing in for `write`: what matters is that it
  // mutates the workspace during the run.
  registry.register({
    name: "scribble",
    description: "write the note",
    parameters: { type: "object", properties: {} },
    async execute() {
      await writeFile(join(workspace, "note.txt"), "v1\n");
      return { success: true, output: "written" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);

  let call = 0;
  const fetchMock = mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "scribble", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
  });

  try {
    await bridge.handleMessage(createMessage(), createSession(), signal);
    assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "v1\n");

    const markers = (await sessionLogOf(SESSION_ID)).entries().filter((entry): entry is RunStartEntry => entry.type === "run_start");
    assert.equal(markers.length, 1);
    const snapshot = await snapshotOfRuns(SESSION_ID, [markers[0]!.runId!]);
    assert.ok(snapshot, "no snapshot under the marker's run id");
    assert.equal(snapshot.before.root, workspace);

    // The snapshot really is the state before the tool: putting it back rewinds the write.
    await restoreDepot(snapshot.before.depots[0]!, join(snapshotsRoot(), "shadow"));
    assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "v0\n");
  } finally {
    fetchMock.restore();
    end();
  }
});
