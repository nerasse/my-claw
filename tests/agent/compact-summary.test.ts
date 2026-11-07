/**
 * The summary a compaction produces. There is one engine now, so the summary is the local
 * summarizer's own output rather than something read back out of an engine-owned transcript: it is
 * returned to the caller *and* left in the history as the message the next run resumes from.
 */

import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { compactSession } from "../../src/sessions/compaction.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseFromCompletion, sseResponse } from "../helpers/sse.ts";
import { saveSessionWithLog, type SessionLogSetup } from "../helpers/session-log.ts";
import { deleteSession } from "../../src/sessions/store.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";

let logSetup: SessionLogSetup | undefined;

afterEach(async () => {
  logSetup?.cleanup();
  logSetup = undefined;
});

function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "test-model",
      providers: { test: { baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" } },
      models: [{ id: "test-model", label: "Test", provider: "test" }],
    },
    agents: {},
    // These fixtures are a handful of short entries: the default 20k verbatim tail would swallow
    // the whole conversation and leave the summarizer nothing to stand for.
    context: { autoCompact: { tailTokens: 40 } },
  } as unknown as MyClawConfig;
}

const SESSION_ID = "my-claw-app/thread/neras/compact";

/** Create session with log entries. Long enough for the summarizer to have a middle to replace. */
async function sessionWithLog(): Promise<LegacySessionData> {
  const now = new Date().toISOString();
  const data: LegacySessionData = {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    modelOverride: "test-model",
    messages: [],  // Empty, data is in the log
  };
  logSetup = await saveSessionWithLog(SESSION_ID, data);
  // Add alternating user/assistant entries (14 turns)
  for (let i = 0; i < 14; i++) {
    if (i % 2 === 0) {
      logSetup.log.append({ type: "user", prompt: true, text: `turn ${i} ${"filler ".repeat(20)}` });
    } else {
      logSetup.log.append({ type: "phase", prompt: true, text: `turn ${i} ${"filler ".repeat(20)}`, runId: `r${i}` });
    }
  }
  await logSetup.log.flush();
  return data;
}

function reply(content: string): Response {
  return sseFromCompletion({ choices: [{ message: { content } }], usage: {} });
}

const SUMMARY = `1. What the owner asked 2. What was built ${"and the rest of it ".repeat(5)}`;

test("the summary is returned and left in the history as the message the next run resumes from", async () => {
  const mock = mockFetch(async () => reply(SUMMARY));
  try {
    const s = await sessionWithLog();
    const before = 14;  // 14 entries written to log
    const result = await compactSession(config(), s);
    assert.equal(result.ok, true);
    assert.equal(result.summary, SUMMARY.trim());
    assert.equal(result.beforeCount, before);
    assert.ok(result.afterCount < before);
    // The summary is in the log as a CompactionEntry
    const entries = (await logSetup!.log.all());
    const compactionEntry = entries.find((e) => e.type === "compaction");
    assert.ok(compactionEntry, "a compaction entry must exist in the log");
    assert.ok((compactionEntry as { summary: string }).summary.includes(SUMMARY.trim()));
  } finally {
    mock.restore();
    await deleteSession(SESSION_ID);
  }
});

test("extra instructions ride along in the summarizer's prompt", async () => {
  let sent = "";
  const mock = mockFetch(async (_url, init) => {
    sent = String((init as RequestInit | undefined)?.body ?? "");
    return reply(SUMMARY);
  });
  try {
    const s = await sessionWithLog();
    await compactSession(config(), s, "keep every file path");
    assert.match(sent, /keep every file path/);
  } finally {
    mock.restore();
    await deleteSession(SESSION_ID);
  }
});

test("an empty or too-short summary is refused rather than written over the history", async () => {
  for (const content of ["", "too short"]) {
    const mock = mockFetch(async () => reply(content));
    try {
      const s = await sessionWithLog();
      const beforeCount = (await logSetup!.log.all()).length;
      const result = await compactSession(config(), s);
      assert.equal(result.ok, false);
      assert.equal(result.afterCount, beforeCount);
      // No compaction entry should be added
      const compactionEntries = (await logSetup!.log.all()).filter((e) => e.type === "compaction");
      assert.equal(compactionEntries.length, 0, "a refused compaction must leave the history untouched");
    } finally {
      mock.restore();
      await deleteSession(SESSION_ID);
      logSetup?.cleanup();
      logSetup = undefined;
    }
  }
});

test("a refusal is detected as one instead of being stored as the context", async () => {
  const mock = mockFetch(async () => reply(`I cannot summarize this conversation ${"for you ".repeat(10)}`));
  try {
    const s = await sessionWithLog();
    const result = await compactSession(config(), s);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /refused/);
  } finally {
    mock.restore();
    await deleteSession(SESSION_ID);
  }
});

test("a session too short to compact says so before reaching the wire", async () => {
  const mock = mockFetch(async () => {
    throw new Error("the summarizer must not be called");
  });
  try {
    // Create session with empty log
    const now = new Date().toISOString();
    const data: LegacySessionData = {
      id: SESSION_ID,
      platform: "my-claw-app",
      chatType: "dm",
      createdAt: now,
      lastActiveAt: now,
      messages: [],
    };
    logSetup = await saveSessionWithLog(SESSION_ID, data);
    // Don't add any entries - log is empty
    await logSetup.log.flush();
    const result = await compactSession(config(), data);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /too short/);
  } finally {
    mock.restore();
    await deleteSession(SESSION_ID);
  }
});

/**
 * The live mouth of a running summary -- added 2026-09-12.
 *
 * The summarizer streams now (a one-shot call turned the transport's "time without a byte" budget
 * into a hard ceiling on the whole operation), so the text it is writing can be shown while it is
 * written instead of a bare spinner.
 */
test("the summary is announced as it is written, not only when it is done", async () => {
  const long = `Prior work: ${"the agent ran the filler tool and gathered its output. ".repeat(20)}`;
  const mock = mockFetch(async () => sseResponse(long));
  const fragments: string[] = [];
  const collect = ({ text }: { sessionId: string; text: string }): void => {
    fragments.push(text);
  };
  hooks.on("session:compact:progress", collect);
  try {
    const s = await sessionWithLog();
    const result = await compactSession(config(), s);
    assert.equal(result.ok, true);
    assert.ok(fragments.length >= 2, `expected several fragments, got ${fragments.length}`);
    // Fragments, not a running total: the client accumulates them. Concatenated they are exactly
    // what the summarizer wrote -- nothing repeated, nothing dropped by the batching.
    assert.equal(fragments.join(""), long);
    // Batched: a fragment per token would be a frame per token on the wire.
    assert.ok(fragments.every((f) => f.length >= 1));
    assert.ok(fragments.length < long.length / 4, `too many fragments: ${fragments.length}`);
  } finally {
    hooks.off("session:compact:progress", collect);
    mock.restore();
  }
});
