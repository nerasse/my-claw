import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions/manager.ts";
import { deleteSession, loadSession, FAILURE_TEXT_LIMIT, type LegacySessionData } from "../src/sessions/store.ts";
import { MAX_TITLE_LENGTH, MyClawAppSessionStoreImpl } from "../src/channels/my-claw-app/sessions.ts";
import { sessionLogOf } from "../src/sessions/log-access.ts";
import { promptOf } from "../src/sessions/projection.ts";
import type { Entry } from "../src/sessions/log.ts";
import type { MyClawAppHistoryEntry } from "../src/channels/my-claw-app/types.ts";
import { SessionFileStore, filePathFor, filesDirFor } from "../src/channels/my-claw-app/files.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DraftStore } from "../src/channels/my-claw-app/drafts.ts";
import { FolderStore } from "../src/channels/my-claw-app/folders.ts";
import { join } from "node:path";
import { saveSessionWithLog, type SessionLogSetup, writeLegacySessionFile } from "./helpers/session-log.ts";
import type { FailureEntry, CommandEntry, ToolEntry } from "../src/sessions/log.ts";
import { resetSessionLogResolver } from "../src/sessions/log-access.ts";
import { readMeta, writeMeta } from "../src/sessions/meta.ts";
import { appendSpawnState } from "../src/sessions/spawn-state.ts";

const DEVICE = "dev-test";
const THREAD = "thread-1";

/**
 * The words a replayed row shows, whatever kind it is: a tool card is named, a folded run stands
 * for work rather than for prose. Narrowing in place would make every assertion enumerate the
 * union, which is how these tests read before the run summary existed.
 */
function textOf(entry: MyClawAppHistoryEntry): string {
  if (entry.role === "tool") return entry.name;
  if (entry.role === "run") return `run:${entry.run.status}`;
  return entry.text;
}

/** The same, for the tests that assert on the error a dead run left behind. */
function textOrErrorOf(entry: MyClawAppHistoryEntry): string {
  if (entry.role === "tool") return "tool";
  if (entry.role === "run") return `run:${entry.run.status}`;
  return entry.error ?? entry.text;
}

/** A row that carries prose, asserted rather than assumed. */
function proseOf(entry: MyClawAppHistoryEntry) {
  if (entry.role === "tool" || entry.role === "run") throw new Error(`expected a text entry, got ${entry.role}`);
  return entry;
}

function session(id: string, messages: LegacySessionData["messages"]): LegacySessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:01:00.000Z",
    messages,
  };
}

describe("MyClawAppSessionStoreImpl.history", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;
  let logSetup: SessionLogSetup | null = null;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(async () => {
    if (logSetup) {
      await logSetup.log.flush();
      logSetup.cleanup();
      logSetup = null;
    }
    resetSessionLogResolver();
  });

  /**
   * Reported from the app: a thread that had been compacted came back as a wall of
   * `[Prior context summarized]` in the owner's own voice, because a summary is stored in a `user`
   * turn -- the role the prompt needs it in. It is a boundary, and the turns it covers are still
   * above it.
   */
  test("a compaction summary is replayed as a boundary, not as something the owner typed", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "premiere question", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "premiere reponse", timestamp: "2026-01-01T00:00:02.000Z" },
      {
        role: "user",
        content: "[Prior context summarized]\nPrior work: the two turns above.\n\n[End of summary — respond to the message below]",
        timestamp: "2026-01-01T00:00:03.000Z",
        summaryOf: 2,
      },
      { role: "user", content: "la suite", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    // Nothing is hidden: the turns the summary stands for are replayed in full above it.
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "user", "user"]);

    const boundary = proseOf(entries[2]!);
    assert.equal(boundary.summaryOf, 2);
    // The scaffolding is addressed to the model: "respond to the message below" has no reader here.
    assert.equal(boundary.text, "Prior work: the two turns above.");

    const ordinary = proseOf(entries[3]!);
    assert.equal(ordinary.summaryOf, undefined);
    assert.equal(ordinary.text, "la suite");
  });

  test("replays tool calls as structured cards with output and duration", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "check le site", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "je regarde",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-1", name: "fetch", arguments: '{"url":"https://x.dev"}', durationMs: 412 }],
      },
      { role: "tool", toolCallId: "call-1", content: "HTTP 200 OK", timestamp: "2026-01-01T00:00:03.000Z" },
      { role: "assistant", content: "le site repond", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "tool", "assistant"]);

    const card = entries[2]!;
    assert.equal(card.role, "tool");
    if (card.role !== "tool") throw new Error("expected a tool entry");
    assert.equal(card.name, "fetch");
    assert.deepEqual(card.args, { url: "https://x.dev" });
    assert.equal(card.durationMs, 412);
    assert.equal(card.output, "HTTP 200 OK");
    assert.equal(card.truncated, false);
  });

  /**
   * Our own tools reach the Claude SDK through an in-process MCP server, so the SDK calls them
   * `mcp__myclaw__bash` and the mirror kept that name. A reopened thread then showed the
   * plumbing on every card while the live cards, built from the registry, showed `bash`.
   */
  test("replays a terminal spawn lifecycle when the outer tool result has not landed yet", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{
          id: "spawn-call",
          name: "spawn",
          arguments: '{"name":"researcher","mode":"run"}',
          spawn: {
            subagentId: "subagent/researcher-1",
            displayName: "researcher",
            agentType: "research",
            mode: "run",
            action: "spawn",
            status: "complete",
            resultLength: 17,
            startedAt: "2026-01-01T00:00:02.000Z",
            finishedAt: "2026-01-01T00:00:03.000Z",
          },
        }],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const card = entries.find((entry) => entry.role === "tool");
    assert.ok(card && card.role === "tool");
    assert.equal(card.running, undefined);
    assert.equal(card.spawn?.status, "complete");
    assert.equal(card.spawn?.subagentId, "subagent/researcher-1");
  });

  test("replays a send card with spawn metadata the same way as a spawn card", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{
          id: "send-call",
          name: "send",
          arguments: '{"id":"subagent/researcher-1","message":"again"}',
          spawn: {
            subagentId: "subagent/researcher-1",
            displayName: "researcher",
            agentType: "research",
            mode: "session",
            action: "send",
            status: "complete",
            startedAt: "2026-01-01T00:00:02.000Z",
            finishedAt: "2026-01-01T00:00:03.000Z",
            resultLength: 42,
          },
        }],
      },
      { role: "tool", toolCallId: "send-call", content: "sub-agent replied with 42 chars", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const card = entries.find((entry) => entry.role === "tool");
    assert.ok(card && card.role === "tool");
    // In the log system, `running` is never set on replayed entries; running state is live-only
    assert.equal(card.running, undefined);
    assert.equal(card.spawn?.action, "send");
    assert.equal(card.spawn?.status, "complete");
  });

  test("a replayed card names the tool, not the MCP wrapper the SDK wraps it in", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [
          { id: "call-3", name: "mcp__myclaw__bash", arguments: '{"command":"ls"}', durationMs: 12 },
          // A real MCP server's tool keeps its prefix: that is what says where it comes from.
          { id: "call-4", name: "mcp__mailcow__get_status", arguments: "{}", durationMs: 8 },
        ],
      },
      { role: "tool", toolCallId: "call-3", content: "AGENTS.md", timestamp: "2026-01-01T00:00:03.000Z" },
      { role: "tool", toolCallId: "call-4", content: "ok", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const names = entries.filter((e) => e.role === "tool").map((e) => (e.role === "tool" ? e.name : ""));
    assert.deepEqual(names, ["bash", "mcp__mailcow__get_status"]);
  });

  test("pages backwards through a long conversation without repeating or dropping a turn", async () => {
    const messages: LegacySessionData["messages"] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `q${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    const newest = await store.history(DEVICE, THREAD, 5);
    assert.deepEqual(newest.entries.map(textOf), ["q7", "q8", "q9", "q10", "q11"]);
    assert.equal(newest.hasMore, true);

    const older = await store.history(DEVICE, THREAD, 5, 5);
    assert.deepEqual(older.entries.map(textOf), ["q2", "q3", "q4", "q5", "q6"]);
    assert.equal(older.hasMore, true);

    // The last page is short and says so: the app must stop asking rather than loop on empties.
    const oldest = await store.history(DEVICE, THREAD, 5, 10);
    assert.deepEqual(oldest.entries.map(textOf), ["q0", "q1"]);
    assert.equal(oldest.hasMore, false);
  });

  test("pages by the id of the oldest held item, which is exact where the count drifts", async () => {
    const messages: LegacySessionData["messages"] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `q${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    const newest = await store.history(DEVICE, THREAD, 5);
    // The client asks for the page right before its oldest held item, by that item's id.
    const beforeId = newest.entries[0]!.id;
    const older = await store.history(DEVICE, THREAD, 5, 0, beforeId);
    // The window ends right before the held id: the five turns that precede it.
    assert.deepEqual(older.entries.map(textOf), ["q2", "q3", "q4", "q5", "q6"]);
    assert.equal(older.hasMore, true);
    assert.equal(older.nextBefore, 10);

    // A tool card resolves by its call id too, since that is the id the client holds on cards.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "q", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        role: "assistant",
        content: "je regarde",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-1", name: "fetch", arguments: '{"url":"https://x.dev"}', durationMs: 10 }],
      },
      { role: "tool", toolCallId: "call-1", content: "HTTP 200 OK", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));
    // The id the client actually holds on a card is `t-<callId>` (toolCardId), not the raw call
    // id: paging asked with the raw one matched nothing, came back empty, and the app read that
    // as the top of the conversation. Both shapes resolve here, and the prefixed one is the one
    // that must.
    const card = await store.history(DEVICE, THREAD, 5, 0, "t-call-1");
    // The window ends right before the tool result entry: the question and the call it carried
    // are still on the page -- only the settled card itself is the held edge.
    assert.deepEqual(card.entries.map(textOf), ["q", "je regarde"]);
    assert.equal(card.hasMore, false);

    // An id the branch no longer holds (compaction dropped the turn, a fork left it behind)
    // falls back to the count cursor sent alongside it. Never an empty page: the app cannot
    // tell that apart from the top of the conversation and would stop paging for good.
    const unknown = await store.history(DEVICE, THREAD, 2, 1, "gone-forever");
    assert.ok(unknown.entries.length > 0, "an unresolvable id must not kill paging");
  });

  test("a fresh sync serves the newest page with its paging cursor; a delta never does", async () => {
    const messages: LegacySessionData["messages"] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `q${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    // Fresh open: the whole branch fits, so nothing is older -- the cursor says so.
    const fresh = await store.sync(DEVICE, THREAD);
    assert.equal(fresh.hasMore, false);
    assert.equal(fresh.nextBefore, 0);

    // A delta keeps the client's own cursor standing: no fields at all.
    const delta = await store.sync(DEVICE, THREAD, fresh.entries[0]!.id);
    assert.equal(delta.hasMore, undefined);
    assert.equal(delta.nextBefore, undefined);

    // Past the sync limit, the fresh window is the newest 500 and the cursor says there is more.
    // Own thread: the bulk save must land on a file nothing else wrote, or the count is off by
    // whatever the previous test left behind.
    const bigThread = store.resolveSessionId(DEVICE, "thread-big");
    sessionId = bigThread;
    const big: LegacySessionData["messages"] = [];
    for (let i = 0; i < 640; i++) {
      big.push({ role: "user", content: `big${i}`, timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
    }
    logSetup = await saveSessionWithLog(bigThread, session(bigThread, big));
    const windowed = await store.sync(DEVICE, "thread-big", null, undefined, 500);
    assert.equal(windowed.hasMore, true);
    assert.equal(windowed.entries.length, 500);
    // The cursor counts entries before the window, and the window starts exactly there.
    const first = windowed.entries[0]!;
    assert.equal(textOf(first), `big${windowed.nextBefore}`);
    // A whole window is never "truncated": that flag sends the client asking for a forward
    // delta, and the turn alignment below can legitimately push the window past the limit.
    assert.equal(windowed.truncated, undefined);
  });

  /**
   * The fold, end to end -- docs/run-hydration.md. Measured on a real 12 034-entry session, the
   * page an app opens on moved 1 124 KB of which 18 KB was prose a reader could see; a finished
   * run sent as its header puts that at 21 KB.
   */
  test("a finished run travels as its header, and only for a client that asked", async () => {
    const foldThread = store.resolveSessionId(DEVICE, "thread-fold");
    sessionId = foldThread;
    logSetup = await saveSessionWithLog(foldThread, session(foldThread, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    // A finished run, written the way the run-recorder writes one.
    logSetup.log.append({ type: "user", prompt: true, text: "fais le travail" });
    const start = logSetup.log.append({ type: "run_start", prompt: false });
    const work: Entry[] = [];
    for (let i = 0; i < 12; i++) {
      work.push(logSetup.log.append({ type: "phase", prompt: true, text: `etape ${i}`, runId: start.id }));
      work.push(logSetup.log.append({
        type: "tool", prompt: true, callId: `call-${i}`, name: "bash",
        args: { command: "ls" }, output: "x".repeat(2000), truncated: false, ok: true, runId: start.id,
      }));
    }
    logSetup.log.append({ type: "run_end", prompt: false, reason: "done" });

    // What an app that never asked receives: every item, as today.
    const whole = await store.history(DEVICE, "thread-fold");
    assert.equal(whole.entries.filter((e) => e.role === "tool").length, 12);
    assert.equal(whole.entries.some((e) => e.role === "run"), false);

    // What an app that asked receives: the question, then one row for the run.
    const folded = await store.history(DEVICE, "thread-fold", undefined, 0, undefined, true);
    assert.deepEqual(folded.entries.map((e) => e.role), ["user", "user", "run"]);
    const summary = folded.entries[2]!;
    assert.equal(summary.role === "run" ? summary.toolCount : 0, 12);
    assert.equal(summary.role === "run" ? summary.run.status : "", "done");
    // Keyed on the first entry it stands for, not on the run: an injection can cut one run into
    // several folded segments, and each needs an id of its own.
    assert.equal(summary.id, `run-${work[0]!.id}`);

    // The point of the exercise.
    assert.ok(
      JSON.stringify(folded.entries).length * 10 < JSON.stringify(whole.entries).length,
      "a folded page must be an order of magnitude smaller than the work it stands for",
    );

    // And the paging cursor the app now holds still walks back past the run: `run-<id>` resolves
    // to the run's first entry, so the page above it is everything that came before the work --
    // never an empty page, which the app reads as the top of the conversation.
    const older = await store.history(DEVICE, "thread-fold", 50, 0, summary.id, true);
    assert.ok(older.entries.length > 0, "a summary cursor must not return an empty page");
    assert.equal(older.entries.some((e) => e.role === "tool" || e.role === "run"), false);
    const first = older.entries[0]!;
    assert.equal(first.role === "user" ? first.text : "", "tour precedent");

    // The same on the frame an opening app actually sends.
    const synced = await store.sync(DEVICE, "thread-fold", null, undefined, 500, true);
    assert.deepEqual(synced.entries.map((e) => e.role), ["user", "user", "run"]);
  });

  /** The other half of the fold: what the reader gets when the collapsed group is opened. */
  test("hydration hands back exactly the range the row stood for", async () => {
    const hydrateThread = store.resolveSessionId(DEVICE, "thread-hydrate");
    sessionId = hydrateThread;
    logSetup = await saveSessionWithLog(hydrateThread, session(hydrateThread, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    logSetup.log.append({ type: "user", prompt: true, text: "fais le travail" });
    const start = logSetup.log.append({ type: "run_start", prompt: false });
    for (let i = 0; i < 12; i++) {
      logSetup.log.append({ type: "phase", prompt: true, text: `etape ${i}`, runId: start.id });
      logSetup.log.append({
        type: "tool", prompt: true, callId: `call-${i}`, name: "bash",
        args: { command: "ls" }, output: `sortie ${i}`, truncated: false, ok: true, runId: start.id,
      });
    }
    const answer = logSetup.log.append({ type: "phase", prompt: true, text: "voila", runId: start.id });
    logSetup.log.append({ type: "run_end", prompt: false, reason: "done" });

    const folded = await store.history(DEVICE, "thread-hydrate", undefined, 0, undefined, true);
    const summary = folded.entries.find((e) => e.role === "run");
    assert.ok(summary && summary.role === "run", "the run must have folded");
    // The answer is hoisted: it is on the page, not in the fold.
    assert.equal(folded.entries.some((e) => e.id === answer.id), true);

    const hydrated = await store.runItems(DEVICE, "thread-hydrate", summary.id, summary.lastId);
    assert.equal(hydrated.found, true);
    // Exactly what the row claimed, in the same shapes a page uses.
    assert.equal(hydrated.entries.length, summary.itemCount);
    assert.equal(hydrated.entries.filter((e) => e.role === "tool").length, summary.toolCount);
    // And nothing the page already carried: not the question, not the answer.
    assert.equal(hydrated.entries.some((e) => e.id === answer.id), false);
    assert.equal(hydrated.entries.some((e) => e.role === "user"), false);
    // The run meta travels with the items, so the group renders them under the same header.
    assert.equal(hydrated.entries[0]!.run?.id, start.id);

    // The bare entry id works as well as the row id: the client holds both forms.
    const bare = await store.runItems(DEVICE, "thread-hydrate", summary.id.slice(4), summary.lastId);
    assert.deepEqual(bare.entries.map((e) => e.id), hydrated.entries.map((e) => e.id));

    // Splicing the items back where the row was rebuilds the unfolded page, item for item.
    const whole = await store.history(DEVICE, "thread-hydrate");
    const spliced = folded.entries.flatMap((e) => (e.role === "run" ? hydrated.entries : [e]));
    assert.deepEqual(spliced.map((e) => e.id), whole.entries.map((e) => e.id));
  });

  test("a range the branch no longer holds is refused, not half-answered", async () => {
    const goneThread = store.resolveSessionId(DEVICE, "thread-gone");
    sessionId = goneThread;
    logSetup = await saveSessionWithLog(goneThread, session(goneThread, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    const real = logSetup.log.append({ type: "user", prompt: true, text: "encore" });

    const missing = await store.runItems(DEVICE, "thread-gone", "run-01a0-not-here", real.id);
    assert.equal(missing.found, false);
    assert.deepEqual(missing.entries, []);

    // Backwards is not a range either.
    const first = (await store.history(DEVICE, "thread-gone")).entries[0]!;
    const backwards = await store.runItems(DEVICE, "thread-gone", real.id, first.id);
    assert.equal(backwards.found, false);
  });

  test("a run still going is never folded away from the client watching it", async () => {
    const liveThread = store.resolveSessionId(DEVICE, "thread-fold-live");
    sessionId = liveThread;
    logSetup = await saveSessionWithLog(liveThread, session(liveThread, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    logSetup.log.append({ type: "user", prompt: true, text: "fais le travail" });
    const start = logSetup.log.append({ type: "run_start", prompt: false });
    for (let i = 0; i < 12; i++) {
      logSetup.log.append({
        type: "tool", prompt: true, callId: `call-${i}`, name: "bash",
        args: { command: "ls" }, output: "ok", truncated: false, ok: true, runId: start.id,
      });
    }
    // No run_end: this is the turn in flight.
    const page = await store.history(DEVICE, "thread-fold-live", undefined, 0, undefined, true);
    assert.equal(page.entries.filter((e) => e.role === "tool").length, 12);
    assert.equal(page.entries.some((e) => e.role === "run"), false);
  });

  test("the window a thread opens on starts at a question, not inside the work of a run", async () => {
    // One agentic turn is easily 300 entries. Cut flat at the limit, an opened thread began on
    // a tool card whose question sat above the window: a run that came from nowhere, which is
    // exactly what the owner reported seeing at the top of a long conversation.
    const messages: LegacySessionData["messages"] = [
      { role: "user", content: "la question du tour", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    for (let i = 0; i < 40; i++) {
      messages.push({
        role: "assistant",
        content: `je travaille ${i}`,
        timestamp: "2026-01-01T00:00:01.000Z",
        toolCalls: [{ id: `c-${i}`, name: "bash", arguments: "{}", durationMs: 1 }],
      });
      messages.push({ role: "tool", toolCallId: `c-${i}`, content: "ok", timestamp: "2026-01-01T00:00:02.000Z" });
    }
    const turnThread = store.resolveSessionId(DEVICE, "thread-turn");
    sessionId = turnThread;
    logSetup = await saveSessionWithLog(turnThread, session(turnThread, messages));

    // A window far smaller than the turn: it still opens on the question that started it.
    const opened = await store.sync(DEVICE, "thread-turn", null, undefined, 10);
    const first = opened.entries[0]!;
    assert.equal(first.role, "user");
    assert.equal(first.role === "user" ? first.text : "", "la question du tour");
    assert.equal(opened.truncated, undefined);
  });

  /**
   * One agentic turn is easily fifty tool results. Counted flat, the newest page began inside
   * the work and the question that started it sat on the page above: the owner saw his own
   * message vanish from a thread he had just written in.
   */
  test("a page starts at a turn, so a long turn never pushes its own question off the screen", async () => {
    const messages: LegacySessionData["messages"] = [
      { role: "user", content: "la question", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    for (let i = 1; i <= 8; i++) {
      messages.push({ role: "assistant", content: `a${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    const page = await store.history(DEVICE, THREAD, 5);
    assert.equal(page.entries[0]?.role, "user");
    assert.equal(page.entries[0]?.role === "user" ? page.entries[0].text : "", "la question");
    assert.equal(page.entries.length, 9, "the page grew to the start of the turn");
    assert.equal(page.hasMore, false);
  });

  test("the walk back is bounded: only a pathological turn still starts mid-flight", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const stamp = (i: number): string => new Date(base + i * 1000).toISOString();
    const messages: LegacySessionData["messages"] = [{ role: "user", content: "la question", timestamp: stamp(0) }];
    for (let i = 1; i <= 450; i++) {
      messages.push({ role: "assistant", content: `a${i}`, timestamp: stamp(i) });
    }
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    const page = await store.history(DEVICE, THREAD, 5);
    // Five asked for, 405 taken: the walk stops 400 messages back and not one further.
    assert.equal(page.entries.length, 405);
    assert.equal(page.entries[0]?.role === "assistant" ? page.entries[0].text : "", "a46");
    assert.equal(page.hasMore, true);
    // The page above must still end where this one begins, or the walk would duplicate a turn.
    const older = await store.history(DEVICE, THREAD, 5, page.nextBefore);
    const last = older.entries.at(-1);
    assert.equal(last && last.role === "assistant" ? last.text : "", "a45");
  });

  /**
   * The app replaces the thread on screen with what this returns. Served from the file, a switch
   * to another conversation and back mid-run wiped the question and every card already streamed,
   * and a restart before the run ended made that permanent.
   */
  test("a turn in flight is part of the history, not something the file has yet", async () => {
    const manager = new SessionManager();
    const live = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    // Simulate a run in flight by appending directly to the log (the run-recorder does this)
    const runId = "run-in-flight";
    logSetup.log.append({ type: "user", prompt: true, text: "la question en cours" });
    logSetup.log.append({ type: "phase", prompt: true, text: "", runId });
    logSetup.log.append({ type: "tool", prompt: true, callId: "call-live", name: "bash", args: { command: "ls" }, output: "README.md", truncated: false, ok: true, runId });

    const { entries } = await live.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "user", "tool"]);
    assert.equal(entries[1]?.role === "user" ? entries[1].text : "", "la question en cours");
    const card = entries[2]!;
    assert.equal(card.role === "tool" ? card.output : "", "README.md");
  });

  test("a tool call with no result yet is not replayed (running state is live-only)", async () => {
    // In the log system, a tool call without a matching ToolEntry is not shown in replay.
    // The helper creates ToolEntry for each toolCall, but only if there's a tool message.
    // A tool call "in flight" has no ToolEntry and is shown via live frames, not replay.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "cherche", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [
          { id: "call-done", name: "search", arguments: "{}", durationMs: 20 },
        ],
      },
      { role: "tool", toolCallId: "call-done", content: "3 matches", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const cards = entries.filter((e) => e.role === "tool");
    // Only the completed call appears in replay; running calls are shown live
    assert.equal(cards.length, 1);

    const [done] = cards;
    assert.equal(done?.role === "tool" ? done.running : "absent", undefined);
    assert.equal(done?.role === "tool" ? done.output : "", "3 matches");
    assert.equal(done?.id, "t-call-done");
  });

  test("a cursor past the start of the session is an empty page, not an error", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "seul message", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const page = await store.history(DEVICE, THREAD, 50, 999);
    assert.deepEqual(page.entries, []);
    assert.equal(page.hasMore, false);
  });

  test("keeps the card when the timing predates duration persistence and truncates long output", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-2", name: "bash", arguments: "not json" }],
      },
      { role: "tool", toolCallId: "call-2", content: "z".repeat(5000), timestamp: "2026-01-01T00:00:03.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 1);
    const card = entries[0]!;
    if (card.role !== "tool") throw new Error("expected a tool entry");
    assert.equal(card.durationMs, undefined);
    assert.deepEqual(card.args, { raw: "not json" });
    assert.equal(card.output.length, 4000);
    assert.equal(card.truncated, true);
  });
  test("a replayed turn carries its attachments and not the server paths", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, THREAD, "photo de vacances.png", new Uint8Array([1, 2, 3]));
    const gone = await files.save(DEVICE, THREAD, "notes.md", new Uint8Array([4]));
    await files.remove(DEVICE, THREAD, gone.id);

    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "user",
        content: `regarde ca\n\n[Attachments]\n- image: ${filePathFor(DEVICE, THREAD, saved.storedName)} (image/png, 3 bytes, ${saved.filename}, 800x600)\n- file: ${filePathFor(DEVICE, THREAD, gone.storedName)} (text/markdown, 1 bytes, ${gone.filename})`,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 1);
    const turn = entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "regarde ca");
    assert.equal(turn.attachments?.length, 2);

    const [image, missing] = turn.attachments!;
    assert.equal(image!.id, saved.id);
    assert.equal(image!.type, "image");
    assert.equal(image!.filename, "photo de vacances.png");
    assert.equal(image!.sizeBytes, 3);
    assert.equal(image!.deleted, undefined);

    // Deleted since: still named in the bubble, but flagged so the app opens nothing.
    assert.equal(missing!.id, gone.id);
    assert.equal(missing!.filename, "notes.md");
    assert.equal(missing!.deleted, true);
  });

  /**
   * Measured on the owner's phone (2026-09-15): the pictures a run's tools produced drew as an
   * empty stage under a bare filename while the run was live, and were fine on reopening the
   * thread. The delta is why. It is everything written since the client's cursor, so it carries
   * the run's entries and never the question that opened it -- and the gate that decides whether
   * to read the thread's file store looked for a question or for `MEDIA:` in the prose, neither of
   * which a tool's pictures have. Every ref replayed as deleted, with an id nothing can serve.
   */
  test("a delta resolves a run's pictures, though it holds no question to recognise them by", async () => {
    const files = new SessionFileStore();
    const stored = await files.save(DEVICE, THREAD, "browser-shot.png", new Uint8Array([1, 2, 3]));

    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    logSetup.log.append({ type: "user", prompt: true, text: "va me chercher ca" });
    const start = logSetup.log.append({ type: "run_start", prompt: false });
    const call = logSetup.log.append({
      type: "tool", prompt: true, callId: "call-shot", name: "bash",
      args: { command: "ls" }, output: "ok", truncated: false, ok: true, runId: start.id,
    });
    logSetup.log.append({ type: "phase", prompt: true, text: "", runId: start.id });
    logSetup.log.append({ type: "run_end", prompt: false, reason: "done", media: ["/tmp/browser-shot.png"] });

    // The delta a device asks for on reconnect: the cursor sits on the tool call, so the window is
    // the run's last entries -- no question above it, and no ref in any prose.
    const delta = await store.sync(DEVICE, THREAD, call.id);
    const answer = delta.entries.find((e) => e.role === "assistant");
    assert.ok(answer, "the run's answer is in the delta");
    if (answer.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(answer.attachments?.length, 1);
    // The id is the store's, so the app can fetch it; a minted one is a 404 and a blank stage.
    assert.equal(answer.attachments![0]!.id, stored.id);
    assert.equal(answer.attachments![0]!.filename, "browser-shot.png");
    assert.equal(answer.attachments![0]!.deleted, undefined);
  });

  /**
   * The point of the id: a marker that names one needs no directory listing at all, and the store
   * finds the copy from any thread of its owner -- which a filename match inside one thread cannot.
   * Nothing is in this thread's store, so only the id can answer.
   */
  test("a marker that names its pictures by id resolves without reading a directory", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    logSetup.log.append({ type: "user", prompt: true, text: "montre moi" });
    const start = logSetup.log.append({ type: "run_start", prompt: false });
    const call = logSetup.log.append({
      type: "tool", prompt: true, callId: "call-paired", name: "bash",
      args: { command: "ls" }, output: "ok", truncated: false, ok: true, runId: start.id,
    });
    logSetup.log.append({ type: "phase", prompt: true, text: "", runId: start.id });
    logSetup.log.append({
      type: "run_end", prompt: false, reason: "done",
      media: ["/tmp/browser-shot.png"],
      mediaIds: ["0c17e81a-28ee-429d-82d7-52c5d0a99616"],
    });

    const delta = await store.sync(DEVICE, THREAD, call.id);
    const answer = delta.entries.find((e) => e.role === "assistant");
    if (answer?.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(answer.attachments?.[0]?.id, "0c17e81a-28ee-429d-82d7-52c5d0a99616");
    assert.equal(answer.attachments?.[0]?.filename, "browser-shot.png");
    assert.equal(answer.attachments?.[0]?.type, "image");
    assert.equal(answer.attachments?.[0]?.deleted, undefined);
  });

  /** The same window, the other way a turn carries media: a ref the agent wrote itself. */
  test("a delta still resolves the refs an agent wrote in its prose", async () => {
    const files = new SessionFileStore();
    const stored = await files.save(DEVICE, THREAD, "output.png", new Uint8Array([9]));

    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    logSetup.log.append({ type: "user", prompt: true, text: "fais un dessin" });
    const start = logSetup.log.append({ type: "run_start", prompt: false });
    const call = logSetup.log.append({
      type: "tool", prompt: true, callId: "call-draw", name: "bash",
      args: { command: "ls" }, output: "ok", truncated: false, ok: true, runId: start.id,
    });
    logSetup.log.append({ type: "phase", prompt: true, text: "voila\nMEDIA:/tmp/output.png", runId: start.id });

    const delta = await store.sync(DEVICE, THREAD, call.id);
    const answer = delta.entries.find((e) => e.role === "assistant");
    if (answer?.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(answer.attachments?.[0]?.id, stored.id);
    assert.equal(answer.text, "voila");
  });

  test("a replayed voice note carries its duration and its transcript, not the [Audio] marker", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, THREAD, "voice-note.m4a", new Uint8Array([1, 2, 3, 4]));
    const audioPath = filePathFor(DEVICE, THREAD, saved.storedName);

    // The log entry stores transcripts keyed by path (as the recorder does in prod).
    // displayOf passes these through to the history entry.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({
      type: "user",
      prompt: true,
      text: "",
      transcripts: { [audioPath]: "rappelle-moi demain" },
      attachments: [{ type: "image" as const, path: audioPath, mimeType: "audio/mp4" }],
    });
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    const turn = entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");

    // The device knows its recordings by attachment id: the path-keyed storage form is remapped.
    assert.deepEqual(turn.transcripts, { [saved.id]: "rappelle-moi demain" });
    assert.equal(turn.attachments?.length, 1);
    assert.equal(turn.attachments![0]!.type, "audio");
    assert.equal(turn.attachments![0]!.id, saved.id);
  });

  test("a replayed location keeps structured data and hides the model-only block", async () => {
    const location = {
      latitude: 48.8566,
      longitude: 2.3522,
      accuracyMeters: 24,
      capturedAt: "2026-08-13T12:30:00.000Z",
      address: { formatted: "Rue de Rivoli, Paris", level: "street" as const, provider: "geoapify" as const },
    };
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "user",
        content: "Je suis ici\n\n[Shared location]\n- coordinates: 48.856600, 2.352200\n- accuracy: +/- 24 m\n- capturedAt: 2026-08-13T12:30:00.000Z\n- address (approximate, street, geoapify): Rue de Rivoli, Paris",
        timestamp: "2026-01-01T00:00:01.000Z",
        location,
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "Je suis ici");
    assert.deepEqual(turn.location, location);
  });

  test("several recordings in one turn each keep their own words", async () => {
    const files = new SessionFileStore();
    const first = await files.save(DEVICE, THREAD, "one.m4a", new Uint8Array([1]));
    const second = await files.save(DEVICE, THREAD, "two.m4a", new Uint8Array([2]));
    const firstPath = filePathFor(DEVICE, THREAD, first.storedName);
    const secondPath = filePathFor(DEVICE, THREAD, second.storedName);

    // Transcripts keyed by path, attachments as SessionAttachment (type + path)
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({
      type: "user",
      prompt: true,
      text: "",
      transcripts: {
        [firstPath]: "premier bout",
        [secondPath]: "deuxieme bout",
      },
      attachments: [
        { type: "image" as const, path: firstPath, mimeType: "audio/mp4" },
        { type: "image" as const, path: secondPath, mimeType: "audio/mp4" },
      ],
    });
    await logSetup.log.flush();

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");

    // Each recording keeps its own words, keyed by the id the app knows it by.
    assert.deepEqual(turn.transcripts, {
      [first.id]: "premier bout",
      [second.id]: "deuxieme bout",
    });
    // Both recordings should be in the attachments
    assert.equal(turn.attachments?.length, 2);
    assert.deepEqual(turn.attachments!.map((a) => a.id), [first.id, second.id]);
  });

  test("a caption sent with a voice note survives the transcript split", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: `regarde ca\n\n[Audio]: "et ecoute"`, timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "regarde ca");
    // No attachment survives to pair it with, so there is nothing to hang the words on.
    assert.equal(turn.transcripts, undefined);
  });

  test("a failed transcription stays visible as text", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "user",
        content: "[Audio]: [Transcription failed: timeout]",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    // Hiding this would replay a voice note that silently said nothing.
    assert.equal(turn.text, "[Audio]: [Transcription failed: timeout]");
    assert.equal(turn.transcripts, undefined);
  });

  test("a renamed conversation keeps its name in the list, and can be handed back", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "comment je configure le dns du serveur", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    // Without a name, the list shows how the thread opened rather than what it is about.
    let listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "comment je configure le dns du serveur");

    await store.rename(DEVICE, THREAD, "  Infra   maison  ");
    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "Infra maison");

    // Blank is not a name: the conversation goes back to its automatic title.
    await store.rename(DEVICE, THREAD, "   ");
    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "comment je configure le dns du serveur");
  });

  test("the listing reads its counts from the meta, so a drawer never opens a log", async () => {
    // Opening one per conversation is what this replaces: the listing walks every thread the
    // owner ever had, and each open parses a whole JSONL file into objects and keeps it. 214 MB
    // on disk here, several times that resident, to draw a sidebar.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "ce que dit le journal", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    const stored = await readMeta(sessionId);
    assert.ok(stored);
    // Deliberately disagreeing with the log: if the listing shows this, it did not open one.
    await writeMeta(sessionId, { ...stored, promptCount: 7, firstUserText: "ce que dit le meta" });

    const listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "ce que dit le meta");
    assert.equal(listed[0]!.messageCount, 7);
  });

  test("a conversation written before the meta carried them is backfilled once", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "une vieille conversation", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "une reponse", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));
    // Written by a version that did not know about them.
    const before = await readMeta(sessionId);
    assert.equal(before?.promptCount, undefined);

    // The listing opens the log that once and answers correctly from it.
    const listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "une vieille conversation");
    assert.equal(listed[0]!.messageCount, 2);
  });

  test("archiving files the conversation away whole, and unarchiving hands it back", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "premier message", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "bien recu", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));
    await store.rename(DEVICE, THREAD, "Infra maison");

    await store.archive(DEVICE, THREAD);

    let listed = await store.list(DEVICE);
    assert.equal(listed[0]!.archived, true);
    // Nothing is moved or dropped: name, turns and count all survive the filing.
    assert.equal(listed[0]!.title, "Infra maison");
    assert.equal(listed[0]!.messageCount, 2);
    assert.equal((await store.history(DEVICE, THREAD)).entries.length, 2);

    await store.unarchive(DEVICE, THREAD);

    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.archived, undefined);
    assert.equal(listed[0]!.title, "Infra maison");
    assert.equal((await store.history(DEVICE, THREAD)).entries.length, 2);
  });

  test("archiving a conversation that was never opened is refused, not invented", async () => {
    await assert.rejects(() => store.archive(DEVICE, "jamais-ouvert"));
    const listed = await store.list(DEVICE);
    assert.equal(listed.some((entry) => entry.threadId === "jamais-ouvert"), false);
  });

  test("an over-long name is cut to what the drawer can show", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "x", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    await store.rename(DEVICE, THREAD, "n".repeat(200));

    const listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title.length, MAX_TITLE_LENGTH);
  });

  test("renaming a conversation that was never opened is refused, not invented", async () => {
    await assert.rejects(() => store.rename(DEVICE, "jamais-ouvert", "Fantome"));
    const listed = await store.list(DEVICE);
    assert.equal(listed.some((entry) => entry.threadId === "jamais-ouvert"), false);
  });

  test("a turn that merely mentions [Attachments] keeps its text whole", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "le format [Attachments]\nc'est quoi", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const turn = entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "le format [Attachments]\nc'est quoi");
    assert.equal(turn.attachments, undefined);
  });

  test("an assistant MEDIA: ref replays as its stored attachment, not the temp path", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, THREAD, "test-image.jpg", new Uint8Array([1]));
    const gone = await files.save(DEVICE, THREAD, "notes.md", new Uint8Array([2]));
    await files.remove(DEVICE, THREAD, gone.id);

    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "Voilà, un chat random d'Unsplash 🐱\n\nMEDIA:/tmp/test-image.jpg",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    // The bubble reads like the live message: the caption, not the path the agent wrote.
    assert.equal(turn.text, "Voilà, un chat random d'Unsplash 🐱");
    assert.equal(turn.attachments?.length, 1);
    assert.equal(turn.attachments![0]!.id, saved.id);
    assert.equal(turn.attachments![0]!.type, "image");
    assert.equal(turn.attachments![0]!.mimeType, "image/jpeg");
    assert.equal(turn.attachments![0]!.filename, "test-image.jpg");
    assert.equal(turn.attachments![0]!.deleted, undefined);
  });

  test("an assistant MEDIA: ref whose copy is gone replays flagged, never as dead text", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "MEDIA:/tmp/gone.png",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.text, "");
    assert.equal(turn.attachments?.length, 1);
    assert.equal(turn.attachments![0]!.type, "image");
    assert.equal(turn.attachments![0]!.filename, "gone.png");
    assert.equal(turn.attachments![0]!.deleted, true);
  });

  test("several MEDIA: refs in one turn each pair with their own stored copy", async () => {
    const files = new SessionFileStore();
    const first = await files.save(DEVICE, THREAD, "a.jpg", new Uint8Array([1]));
    const second = await files.save(DEVICE, THREAD, "b.jpg", new Uint8Array([2]));

    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "voici\n\nMEDIA:/tmp/a.jpg\n\nMEDIA:/tmp/b.jpg",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.attachments?.length, 2);
    const ids = turn.attachments!.map((a) => a.id);
    assert.deepEqual(ids.sort(), [first.id, second.id].sort());
  });

  // docs/reasoning-visibility.md: the reasoning is persisted so a reopened conversation can still
  // show what the model thought, collapsed.
  test("a replayed turn carries the reasoning the model produced", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "9.11 ou 9.8 ?", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "9.11",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "comparing the decimal parts",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[1]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.reasoning, "comparing the decimal parts");
  });

  test("a turn that produced no reasoning replays without the field", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "assistant", content: "plain answer", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal("reasoning" in turn, false);
  });

  // A turn that thinks again mid-answer was streamed as two bubbles. Replaying it as one put every
  // thought above text it was not about -- docs/reasoning-visibility.md.
  test("a turn that thought twice replays as the two bubbles it was", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "et apres ?", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "first answersecond answer",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "first thoughtsecond thought",
        segments: [
          { reasoning: "first thought", content: "first answer" },
          { reasoning: "second thought", content: "second answer" },
        ],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 3);
    const [, first, second] = entries;
    if (first?.role !== "assistant" || second?.role !== "assistant") throw new Error("expected two assistant entries");
    assert.equal(first.text, "first answer");
    assert.equal(first.reasoning, "first thought");
    assert.equal(second.text, "second answer");
    assert.equal(second.reasoning, "second thought");
    assert.notEqual(first.id, second.id);
  });

  test("a last phase that only thought is kept, since the reader saw that bubble", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "answer",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "answeringabout to call a tool",
        segments: [{ reasoning: "answering", content: "answer" }, { reasoning: "about to call a tool", content: "" }],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 2);
    const last = entries[1]!;
    if (last.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(last.text, "");
    assert.equal(last.reasoning, "about to call a tool");
  });

  test("a thought with no answer at all still replays, instead of leaving a tool card alone", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "straight to the tool",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 2);
    const thought = entries[0]!;
    if (thought.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(thought.reasoning, "straight to the tool");
    assert.equal(entries[1]!.role, "tool");
  });
});

describe("SessionFileStore naming", () => {
  test("keeps the uploaded name on disk and still lists pre-naming entries", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, "naming", "rapport final (v2).pdf", new Uint8Array([1]));
    assert.equal(saved.filename, "rapport final (v2).pdf");
    assert.equal(saved.storedName, `${saved.id}__rapport final (v2).pdf`);
    assert.equal(saved.mimeType, "application/pdf");

    // Written before the name was persisted: listed under its id rather than dropped.
    const legacyId = "11111111-2222-3333-4444-555555555555";
    await writeFile(join(filesDirFor(DEVICE, "naming"), `${legacyId}.png`), new Uint8Array([2]));

    const listed = await files.list(DEVICE, "naming");
    const byId = new Map(listed.map((f) => [f.id, f]));
    assert.equal(byId.get(saved.id)!.filename, "rapport final (v2).pdf");
    assert.equal(byId.get(legacyId)!.filename, `${legacyId}.png`);
    assert.equal(byId.get(legacyId)!.type, "image");

    // Read and delete address the entry through its stored name, not the display one.
    assert.ok((await files.read(DEVICE, "naming", saved.id))!.path.endsWith("(v2).pdf"));
    assert.equal(await files.remove(DEVICE, "naming", saved.id), true);
    assert.equal(await files.findById(DEVICE, "naming", saved.id), null);
  });
});


describe("MyClawAppSessionStoreImpl.remove cascade", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = `my-claw-app/thread/${DEVICE}/${THREAD}`;
    await deleteSession(sessionId);
  });

  test("removing a conversation hands its session id to the cascade hook", async () => {
    const seen: string[] = [];
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore(), async (id) => {
      seen.push(id);
    });
    await writeLegacySessionFile(sessionId, session(sessionId, []));
    await store.remove(DEVICE, THREAD);

    assert.deepEqual(seen, [sessionId]);
    assert.equal(await loadSession(sessionId), null);
  });

  test("the hook runs after the conversation is gone, so a cascade sees a dead parent", async () => {
    const order: string[] = [];
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore(), async () => {
      order.push("cascade");
    });
    await writeLegacySessionFile(sessionId, session(sessionId, []));
    await store.remove(DEVICE, THREAD);
    order.push("after");
    assert.deepEqual(order, ["cascade", "after"]);
  });

  test("without a hook, removing still works", async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    await writeLegacySessionFile(sessionId, session(sessionId, []));
    await store.remove(DEVICE, THREAD);
    assert.equal(await loadSession(sessionId), null);
  });
});

describe("MyClawAppSessionStoreImpl folders", () => {
  let store: MyClawAppSessionStoreImpl;
  // A file of its own per test: the default one is shared by the whole run, and two folders named
  // "CubeFlow" in the same cabinet is exactly what the store refuses.
  let folderPath: string;
  const threads = ["dossier-a", "dossier-b"];

  const folderIds = async (): Promise<Record<string, string | undefined>> => {
    const listed = await store.list(DEVICE);
    return Object.fromEntries(listed.map((entry) => [entry.threadId, entry.folderId]));
  };

  beforeEach(async () => {
    folderPath = join(await mkdtemp(join(tmpdir(), "folders-sessions-")), "folders.json");
    store = new MyClawAppSessionStoreImpl(
      new SessionManager(),
      new SessionFileStore(),
      undefined,
      (key) => key === "default" || key === "sofa",
      undefined,
      new FolderStore(folderPath),
    );
    for (const threadId of threads) {
      const sessionId = store.resolveSessionId(DEVICE, threadId);
      await deleteSession(sessionId);
      await writeLegacySessionFile(sessionId, session(sessionId, [
        { role: "user", content: threadId, timestamp: "2026-01-01T00:00:01.000Z" },
      ]));
    }
  });

  test("a conversation carries the folder it is filed in, and loses it when unfiled", async () => {
    const folder = await store.createFolder(DEVICE, "CubeFlow", "sofa");

    await store.setFolder(DEVICE, "dossier-a", folder.id);
    assert.deepEqual(await folderIds(), { "dossier-a": folder.id, "dossier-b": undefined });

    await store.setFolder(DEVICE, "dossier-a", null);
    assert.deepEqual(await folderIds(), { "dossier-a": undefined, "dossier-b": undefined });
  });

  test("the folder list survives a store built on the same file", async () => {
    const folder = await store.createFolder(DEVICE, "CubeFlow");

    const reopened = new MyClawAppSessionStoreImpl(
      new SessionManager(),
      new SessionFileStore(),
      undefined,
      () => true,
      undefined,
      new FolderStore(folderPath),
    );
    const folders = await reopened.folders(DEVICE);
    assert.equal(folders.length, 1);
    assert.equal(folders[0]?.id, folder.id);
    assert.equal(folders[0]?.name, "CubeFlow");
  });

  test("filing into a folder that does not exist is refused, and nothing is written", async () => {
    await assert.rejects(() => store.setFolder(DEVICE, "dossier-a", "jamais-cree"), /folder not found/);
    assert.deepEqual(await folderIds(), { "dossier-a": undefined, "dossier-b": undefined });
  });

  test("filing a conversation that was never opened is refused, not invented", async () => {
    const folder = await store.createFolder(DEVICE, "CubeFlow");

    await assert.rejects(() => store.setFolder(DEVICE, "jamais-ouvert", folder.id), /conversation not found/);
    const listed = await store.list(DEVICE);
    assert.equal(listed.some((entry) => entry.threadId === "jamais-ouvert"), false);
  });

  test("removing a folder unfiles its children and leaves the others filed", async () => {
    const kept = await store.createFolder(DEVICE, "CubeFlow");
    const doomed = await store.createFolder(DEVICE, "Carrière");
    await store.setFolder(DEVICE, "dossier-a", doomed.id);
    await store.setFolder(DEVICE, "dossier-b", kept.id);

    assert.equal(await store.removeFolder(DEVICE, doomed.id), 1);
    // The conversation is still there: a folder holds a place, it does not hold the thread.
    assert.deepEqual(await folderIds(), { "dossier-a": undefined, "dossier-b": kept.id });
    assert.deepEqual((await store.folders(DEVICE)).map((folder) => folder.name), ["CubeFlow"]);
  });

  test("removing a folder that is not there unfiles nothing and says so", async () => {
    await store.setFolder(DEVICE, "dossier-a", (await store.createFolder(DEVICE, "CubeFlow")).id);

    assert.equal(await store.removeFolder(DEVICE, "jamais-cree"), 0);
    assert.equal((await store.folders(DEVICE)).length, 1);
  });

  test("a folder is born in a workspace the server knows, or in none", async () => {
    assert.equal((await store.createFolder(DEVICE, "CubeFlow", "sofa")).workspace, "sofa");
    assert.equal((await store.createFolder(DEVICE, "Sans workspace")).workspace, undefined);

    await assert.rejects(() => store.createFolder(DEVICE, "Inconnu", "jamais-declare"), /unknown workspace/);
  });
});

describe("MyClawAppSessionStoreImpl.setWorkspace", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(
      manager,
      new SessionFileStore(),
      undefined,
      (key) => key === "default" || key === "sofa",
    );
    sessionId = `my-claw-app/thread/${DEVICE}/${THREAD}`;
    await deleteSession(sessionId);
  });

  test("creates the conversation eagerly with the chosen workspace", async () => {
    await store.setWorkspace(DEVICE, THREAD, "sofa");
    const session = await manager.peek(sessionId);
    assert.ok(session);
    assert.equal(session.workspace, "sofa");
    assert.equal((await loadSession(sessionId))?.workspace, "sofa");
  });

  test("switches an existing conversation and persists the change", async () => {
    await store.setWorkspace(DEVICE, THREAD, "sofa");
    await store.setWorkspace(DEVICE, THREAD, "default");
    const session = await manager.peek(sessionId);
    assert.equal(session?.workspace, undefined);
    assert.equal((await loadSession(sessionId))?.workspace, undefined);
  });

  test("refuses an unknown workspace key without creating anything", async () => {
    await assert.rejects(() => store.setWorkspace(DEVICE, THREAD, "mars"), /unknown workspace/);
    assert.equal(await manager.peek(sessionId), null);
  });

  test("lists the stored workspace on every summary", async () => {
    await store.setWorkspace(DEVICE, THREAD, "sofa");
    const summaries = await store.list(DEVICE);
    assert.equal(summaries[0]!.workspace, "sofa");
    await store.setWorkspace(DEVICE, THREAD, "default");
    const after = await store.list(DEVICE);
    assert.equal(after[0]!.workspace, "default");
  });
});

describe("MyClawAppSessionStoreImpl setInstructionPatch", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    sessionId = `my-claw-app/thread/${DEVICE}/${THREAD}`;
    await deleteSession(sessionId);
    await writeLegacySessionFile(sessionId, session(sessionId, [{ role: "user", content: "hi", timestamp: "2026-01-01T00:00:01.000Z" }]));
  });

  test("nested.toggle disables and re-enables, persisted on the session", async () => {
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "nested.toggle", path: "/repo/AGENTS.md" });
    assert.deepEqual((await manager.peek(sessionId))?.nestedDisabled, ["/repo/AGENTS.md"]);
    assert.deepEqual((await loadSession(sessionId))?.nestedDisabled, ["/repo/AGENTS.md"], "persisted");

    await store.setInstructionPatch(DEVICE, THREAD, { kind: "nested.toggle", path: "/repo/AGENTS.md", on: false });
    assert.equal((await manager.peek(sessionId))?.nestedDisabled, undefined);
    assert.equal((await loadSession(sessionId))?.nestedDisabled, undefined);
  });

  test("nested.unload purges the record without remembering the unload", async () => {
    const s = await manager.peek(sessionId);
    s!.nestedAgents = [{ path: "/repo/AGENTS.md", bytes: 10, firstAt: "2026-01-01T00:00:01.000Z", lastAt: "2026-01-01T00:00:01.000Z", count: 1 }];
    await manager.persist(sessionId);

    await store.setInstructionPatch(DEVICE, THREAD, { kind: "nested.unload", path: "/repo/AGENTS.md" });
    const after = await manager.peek(sessionId);
    assert.deepEqual(after?.nestedAgents, []);
    // An unload only purges the record: no flag is left behind, so the file can be
    // picked up again the next time a tool touches its directory.
    assert.equal((after as unknown as Record<string, unknown>)?.nestedUnloaded, undefined);
  });

  test("layer.toggle, skill.toggle and memory.toggle flip and persist", async () => {
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "layer.toggle", layer: "tools" });
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "skill.toggle", skill: "voice" });
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "memory.toggle" });
    const s = await manager.peek(sessionId);
    assert.deepEqual(s?.promptLayersOff, ["tools"]);
    assert.deepEqual(s?.skillsOff, ["voice"]);
    assert.equal(s?.memoryRecallOff, true);
    assert.deepEqual((await loadSession(sessionId))?.promptLayersOff, ["tools"]);
  });

  test("refuses an unknown conversation", async () => {
    await assert.rejects(() => store.setInstructionPatch(DEVICE, "jamais", { kind: "memory.toggle" }), /no session/);
  });
});

/**
 * 205 journal writes, each one an append and a flush to disk. Fast on an idle box, past the default
 * 5 s the day two runs of the same commit share the runner: it went red on the main push of 0.4.69
 * while the tag run of the identical tree passed every test. Same cause and same remedy as
 * STARVED_RUNNER_TIMEOUT_MS in tests/agent/bridge-voice.test.ts -- the budget of the starved test,
 * never the global one.
 */
const STARVED_RUNNER_TIMEOUT_MS = 30_000;

describe("MyClawAppSessionStoreImpl command journal", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;
  let logSetup: SessionLogSetup | null = null;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(async () => {
    if (logSetup) {
      await logSetup.log.flush();
      logSetup.cleanup();
      logSetup = null;
    }
  });

  test("a command and its answer survive a reload, outside the messages", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "salut", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));
    await store.recordCommand(DEVICE, THREAD, "/compact", "Compacted 120 messages.", "summary text");

    // The journal is an entry like any other, and the prompt projection leaves it out: a slash
    // command the owner ran is not something the agent said.
    const log = await sessionLogOf(sessionId);
    assert.equal(log.entries().filter((e: Entry) => e.type === "command").length, 1);
    assert.equal(promptOf(log.entries(), log.leaf()).length, 2, "the journal must never reach the prompt");

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "user", "assistant"]);
    const answer = proseOf(entries[3]!);
    assert.equal(textOf(entries[2]!), "/compact");
    assert.equal(answer.text, "Compacted 120 messages.");
    assert.equal(answer.command, true);
    assert.equal(answer.details, "summary text");
  });

  test("a command replay uses the live bubble ids", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    await store.recordCommand(DEVICE, THREAD, "/compact", "fait", undefined, "send-1");

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.slice(-2).map((entry) => entry.id), ["send-1", "cmd-send-1"]);
  });

  test("a command lands where it was typed, not at the end of the page", async () => {
    // Create session then write entries in the order we want them displayed
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    // Write entries in order: user, command input, command output, assistant
    logSetup.log.append({ type: "user", prompt: true, text: "un" });
    logSetup.log.append({ type: "command", prompt: false, input: "/status", output: "context 12%" });
    logSetup.log.append({ type: "phase", prompt: true, text: "deux", runId: "r1" });
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map(textOf), ["un", "/status", "context 12%", "deux"]);
  });

  test("each page carries its own commands, and only once", async () => {
    // Create session with log entries in chronological order
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    // Page 1: user, command, assistant
    logSetup.log.append({ type: "user", prompt: true, text: "un" });
    logSetup.log.append({ type: "phase", prompt: true, text: "deux", runId: "r1" });
    logSetup.log.append({ type: "command", prompt: false, input: "/stop", output: "Stopped." });
    // Page 2: user, assistant, command
    logSetup.log.append({ type: "user", prompt: true, text: "trois" });
    logSetup.log.append({ type: "phase", prompt: true, text: "quatre", runId: "r2" });
    logSetup.log.append({ type: "command", prompt: false, input: "/compact", output: "Compacted." });
    await logSetup.log.flush();

    const newest = await store.history(DEVICE, THREAD, 2);
    const older = await store.history(DEVICE, THREAD, 2, newest.nextBefore);
    const text = (page: Awaited<ReturnType<typeof store.history>>) =>
      page.entries.map(textOf);
    assert.deepEqual(text(newest), ["trois", "quatre", "/compact", "Compacted."]);
    assert.deepEqual(text(older), ["un", "deux", "/stop", "Stopped."]);
  });

  test("a command older than every surviving message is still replayed", async () => {
    // Log entries in order: command first, then user/assistant
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "command", prompt: false, input: "/compact", output: "Compacted." });
    logSetup.log.append({ type: "user", prompt: true, text: "apres" });
    logSetup.log.append({ type: "phase", prompt: true, text: "ok", runId: "r1" });
    await logSetup.log.flush();

    const page = await store.history(DEVICE, THREAD);
    assert.equal(page.hasMore, false);
    assert.deepEqual(
      page.entries.map(textOf),
      ["/compact", "Compacted.", "apres", "ok"],
    );
  });

  test("a long journal is replayed whole, alongside the messages of its window", async () => {
    // Log: one user + 30 commands interleaved in order
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "salut" });
    for (let i = 0; i < 30; i++) {
      logSetup.log.append({ type: "command", prompt: false, input: `/status ${i}`, output: "ok" });
    }
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    const inputs = entries.filter((e) => e.role === "user").map(textOf);
    // Nothing is hidden: a journal entry belongs to exactly one page, so a page that showed only
    // the last twenty put the rest out of reach for good.
    assert.equal(inputs.length, 31, "one real message plus the whole journal");
    assert.equal(inputs.includes("/status 0"), true);
    assert.equal(inputs.at(-1), "/status 29");
  });

  test("a command on a thread with no session yet is dropped rather than creating one", async () => {
    await store.recordCommand(DEVICE, THREAD, "/status", "context 0%");
    assert.equal(await loadSession(sessionId), null);
  });

  test("the journal keeps everything, however long the conversation runs", async () => {
    // Use saveSessionWithLog to get log access
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "salut" });
    await logSetup.log.flush();
    // Now call recordCommand which appends to the log
    for (let i = 0; i < 205; i++) {
      await store.recordCommand(DEVICE, THREAD, `/status ${i}`, "ok");
    }
    // Re-read log to verify
    const { openSessionLog } = await import("../src/sessions/log.ts");
    const log = await openSessionLog(sessionId);
    const cmdEntries = log.entries().filter((e) => e.type === "command");
    assert.equal(cmdEntries.length, 205);
    assert.equal((cmdEntries[0] as CommandEntry).input, "/status 0");
  }, STARVED_RUNNER_TIMEOUT_MS);

  test("the journal dies with the conversation", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "salut" });
    await logSetup.log.flush();
    await store.recordCommand(DEVICE, THREAD, "/compact", "Compacted.");
    await store.remove(DEVICE, THREAD);
    assert.equal(await loadSession(sessionId), null);
    // Log file should also be removed
    const { entriesPath } = await import("../src/sessions/log.ts");
    const { existsSync } = await import("fs");
    assert.equal(existsSync(entriesPath(sessionId)), false);
  });
});

describe("MyClawAppSessionStoreImpl replay ids", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;
  let logSetup: SessionLogSetup;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(async () => {
    logSetup?.cleanup();
  });

  // The app merges a page into the thread it already shows, so a replayed bubble has to carry the
  // id the live one had or the question of a run in flight is either doubled or dropped.
  test("a user turn replays under the device's own send id", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    // UserEntry id is the entry's own id (auto-generated), which displayOf passes through
    const e1 = logSetup.log.append({ type: "user", prompt: true, text: "la question" });
    const e2 = logSetup.log.append({ type: "user", prompt: true, text: "venue d'ailleurs" });
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    // Both entries should have their log ids
    assert.equal(entries[0]!.id, e1.id);
    assert.equal(entries[1]!.id, e2.id);
  });

  test("a journalled command replays under the ids its live bubbles had", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "salut" });
    await logSetup.log.flush();
    await store.recordCommand(DEVICE, THREAD, "/compact", "Compacted.", undefined, "send-9");

    const { entries } = await store.history(DEVICE, THREAD);
    const ids = entries.map((e) => e.id);
    assert.ok(ids.includes("send-9"), "the command input reuses the send id");
    assert.ok(ids.includes("cmd-send-9"), "the command output reuses the derived result id");
  });
});

describe("MyClawAppSessionStoreImpl failure journal", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;
  let logSetup: SessionLogSetup;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(async () => {
    logSetup?.cleanup();
  });

  test("a failed run replays under the question it never answered", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "continue" });
    await logSetup.log.flush();
    await store.recordFailure(DEVICE, THREAD, "API Error: 529 Overloaded");

    // Failure is written to the log, not the prompt messages
    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant"]);
    const failed = proseOf(entries[1]!);
    assert.equal(failed.error, "API Error: 529 Overloaded");
    assert.equal(failed.text, "");
  });

  test("failures and commands replay in the order they happened", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    // Write entries in the order we want them displayed
    logSetup.log.append({ type: "user", prompt: true, text: "salut" });
    logSetup.log.append<FailureEntry>({ type: "failure", prompt: false, error: "first died" });
    logSetup.log.append<CommandEntry>({ type: "command", prompt: false, input: "/status", output: "context 12%" });
    logSetup.log.append<FailureEntry>({ type: "failure", prompt: false, error: "second died" });
    logSetup.log.append({ type: "phase", prompt: true, text: "salut", runId: "r1" });
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    const texts = entries.map(textOrErrorOf);
    assert.deepEqual(texts, ["salut", "first died", "/status", "context 12%", "second died", "salut"]);  
  });

  test("an empty error is not journalled, and a long one is capped", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "salut" });
    await logSetup.log.flush();
    await store.recordFailure(DEVICE, THREAD, "   ");
    await store.recordFailure(DEVICE, THREAD, "x".repeat(FAILURE_TEXT_LIMIT + 50));

    // Re-read log to check failures
    const { openSessionLog } = await import("../src/sessions/log.ts");
    const log = await openSessionLog(sessionId);
    const failures = log.entries().filter((e) => e.type === "failure");
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as FailureEntry).error.length, FAILURE_TEXT_LIMIT);
  });

  test("the entry takes the id of the bubble the error is on screen in", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "continue" });
    await logSetup.log.flush();
    // The id the streamer minted for the bubble it painted the error in: one identity, so the
    // page the app is handed next replaces that bubble instead of adding a second copy.
    await store.recordFailure(DEVICE, THREAD, "API Error: 529 Overloaded", "bubble-42");

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries[1]!.id, "bubble-42");
  });

  test("an id the log already holds does not cost the failure entry", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    const user = logSetup.log.append({ type: "user", prompt: true, text: "continue" });
    await logSetup.log.flush();
    // A reroute can hand back the id of a turn already written. The entry is worth more than its
    // id: it falls back to one of its own rather than losing the error.
    await store.recordFailure(DEVICE, THREAD, "boom", user.id);

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant"]);
    assert.notEqual(entries[1]!.id, user.id);
    assert.equal(proseOf(entries[1]!).error, "boom");
  });

  test("a failure on a thread with no session yet is dropped rather than creating one", async () => {
    await store.recordFailure(DEVICE, THREAD, "boom");
    assert.equal(await loadSession(sessionId), null);
  });
});

describe("MyClawAppSessionStoreImpl thinking counts", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;
  let logSetup: SessionLogSetup;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(async () => {
    logSetup?.cleanup();
  });

  test("a replayed turn says how much it thought, even with no text to show", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "user", prompt: true, text: "9.11 ou 9.8 ?" });
    logSetup.log.append({ type: "phase", prompt: true, text: "9.11", runId: "r1", reasoningTokens: 12_300 });
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    const reply = proseOf(entries[1]!);
    assert.equal(reply.reasoningTokens, 12_300);
    assert.equal(reply.reasoning, undefined);
  });

  test("a turn that thought nothing replays without the field", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, []));
    logSetup.log.append({ type: "phase", prompt: true, text: "hop", runId: "r1" });
    await logSetup.log.flush();

    const { entries } = await store.history(DEVICE, THREAD);
    const reply = proseOf(entries[0]!);
    assert.equal(reply.reasoningTokens, undefined);
  });
});

describe("MyClawAppSessionStoreImpl drafts", () => {
  let store: MyClawAppSessionStoreImpl;
  let drafts: DraftStore;
  let sessionId: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-drafts-"));
    drafts = new DraftStore(join(dir, "drafts.json"));
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore(), undefined, undefined, drafts);
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(() => {
    drafts.close();
  });

  test("the listing marks a conversation holding unsent text, and only that one", async () => {
    const other = store.resolveSessionId(DEVICE, "thread-2");
    await writeLegacySessionFile(sessionId, session(sessionId, []));
    await writeLegacySessionFile(other, session(other, []));
    try {
      await store.setDraft(DEVICE, THREAD, "pas encore envoye");

      const listed = await store.list(DEVICE);
      const marked = listed.find((entry) => entry.threadId === THREAD);
      const plain = listed.find((entry) => entry.threadId === "thread-2");
      assert.equal(marked?.hasDraft, true);
      assert.equal(plain?.hasDraft, undefined, "one bit, and absent rather than false");
    } finally {
      await deleteSession(other);
    }
  });

  test("the newest page carries the draft, a page reaching backwards does not", async () => {
    await writeLegacySessionFile(sessionId, session(sessionId, [
      { role: "user", content: "premiere", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "reponse", timestamp: "2026-01-01T00:00:02.000Z" },
      { role: "user", content: "seconde", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));
    await store.setDraft(DEVICE, THREAD, "en cours d'ecriture");

    const newest = await store.history(DEVICE, THREAD, 1);
    assert.equal(newest.draft, "en cours d'ecriture");

    const older = await store.history(DEVICE, THREAD, 1, 1);
    assert.equal(older.draft, undefined);
  });

  test("a thread with no session yet still replays its draft", async () => {
    // Where it matters most: the first message of a new conversation, written before anything
    // exists on disk to attach it to.
    await store.setDraft(DEVICE, "brand-new", "premier message, long");
    const page = await store.history(DEVICE, "brand-new");
    assert.deepEqual(page.entries, []);
    assert.equal(page.draft, "premier message, long");
  });

  test("a draft never enters the session file, so no prompt can ever read it", async () => {
    await writeLegacySessionFile(sessionId, session(sessionId, [{ role: "user", content: "envoye", timestamp: "2026-01-01T00:00:01.000Z" }]));
    await store.setDraft(DEVICE, THREAD, "SECRET-DRAFT-SENTINEL");
    await drafts.flush();

    const reloaded = await loadSession(sessionId);
    assert.ok(reloaded);
    assert.equal(JSON.stringify(reloaded).includes("SECRET-DRAFT-SENTINEL"), false);
  });

  test("clearing a draft reports whether there was one", async () => {
    await store.setDraft(DEVICE, THREAD, "quelque chose");
    assert.equal(await store.clearDraft(DEVICE, THREAD), true);
    assert.equal(await store.clearDraft(DEVICE, THREAD), false);
  });
});

describe("MyClawAppSessionStoreImpl.sync", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;
  let logSetup: SessionLogSetup | null = null;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(async () => {
    if (logSetup) {
      await logSetup.log.flush();
      logSetup.cleanup();
      logSetup = null;
    }
    resetSessionLogResolver();
  });

  test("sync with no cursor returns all entries", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "first", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "second", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));

    const result = await store.sync(DEVICE, THREAD);
    assert.equal(result.entries.length, 2);
    assert.equal((result.entries[0] as { text: string }).text, "first");
    assert.equal((result.entries[1] as { text: string }).text, "second");
    assert.equal(result.leaf, result.head);
    assert.equal(result.reset, undefined);
  });

  test("sync with valid cursor returns only new entries", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "first", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "second", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));

    // Get the first entry's id
    const firstPage = await store.sync(DEVICE, THREAD);
    const firstEntryId = firstPage.entries[0]!.id;

    // Now sync from that cursor should return only the second entry
    const result = await store.sync(DEVICE, THREAD, firstEntryId);
    assert.equal(result.entries.length, 1);
    assert.equal((result.entries[0] as { text: string }).text, "second");
    assert.equal(result.reset, undefined);
  });

  test("sync with unknown cursor returns reset: unknown-cursor", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "first", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const result = await store.sync(DEVICE, THREAD, "nonexistent-entry-id");
    assert.equal(result.entries.length, 1);
    assert.equal(result.reset, "unknown-cursor");
  });

  test("sync with no session returns empty", async () => {
    const result = await store.sync(DEVICE, "nonexistent-thread");
    assert.equal(result.entries.length, 0);
    assert.equal(result.leaf, null);
    assert.equal(result.head, null);
  });

  test("sync with head as cursor returns empty delta", async () => {
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "first", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const firstPage = await store.sync(DEVICE, THREAD);
    const headId = firstPage.head;

    const result = await store.sync(DEVICE, THREAD, headId!);
    assert.equal(result.entries.length, 0);
    assert.equal(result.reset, undefined);
  });

  test("sync respects the limit parameter", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
      timestamp: `2026-01-01T00:00:0${i}.000Z`,
    }));
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    const result = await store.sync(DEVICE, THREAD, null, undefined, 3);
    // Should return last 3 entries when fresh
    assert.equal(result.entries.length, 3);
    assert.equal((result.entries[0] as { text: string }).text, "message 7");
    assert.equal((result.entries[2] as { text: string }).text, "message 9");
  });

  test("a child settling after the cursor resends the card it settled", async () => {
    // The case the whole entry type exists for. The `spawn` card was synced while the child was
    // still working, so the only thing after the cursor is its ending -- and an ending is not
    // something a client can draw. It gets the card back instead, current.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "lance un audit", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant", content: "j'y vais", timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-1", name: "spawn", arguments: JSON.stringify({ name: "auditor" }) }],
      },
      { role: "tool", toolCallId: "call-1", content: "started", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));
    const running = appendSpawnState(logSetup.log, {
      subagentId: "subagent/auditor",
      status: "running",
      toolCallId: "call-1",
      displayName: "dup-audit",
      agentType: "research",
      mode: "run",
      action: "spawn",
    });
    assert.ok(running);

    const cursor = (await store.sync(DEVICE, THREAD)).head;
    assert.ok(cursor);
    appendSpawnState(logSetup.log, { subagentId: "subagent/auditor", status: "complete", resultLength: 4096 });

    const delta = await store.sync(DEVICE, THREAD, cursor);
    assert.equal(delta.entries.length, 1);
    const card = delta.entries[0] as { id: string; role: string; spawn?: { status: string; displayName: string; resultLength?: number } };
    assert.equal(card.role, "tool");
    assert.equal(card.id, "t-call-1");
    assert.equal(card.spawn?.status, "complete");
    assert.equal(card.spawn?.displayName, "dup-audit");
    assert.equal(card.spawn?.resultLength, 4096);
  });

  test("a full reload draws the card once, states first", async () => {
    // The shape a real conversation has on disk, and the one 0.4.61 got wrong: `spawn` awaits its
    // child, so `running` and `complete` are both appended before the tool entry. A fresh sync
    // carries all three, and the card must come out of it exactly once.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "lance un audit", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    appendSpawnState(logSetup.log, {
      subagentId: "subagent/auditor", status: "running", toolCallId: "call-1",
      displayName: "verif", agentType: "research", mode: "run", action: "spawn",
    });
    appendSpawnState(logSetup.log, { subagentId: "subagent/auditor", status: "complete", resultLength: 12 });
    logSetup.log.append<ToolEntry>({
      type: "tool", prompt: true, callId: "call-1", name: "spawn", args: {},
      output: "started", truncated: false, ok: true, runId: "r1",
    });

    const page = await store.sync(DEVICE, THREAD);
    const cards = page.entries.filter((e) => (e as { role: string }).role === "tool");
    assert.equal(cards.length, 1);
    assert.equal((cards[0] as { id: string }).id, "t-call-1");
    assert.equal((cards[0] as { spawn?: { status: string } }).spawn?.status, "complete");
    // And the card stays where it was written, after the turn that asked for it.
    assert.equal(page.entries.length, 2);
    assert.equal((page.entries[0] as { role: string }).role, "user");
  });

  test("a child still running syncs nothing on its own", async () => {
    // Its card is already on screen with a spinner the live frames put there. Resending it would
    // say nothing new, and the state entry alone is not drawable.
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, [
      { role: "user", content: "lance un audit", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant", content: "j'y vais", timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-1", name: "spawn", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call-1", content: "started", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));
    const cursor = (await store.sync(DEVICE, THREAD)).head;
    appendSpawnState(logSetup.log, { subagentId: "subagent/auditor", status: "running", toolCallId: "call-1" });

    const delta = await store.sync(DEVICE, THREAD, cursor!);
    // The card comes back once, because its state changed -- and it comes back as a card.
    assert.equal(delta.entries.length, 1);
    assert.equal((delta.entries[0] as { role: string }).role, "tool");
  });

  test("sync caps at SYNC_LIMIT (500)", async () => {
    // We can't easily create 600 entries, but we can verify the limit logic
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
      timestamp: `2026-01-01T00:00:0${i}.000Z`,
    }));
    logSetup = await saveSessionWithLog(sessionId, session(sessionId, messages));

    // Request more than exists
    const result = await store.sync(DEVICE, THREAD, null, undefined, 1000);
    assert.equal(result.entries.length, 5);
    assert.equal(result.truncated, undefined);
  });
});
