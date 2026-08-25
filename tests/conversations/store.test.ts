import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveAssistantMessage,
  backfillConversationArchive,
  archiveChannelMessage,
  closeConversationArchive,
  indexSessionArchive,
  indexSessionEntries,
  readConversationHit,
  searchConversationArchive,
} from "../../src/conversations/store.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

let dbPath = "";
let sequence = 0;

function message(overrides: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "msg-1",
    platform: "my-claw-app",
    userId: "user-1",
    chatId: "chat-1",
    chatType: "dm",
    text: "default message",
    attachments: [],
    isForwarded: false,
    raw: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionData>): SessionData {
  return {
    id: "subagent/research-1",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: "2026-08-04T10:00:00.000Z",
    lastActiveAt: "2026-08-04T10:00:02.000Z",
    messages: [
      { role: "user", content: "Find the old deployment decision", timestamp: "2026-08-04T10:00:00.000Z" },
      { role: "assistant", content: "The deployment decision was to use a local archive", timestamp: "2026-08-04T10:00:02.000Z" },
    ],
    meta: {
      displayName: "research",
      type: "research",
      parentSessionId: "telegram/dm/user-1",
      visibility: "global",
      createdAt: "2026-08-04T10:00:00.000Z",
    },
    ...overrides,
  };
}

beforeEach(() => {
  sequence += 1;
  dbPath = join(tmpdir(), `my-claw-conversations-${process.pid}-${sequence}.db`);
  process.env["MY_CLAW_CONVERSATIONS_DB"] = dbPath;
  closeConversationArchive();
});

afterEach(() => {
  closeConversationArchive();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  delete process.env["MY_CLAW_CONVERSATIONS_DB"];
});

test("searches one global corpus across sources and sub-agents", () => {
  const chat = message({ text: "We decided to keep the archive global", timestamp: "2026-08-04T10:00:00.000Z" });
  const scheduled = message({
    id: "cron-1",
    platform: "cron",
    chatId: "job-42",
    text: "The global archive must search every source",
    timestamp: "2026-08-04T10:01:00.000Z",
  });
  archiveChannelMessage(chat);
  archiveChannelMessage(scheduled);
  indexSessionArchive(session({}));

  const hits = searchConversationArchive({ query: "archive", limit: 20 });
  expect(hits.length).toBe(3);
  expect(hits.map((hit) => hit.platform).sort()).toEqual(["cron", "my-claw-app", "subagent"]);
});

test("deduplicates repeated channel ingestion by source id", () => {
  const inbound = message({ text: "same source", timestamp: "2026-08-04T10:00:00.000Z" });
  archiveChannelMessage(inbound);
  archiveChannelMessage(inbound);
  expect(searchConversationArchive({ query: "same source", limit: 20 })).toHaveLength(1);
});

test("a second pass on the same message keeps the enriched text", () => {
  // The channel archives what it received, the router archives what the run read: the second
  // pass is the one carrying a voice note's transcript, and it used to be dropped outright.
  const inbound = message({ text: "look at this", timestamp: "2026-08-04T10:00:00.000Z" });
  archiveChannelMessage(inbound);
  archiveChannelMessage({ ...inbound, text: 'look at this\n[Audio]: "the invoice is overdue"' });

  const hits = searchConversationArchive({ query: "invoice overdue", limit: 20 });
  expect(hits).toHaveLength(1);
  expect(readConversationHit(hits[0]!.id, 0, 0)?.context[0]?.content).toContain("the invoice is overdue");
  expect(searchConversationArchive({ query: "look at this", limit: 20 })).toHaveLength(1);
});

test("reads chronological context around a result", () => {
  const inbound = message({ text: "before decision", timestamp: "2026-08-04T10:00:00.000Z" });
  archiveChannelMessage(inbound);
  archiveAssistantMessage(inbound, "telegram/dm/user-1", "the decision was local search");
  const hits = searchConversationArchive({ query: "decision local", limit: 5 });
  expect(hits[0]).toBeDefined();
  const context = readConversationHit(hits[0]!.id, 1, 1);
  expect(context?.context.map((item) => item.content)).toEqual([
    "before decision",
    "the decision was local search",
  ]);
});

test("does not archive slash commands", () => {
  archiveChannelMessage(message({ text: "/claude set-token secret-token" }));
  expect(searchConversationArchive({ query: "secret-token", limit: 20 })).toEqual([]);
});

test("backfills existing sessions once", async () => {
  const sessionsDir = join(process.env["MY_CLAW_DIR"]!, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const marker = "onlyneedle";
  writeFileSync(join(sessionsDir, "telegram-dm.json"), JSON.stringify(session({
    id: "telegram/dm/user-2",
    meta: undefined,
    messages: [
      { role: "user", content: marker, timestamp: "2026-08-04T10:00:00.000Z" },
      { role: "assistant", content: `backfill-result-${sequence}`, timestamp: "2026-08-04T10:00:02.000Z" },
    ],
  })));

  expect(await backfillConversationArchive()).toBeGreaterThanOrEqual(2);
  expect(await backfillConversationArchive()).toBe(0);
  expect(searchConversationArchive({ query: marker, limit: 20 })).toHaveLength(1);
});

test("a sub-agent conversation is searchable from its log, not from the retired array", () => {
  // `indexSessionArchive` walks `session.messages`, which nothing has filled since the storage
  // switch: every call meant to index a sub-agent was indexing an empty list.
  const entries = [
    { id: "e1", seq: 1, ts: Date.parse("2026-08-04T10:00:00.000Z"), type: "user", prompt: true, text: "trouve la fuite de contexte" },
    { id: "e2", seq: 2, ts: Date.parse("2026-08-04T10:00:05.000Z"), type: "phase", prompt: true, text: "la fuite vient du prompt systeme", runId: "r1" },
    { id: "e3", seq: 3, ts: Date.parse("2026-08-04T10:00:06.000Z"), type: "tool", prompt: true, name: "read", arguments: "{}", output: "bruit" },
  ] as never;

  const indexed = indexSessionEntries(session({}), entries);

  expect(indexed).toBe(2);
  const hits = searchConversationArchive({ query: "fuite", limit: 20 });
  expect(hits).toHaveLength(2);
  expect(hits.map((hit) => hit.role).sort()).toEqual(["assistant", "user"]);
  // A tool output is not a turn: indexing it would drown the corpus in the noise it exists to hide.
  expect(searchConversationArchive({ query: "bruit", limit: 20 })).toHaveLength(0);
});

test("indexing the same log twice adds nothing", () => {
  const entries = [
    { id: "e1", seq: 1, ts: Date.parse("2026-08-04T11:00:00.000Z"), type: "user", prompt: true, text: "question unique" },
  ] as never;
  expect(indexSessionEntries(session({}), entries)).toBe(1);
  expect(indexSessionEntries(session({}), entries)).toBe(0);
  expect(searchConversationArchive({ query: "unique", limit: 20 })).toHaveLength(1);
});
