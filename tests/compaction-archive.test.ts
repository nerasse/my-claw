/**
 * The compaction as it stands since 2026-10-04 -- docs/compaction.md.
 *
 * Three changes, each answering a measured failure. The summary keeps the open work and archives
 * the finished (one conversation's summary had grown to 182 500 characters, until rewriting it no
 * longer fitted the model's output ceiling). The prompt after a boundary is codex's: the owner's
 * recent messages verbatim, then the summary. And the archive is stored on the boundary and indexed
 * for `conversation_search`.
 */

import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { commitCompaction, compactSession, planCompaction, retainedMessages } from "../src/sessions/compaction.ts";
import { splitSummaryOutput } from "../src/sessions/compaction-prompts.ts";
import { claimSpeculation, hasArmedCompaction, pendingSpeculation, resetSpeculations, startSpeculation } from "../src/sessions/compaction-speculative.ts";
import { deleteSession, type LegacySessionData } from "../src/sessions/store.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { sseFromCompletion } from "./helpers/sse.ts";
import { setupSessionLog, writeLegacySessionFile } from "./helpers/session-log.ts";
import type { SessionLog, CompactionEntry, UserEntry, PhaseEntry, ToolEntry } from "../src/sessions/log.ts";
import { contextEntries, promptOf } from "../src/sessions/projection.ts";
import { createConversationSearchTool } from "../src/tools/conversation-search.ts";

const SESSION_ID = "my-claw-app/thread/owner/archive-thread";

function config(tailTokens = 60): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "test-model",
      providers: { test: { baseUrl: "https://test.example.com" } },
      models: [{ id: "test-model", label: "Test", provider: "test" }],
      limit: { context: 128_000, output: 64_000 },
    },
    agents: {},
    context: { autoCompact: { tailTokens } },
  } as unknown as MyClawConfig;
}

let log: SessionLog;
let cleanup: () => void;
let sess: LegacySessionData;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  const now = new Date().toISOString();
  sess = { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
  await writeLegacySessionFile(SESSION_ID, sess);
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanup = setup.cleanup;
});

afterEach(() => {
  resetSpeculations();
  cleanup();
});

function conversation(turns: number, startAt = 1): void {
  for (let i = 0; i < turns; i++) {
    const n = startAt + i;
    log.append<UserEntry>({ type: "user", prompt: true, text: `Question ${n}` });
    log.append<PhaseEntry>({ type: "phase", prompt: true, runId: `r${n}`, text: `Answer ${n}` });
  }
}

function summarizer(reply: (body: string) => string): { bodies: string[]; restore: () => void } {
  const bodies: string[] = [];
  const mock = mockFetch(async (_url, init) => {
    const raw = String(init?.body ?? "{}");
    bodies.push(raw);
    return sseFromCompletion({ choices: [{ message: { content: reply(raw) } }] }) as never;
  });
  return { bodies, restore: () => mock.restore() };
}

const blocks = (summary: string, archive = "(none)") => `<summary>\n${summary}\n</summary>\n<archive>\n${archive}\n</archive>`;
const boundaryOf = async (): Promise<CompactionEntry | undefined> =>
  [...(await log.all())].reverse().find((entry): entry is CompactionEntry => entry.type === "compaction");

test("the answer splits into a summary and an archive, and forgives a model that forgot the tags", () => {
  assert.deepEqual(splitSummaryOutput(blocks("## Goal\nopen", "### Release\n- done")), { summary: "## Goal\nopen", archive: "### Release\n- done" });
  assert.deepEqual(splitSummaryOutput(blocks("## Goal\nopen")), { summary: "## Goal\nopen", archive: "" });
  assert.deepEqual(splitSummaryOutput("## Goal\nno tags at all"), { summary: "## Goal\nno tags at all", archive: "" });
  // An archive left open by a cut still counts: the continuation is what closes it.
  assert.equal(splitSummaryOutput("<summary>s</summary><archive>### A\n- half").archive, "### A\n- half");
});

test("the owner's words are kept newest first until the budget, the oldest cut, then returned in order", () => {
  const kept = retainedMessages(["old ".repeat(200), "middle", "newest"], 20);
  assert.equal(kept.length, 3);
  assert.equal(kept[1], "middle");
  assert.equal(kept[2], "newest");
  assert.match(kept[0]!, /characters cut/);
  assert.deepEqual(retainedMessages(["a", "b", "c"], 0), []);
});

test("at rest nothing is kept but the owner's words: the prompt is his messages, then the summary", async () => {
  conversation(8);
  await log.flush();
  const mock = summarizer(() => blocks("## Goal\nKeep the deployment pipeline green while the runner is rebuilt"));
  try {
    const result = await compactSession(config(), sess);
    assert.equal(result.ok, true, result.reason ?? "");
  } finally {
    mock.restore();
  }
  const boundary = (await boundaryOf())!;
  assert.equal(boundary.firstKeptEntryId, boundary.id, "nothing before it is kept: the prompt resumes after it");
  assert.deepEqual(contextEntries((await log.all()), log.leaf()).map((e) => e.type), ["compaction"]);
  const prompt = promptOf((await log.all()), log.leaf());
  assert.ok(prompt.every((m) => m.role === "user"));
  assert.equal(prompt[prompt.length - 1]!.content.toString().includes("Keep the deployment pipeline green"), true, "the summary is last");
  assert.equal(prompt[prompt.length - 2]!.content, "Question 8", "right after the newest of his words");
  assert.ok(!prompt.some((m) => String(m.content).includes("Answer 8")), "the assistant's prose is not kept");

  // What comes next follows the boundary, untouched.
  log.append<UserEntry>({ type: "user", prompt: true, text: "Next question" });
  assert.equal(promptOf((await log.all()), log.leaf()).at(-1)!.content, "Next question");
  await log.flush();
});

test("a branch ending on the owner's message keeps that message after the summary: the run is about to answer it", async () => {
  conversation(8);
  log.append<UserEntry>({ type: "user", prompt: true, text: "The question being answered" });
  await log.flush();
  const planned = await planCompaction(log, 60);
  assert.ok(planned.ok);
  const kept = planned.plan.entries.find((e) => e.id === planned.plan.firstKeptEntryId);
  assert.equal(kept?.type === "user" && kept.text, "The question being answered");
  assert.ok(!planned.plan.retained.includes("The question being answered"), "not twice");
});

test("between two iterations the turn whose results the run is about to read stays whole", async () => {
  conversation(8);
  log.append<UserEntry>({ type: "user", prompt: true, text: "Read the file" });
  log.append<PhaseEntry>({ type: "phase", prompt: true, runId: "live", text: "Reading" });
  log.append<ToolEntry>({ type: "tool", prompt: true, runId: "live", callId: "c1", name: "read", args: {}, output: "small", truncated: false, ok: true });
  await log.flush();
  const planned = await planCompaction(log, 60);
  assert.ok(planned.ok);
  const kept = planned.plan.entries.slice(planned.plan.entries.findIndex((e) => e.id === planned.plan.firstKeptEntryId));
  assert.deepEqual(kept.map((e) => e.type), ["phase", "tool"]);

  // A turn over the budget is carried by the summary instead: keeping it would free nothing.
  log.append<PhaseEntry>({ type: "phase", prompt: true, runId: "live2", text: "Reading more" });
  log.append<ToolEntry>({ type: "tool", prompt: true, runId: "live2", callId: "c2", name: "read", args: {}, output: "x".repeat(4_000), truncated: false, ok: true });
  await log.flush();
  const big = await planCompaction(log, 60);
  assert.ok(big.ok);
  assert.equal(big.plan.firstKeptEntryId, undefined);
});

test("what finished is archived on the boundary, indexed, and found by conversation_search", async () => {
  conversation(8);
  await log.flush();
  const mock = summarizer(() => blocks("## Goal\nThe next release, now that the runner rebuild is done", "### Runner rebuild\n- Released as quokka-17, commit abc123"));
  try {
    const result = await compactSession(config(), sess);
    assert.equal(result.ok, true, result.reason ?? "");
    assert.equal(result.archive, "### Runner rebuild\n- Released as quokka-17, commit abc123");
  } finally {
    mock.restore();
  }
  assert.equal((await boundaryOf())!.archive, "### Runner rebuild\n- Released as quokka-17, commit abc123");
  assert.ok(!promptOf((await log.all()), log.leaf()).some((m) => String(m.content).includes("quokka-17")), "the archive is never replayed");

  const tool = createConversationSearchTool();
  const found = await tool.execute({ action: "search", source: "archive", query: "quokka" });
  assert.equal(found.success, true);
  const hitId = /\[(a_\d+)\]/.exec(found.output)?.[1];
  assert.ok(hitId, found.output);
  assert.match(found.output, /thread=archive-thread/);
  const read = await tool.execute({ action: "read", hit_id: hitId });
  assert.match(read.output, /Released as quokka-17, commit abc123/);
  // The messages stay their own corpus.
  assert.match((await tool.execute({ action: "search", query: "quokka" })).output, /No matching conversation messages/);
});

test("a summary from before the archive is archived as it is, once, and the model is told not to rewrite it", async () => {
  conversation(8);
  // A boundary as every one was before: no archive field, the whole history in its summary.
  log.append<CompactionEntry>({ type: "compaction", prompt: true, summary: "Old summary: the zebra chantier, released long ago", firstKeptEntryId: "", tokensBefore: 1, count: 16 });
  const legacyId = (await boundaryOf())!.id;
  // Point the legacy floor at the turns after it, as a real one would.
  conversation(8, 100);
  const firstAfter = (await log.all()).find((e) => e.type === "user" && e.text === "Question 100")!;
  ((await log.all()).find((e) => e.id === legacyId) as CompactionEntry).firstKeptEntryId = firstAfter.id;
  await log.flush();

  const first = summarizer(() => blocks("## Goal\nOnly what is open now, the zebra chantier being finished", "### Question 100\n- answered"));
  try {
    assert.equal((await compactSession(config(), sess)).ok, true);
    assert.match(first.bodies[0]!, /predates the archive and has been archived as it is/);
  } finally {
    first.restore();
  }
  const archived = (await boundaryOf())!.archive!;
  assert.match(archived, /## Summary before the archive\n\nOld summary: the zebra chantier, released long ago/);
  assert.match(archived, /## Finished since\n\n### Question 100/);

  // The next pass reads a summary that is already the open work: no legacy rule, no second copy.
  conversation(8, 200);
  await log.flush();
  const second = summarizer(() => blocks("## Goal\nStill only the open work, nothing new finished"));
  try {
    assert.equal((await compactSession(config(), sess)).ok, true);
    assert.doesNotMatch(second.bodies[0]!, /predates the archive/);
    assert.match(second.bodies[0]!, /never archive them again/);
  } finally {
    second.restore();
  }
  assert.equal((await boundaryOf())!.archive, "");
});

test("the next pass carries the owner's kept words: they lead the transcript and stay candidates", async () => {
  conversation(8);
  await log.flush();
  const first = summarizer(() => blocks("## Goal\nThe first summary, long enough to be accepted by the gate"));
  try {
    assert.equal((await compactSession(config(), sess)).ok, true);
  } finally {
    first.restore();
  }
  assert.ok((await boundaryOf())!.retained!.includes("Question 8"));

  conversation(6, 300);
  await log.flush();
  const second = summarizer(() => blocks("## Goal\nThe second summary, long enough to be accepted by the gate"));
  try {
    assert.equal((await compactSession(config(), sess)).ok, true);
    assert.match(second.bodies[0]!, /User: Question 8/, "the summarizer reads what the prompt still showed");
  } finally {
    second.restore();
  }
  assert.equal((await boundaryOf())!.retained!.at(-1), "Question 305");
  // His older words are still there while the budget holds them: they leave only for newer ones.
  assert.ok((await boundaryOf())!.retained!.includes("Question 8"), "the previous boundary's kept words stay candidates");
});

test("a summary committed later keeps the turns that landed after it was planned", async () => {
  conversation(8);
  await log.flush();
  const planned = await planCompaction(log, 60);
  assert.ok(planned.ok);
  assert.equal(planned.plan.firstKeptEntryId, undefined);
  // A background summary is claimed minutes later; the owner wrote in the meantime.
  log.append<UserEntry>({ type: "user", prompt: true, text: "Written while it was summarizing" });
  log.append<PhaseEntry>({ type: "phase", prompt: true, runId: "late", text: "Answered meanwhile" });
  const boundary = await commitCompaction(log, planned.plan, "## Goal\nthe summary", "");
  const late = (await log.all()).find((e) => e.type === "user" && e.text === "Written while it was summarizing")!;
  assert.equal(boundary.firstKeptEntryId, late.id);
  assert.deepEqual(contextEntries((await log.all()), log.leaf()).map((e) => e.type), ["compaction", "user", "phase"]);
  await log.flush();
});

test("a background summary that keeps nothing is still claimable, and keeps what was written meanwhile", async () => {
  conversation(8);
  await log.flush();
  const mock = summarizer(() => blocks("## Goal\nThe background summary, long enough for the gate", "### Done early\n- archived in the background"));
  try {
    startSpeculation(config(), sess);
    await pendingSpeculation(sess.id);
    assert.equal(hasArmedCompaction(sess.id), true);
  } finally {
    mock.restore();
  }
  log.append<UserEntry>({ type: "user", prompt: true, text: "Written after the snapshot" });
  await log.flush();

  const claimed = await claimSpeculation(config(), sess);
  assert.equal(claimed?.ok, true, "a plan naming no kept entry must not read as a rewound one");
  assert.equal(claimed?.archive, "### Done early\n- archived in the background");
  assert.equal(promptOf((await log.all()), log.leaf()).at(-1)!.content, "Written after the snapshot");
  await log.flush();
});
