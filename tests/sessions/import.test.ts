import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { entriesOf, importSession } from "../../src/sessions/import.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import { SessionLog, sessionDir } from "../../src/sessions/log.ts";
import type { Entry } from "../../src/sessions/log.ts";
import type { SessionData, SessionMessage } from "../../src/sessions/store.ts";

// The log appends fire-and-forget, and the harness clears sessions/ between tests: without its
// directory every write logs a failure it deliberately swallows.
beforeEach(() => mkdirSync(sessionDir("import-test"), { recursive: true }));

const at = (n: number) => new Date(1_800_000_000_000 + n * 1000).toISOString();

function session(messages: SessionMessage[], extra: Partial<SessionData> = {}): SessionData {
  return {
    id: "s1", platform: "my-claw-app", chatType: "thread",
    createdAt: at(0), lastActiveAt: at(99), messages, ...extra,
  } as SessionData;
}

/** Appends the import into a real log, which is what gives the entries their ids and chain. */
async function intoLog(data: SessionData): Promise<{ log: SessionLog; entries: readonly Entry[] }> {
  const { entries: imported, boundaryIndex } = importSession(data);
  const log = new SessionLog("import-test", [], null);
  const written: Entry[] = [];
  for (const payload of imported) {
    const { ts: _ts, ...rest } = payload;
    written.push(log.append(rest as Parameters<typeof log.append>[0]));
  }
  // The boundary names an entry, and the entry only has an id once it is written: patch after.
  if (boundaryIndex >= 0) {
    const boundary = [...written].reverse().find((entry) => entry.type === "compaction");
    if (boundary) (boundary as { firstKeptEntryId: string }).firstKeptEntryId = written[boundaryIndex]!.id;
  }
  // Flushed here, not left in flight: the harness clears sessions/ between tests, and a write
  // landing after that is the swallowed ENOENT the log logs and moves on from.
  await log.flush();
  return { log, entries: written };
}

const userMsg = (content: string, n: number, extra: Record<string, unknown> = {}): SessionMessage =>
  ({ role: "user", content, timestamp: at(n), ...extra }) as SessionMessage;
const assistantMsg = (content: string, n: number, extra: Record<string, unknown> = {}): SessionMessage =>
  ({ role: "assistant", content, timestamp: at(n), ...extra }) as SessionMessage;
const toolMsg = (toolCallId: string, content: string, n: number): SessionMessage =>
  ({ role: "tool", toolCallId, content, timestamp: at(n) });

describe("entriesOf: the shape of what was stored", () => {
  test("an exchange becomes a user entry and a phase", () => {
    const entries = entriesOf(session([userMsg("bonjour", 1), assistantMsg("salut", 2)]));
    expect(entries.map((e) => e.type)).toEqual(["user", "phase"]);
    expect(entries[0]).toMatchObject({ text: "bonjour", prompt: true });
    expect(entries[1]).toMatchObject({ text: "salut", prompt: true });
  });

  test("an empty session imports to nothing rather than failing", () => {
    expect(entriesOf(session([]))).toEqual([]);
  });

  test("a turn cut into phases keeps its cuts", () => {
    // The cuts exist so a reopened thread shows each thought beside the text it produced. Gluing
    // them back is what stacked every thought above prose they were not about.
    const entries = entriesOf(session([
      assistantMsg("un\n\ndeux", 1, { segments: [{ reasoning: "a", content: "un" }, { reasoning: "b", content: "deux" }] }),
    ]));
    expect(entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["un", "deux"]);
    expect(entries.map((e) => ("reasoning" in e ? e.reasoning : undefined))).toEqual(["a", "b"]);
  });

  test("a turn's phases share one run, two turns do not", () => {
    const entries = entriesOf(session([
      assistantMsg("x", 1, { segments: [{ content: "un" }, { content: "deux" }] }),
      assistantMsg("y", 2),
    ]));
    const runs = entries.map((e) => ("runId" in e ? e.runId : ""));
    expect(runs[0]).toBe(runs[1]!);
    expect(runs[2]).not.toBe(runs[0]!);
  });

  test("the turn's token count is not repeated on every phase", () => {
    // One number for the whole turn: repeated per phase, the status line would multiply it.
    const entries = entriesOf(session([
      assistantMsg("x", 1, { reasoningTokens: 300, segments: [{ content: "un" }, { content: "deux" }] }),
    ]));
    expect(entries.map((e) => ("reasoningTokens" in e ? e.reasoningTokens : undefined))).toEqual([undefined, 300]);
  });

  test("a tool call takes its result from the message that carried it", () => {
    const entries = entriesOf(session([
      assistantMsg("je regarde", 1, { toolCalls: [{ id: "c1", name: "bash", arguments: '{"command":"ls"}', durationMs: 12 }] }),
      toolMsg("c1", "fichier.txt", 2),
    ]));
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ type: "tool", callId: "c1", name: "bash", args: { command: "ls" }, output: "fichier.txt", ok: true, durationMs: 12 });
  });

  test("unparseable arguments are kept raw rather than lost", () => {
    const entries = entriesOf(session([assistantMsg("", 1, { toolCalls: [{ id: "c1", name: "bash", arguments: "{oops" }] })]));
    expect(entries[1]).toMatchObject({ args: { raw: "{oops" } });
  });

  test("a call the run never answered still becomes a card, marked as failed", () => {
    // Two sub-agent files on this install were in exactly this state.
    const entries = entriesOf(session([assistantMsg("je lance", 1, { toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] })]));
    expect(entries[1]).toMatchObject({ type: "tool", output: "", ok: false });
    // The empty phase it came with is kept: it is what groups the call into its turn.
    expect(entries[0]!.type).toBe("phase");
  });

  test("a dead sub-agent card keeps its lifecycle and its verdict", () => {
    const spawn = { subagentId: "sa1", displayName: "r", agentType: "research", mode: "run", action: "spawn", status: "error", error: "boom", startedAt: at(1) };
    const entries = entriesOf(session([
      assistantMsg("", 1, { toolCalls: [{ id: "c1", name: "spawn", arguments: "{}", spawn }] }),
      toolMsg("c1", "", 2),
    ]));
    expect(entries[1]).toMatchObject({ ok: false, spawn });
  });

  test("attachments and location ride along", () => {
    const attachments = [{ type: "image", path: "/tmp/a.png" }];
    const location = { latitude: 1, longitude: 2 };
    const entries = entriesOf(session([userMsg("regarde", 1, { attachments, location })]));
    expect(entries[0]).toMatchObject({ attachments, location });
  });
});

describe("entriesOf: the journals folded back in", () => {
  test("a command lands where it happened, not in a block at one end", async () => {
    const data = session([userMsg("avant", 1), userMsg("apres", 5)], {
      commands: [{ input: "/status", output: "ok", timestamp: at(3) }],
    });
    expect(entriesOf(data).map((e) => e.type)).toEqual(["user", "command", "user"]);
  });

  test("a command typed after the last turn still surfaces", () => {
    // The usual case: a /compact at the end of a turn. It used to land nowhere on an older page.
    const data = session([userMsg("q", 1)], { commands: [{ input: "/compact", output: "fait", timestamp: at(9) }] });
    expect(entriesOf(data).map((e) => e.type)).toEqual(["user", "command"]);
  });

  test("a command older than every surviving message lands at the front", () => {
    // Compaction outlived the turns it was typed on; it must be reachable, not silently dropped.
    const data = session([userMsg("q", 8)], { commands: [{ input: "/model", output: "ok", timestamp: at(1) }] });
    expect(entriesOf(data).map((e) => e.type)).toEqual(["command", "user"]);
  });

  test("commands and failures share one timeline", async () => {
    const data = session([userMsg("q", 1)], {
      commands: [{ input: "/status", output: "ok", timestamp: at(4) }],
      failures: [{ error: "boom", timestamp: at(2) }],
    });
    expect(entriesOf(data).map((e) => e.type)).toEqual(["user", "failure", "command"]);
  });

  test("an aside is shown and never sent, a turn is both", async () => {
    const data = session([userMsg("q", 1)], {
      commands: [{ input: "/status", output: "ok", timestamp: at(2) }],
      failures: [{ error: "boom", timestamp: at(3) }],
    });
    expect(entriesOf(data).map((e) => e.prompt)).toEqual([true, false, false]);
  });

  test("a broken timestamp keeps the order the array already had", () => {
    // The array order is the truth; the clock is a hint that a hand-edit can break.
    const messages = [userMsg("un", 1), userMsg("deux", 2), userMsg("trois", 3)];
    (messages[1] as { timestamp: string }).timestamp = "pas une date";
    expect(entriesOf(session(messages)).map((e) => ("text" in e ? e.text : ""))).toEqual(["un", "deux", "trois"]);
  });
});

describe("entriesOf: the compaction boundary", () => {
  const compacted = () => {
    const summary = userMsg("[Prior context summarized]\nresume\n\n[End of summary — respond to the message below]", 3, { summaryOf: 2 });
    return session([userMsg("vieux 1", 1), assistantMsg("vieux 2", 2), summary, userMsg("garde", 4)], { promptBase: 2 });
  };

  test("the summary turn becomes a boundary, not a user turn", () => {
    const entries = entriesOf(compacted());
    expect(entries.map((e) => e.type)).toEqual(["user", "phase", "compaction", "user"]);
    // The summary alone: the instructions wrapped around it were addressed to the model.
    expect(entries[2]).toMatchObject({ summary: "resume", count: 2 });
  });

  test("what the summary replaced is still there", () => {
    // The difference between a boundary and a deletion, and the reason the owner keeps his words.
    expect(entriesOf(compacted())).toHaveLength(4);
  });

  test("the boundary points at the first entry the old index kept", () => {
    // Resolved by position, never by timestamp: compaction stamps its summary with the clock of
    // the moment it ran, so on a real session here the summary is stamped later than the turn
    // right after it, and a ts-based match walks past the turns it was supposed to keep.
    expect(importSession(compacted()).boundaryIndex).toBe(3);
  });

  test("the floor is found even when the summary is stamped after the turns it keeps", async () => {
    // Measured on a real session: compaction inserts its summary into the middle of the array with
    // the clock of the moment it ran, so the summary is stamped 18:15:35 while the turn right
    // after it is stamped 18:14:17. A ts-based match walked straight past the kept turns.
    const summary = userMsg("[Prior context summarized]\nresume\n\n[End of summary — respond to the message below]", 90, { summaryOf: 2 });
    const data = session([userMsg("vieux", 1), assistantMsg("vieux 2", 2), summary, assistantMsg("garde", 3)], { promptBase: 2 });
    const { entries, boundaryIndex } = importSession(data);
    expect(boundaryIndex).toBe(3);
    expect(entries[boundaryIndex]).toMatchObject({ type: "phase", text: "garde" });
  });

  test("a session with no boundary has no index to resolve", async () => {
    expect(importSession(session([userMsg("q", 1)])).boundaryIndex).toBe(-1);
  });

  test("an index past the end reads as no boundary", () => {
    // A session rewritten under a stale index: treated as no boundary.
    expect(importSession(session([userMsg("q", 1)], { promptBase: 99 })).boundaryIndex).toBe(-1);
  });
});

describe("the import produces a usable log", () => {
  test("the entries form one chain ending at the leaf", async () => {
    const data = session([userMsg("q", 1), assistantMsg("a", 2), userMsg("q2", 3)]);
    const { log, entries } = await intoLog(data);
    expect(entries[0]!.parentId).toBeNull();
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.parentId).toBe(entries[i - 1]!.id);
    expect(log.leaf()).toBe(entries[entries.length - 1]!.id);
    expect(log.path().map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  test("every entry has its own id", async () => {
    const data = session([userMsg("q", 1), assistantMsg("a", 2), userMsg("q2", 3), assistantMsg("a2", 4)]);
    const { entries } = await intoLog(data);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});
