/**
 * What a run records for `/undo`, and what it does not have to.
 *
 * The capture is a `git add --all` of every depot in the workspace: 0.6 s on an idle tree, 18 s
 * after a build, 73 s on a cold shadow. Two cases have nothing to record and skip it: a Continue,
 * whose turn already recorded its undo point and whose second file is never read
 * (`snapshotOfRuns` keeps the earliest), and a sub-agent writing in its parent's tree, which the
 * parent turn's snapshot already holds.
 *
 * The runs here call one tool, because that is what makes the capture land before the run ends: a
 * run that writes nothing records it in the background, and nothing observable waits for it.
 */
import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { recordRunStart, snapshotsRoot, clearSessionSnapshots } from "../../src/snapshots/store.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { PhaseEntry, RunStartEntry, UserEntry } from "../../src/sessions/log.ts";

let workspace: string;
let cleanupLog: () => void;
let sessionId: string;

function config(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
    agents: {},
    memory: { enabled: false },
    workspace,
  };
}

function message(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(): LegacySessionData {
  return { id: sessionId, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

/** One tool round, then an answer. The tool writes nothing: the snapshot is what is under test. */
function oneToolRound(): ReturnType<typeof mockFetch> {
  let call = 0;
  return mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "silent", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "silent",
    description: "returns nothing",
    parameters: {},
    async execute() {
      return { success: true, output: "ok" };
    },
  });
  return tools;
}

async function runBridge(fetchMock: ReturnType<typeof mockFetch>, depth = 0, parentWorkspaceDir?: string): Promise<void> {
  const bridge = new AgentBridge(config(), registry(), new SkillRegistry(), undefined, undefined, depth, workspace, depth === 0 ? undefined : "general", undefined, undefined, undefined, parentWorkspaceDir);
  const { signal, end } = runRegistry.startRoot(sessionId);
  try {
    await bridge.handleMessage(message(), session(), signal);
  } finally {
    fetchMock.restore();
    end();
  }
}

/** The snapshot files this session recorded, which is what `/undo` reads. */
function snapshotsOf(id: string): Promise<string[]> {
  return readdir(join(snapshotsRoot(), "session", id)).catch(() => [] as string[]);
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "snap-toll-ws-"));
  sessionId = `my-claw-app/thread/u1/snap-toll-${process.pid}-${Date.now()}`;
  await writeFile(join(workspace, "note.txt"), "v0\n");
  await deleteSession(sessionId);
  await writeLegacySessionFile(sessionId, session());
  cleanupLog = (await setupSessionLog(sessionId)).cleanup;
});

afterEach(async () => {
  cleanupLog();
  runRegistry.clear();
  await clearSessionSnapshots(sessionId);
  await rm(workspace, { recursive: true, force: true });
});

test("a fresh turn records exactly one snapshot", async () => {
  const log = await sessionLogOf(sessionId);
  log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
  await log.flush();

  await runBridge(oneToolRound());

  assert.equal((await snapshotsOf(sessionId)).length, 1);
});

test("a Continue reuses the turn's undo point instead of capturing again", async () => {
  const log = await sessionLogOf(sessionId);
  log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
  const runStart = log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "r0" });
  log.append<PhaseEntry>({ type: "phase", prompt: true, text: "first pass", runId: "r0" });
  await log.flush();
  // The turn's first run captured its state; `/undo` reads the earliest of the turn's runs.
  await recordRunStart(sessionId, workspace, runStart.runId!);
  assert.deepEqual(await snapshotsOf(sessionId), ["r0.json"]);

  await runBridge(oneToolRound());

  // Still one file: the second run wrote none, and `/undo` finds `r0` under the turn's markers.
  assert.deepEqual(await snapshotsOf(sessionId), ["r0.json"]);
});

test("a sub-agent writing in its parent's tree records nothing of its own", async () => {
  const log = await sessionLogOf(sessionId);
  log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
  await log.flush();

  await runBridge(oneToolRound(), 1, workspace);

  assert.deepEqual(await snapshotsOf(sessionId), []);
});
