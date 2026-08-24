import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { importSession } from "../../src/sessions/import.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import { promptMessages } from "../../src/sessions/store.ts";
import { SessionLog, sessionDir } from "../../src/sessions/log.ts";
import type { Entry } from "../../src/sessions/log.ts";
import type { SessionData, SessionMessage } from "../../src/sessions/store.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

/**
 * What a provider is handed, frozen.
 *
 * The expectations below are written out in full rather than compared against `promptMessages`,
 * and that is the whole point of the file. The switch removes `promptMessages`, so the witness
 * that proved the two paths agreed disappears with it -- these literals are that witness, kept.
 *
 * The shapes covered are the ones a census of the real store actually found: 6673 tool messages,
 * 5793 assistant turns, 5361 with tool calls, 2815 with reasoning, 8 compaction boundaries, 8
 * turns with attachments, 4 completed spawns, 3 commands, 2 failures, 1 location. Notably absent
 * from live data, and therefore tested here as shapes the code claims to handle rather than as
 * shapes it meets: `segments` and `reasoningTokens`.
 */

const SESSION_ID = "conformance";
beforeEach(() => mkdirSync(sessionDir(SESSION_ID), { recursive: true }));

const at = (n: number) => new Date(1_800_000_000_000 + n * 1000).toISOString();

function session(messages: SessionMessage[], extra: Partial<SessionData> = {}): SessionData {
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "thread", createdAt: at(0), lastActiveAt: at(99), messages, ...extra } as SessionData;
}

/** The new path, end to end: stored session, imported, appended to a real log, projected. */
async function projected(data: SessionData): Promise<ChatMessage[]> {
  const { entries: imported, boundaryIndex } = importSession(data);
  const log = new SessionLog(SESSION_ID, [], null);
  log.appendAll(imported, (entries: Entry[]) => {
    if (boundaryIndex < 0 || !entries[boundaryIndex]) return;
    const boundary = [...entries].reverse().find((entry) => entry.type === "compaction");
    if (boundary) (boundary as { firstKeptEntryId: string }).firstKeptEntryId = entries[boundaryIndex]!.id;
  });
  await log.flush();
  return promptOf(log.entries(), log.leaf());
}

const userMsg = (content: string, n: number, extra: Record<string, unknown> = {}): SessionMessage =>
  ({ role: "user", content, timestamp: at(n), ...extra }) as SessionMessage;
const assistantMsg = (content: string, n: number, extra: Record<string, unknown> = {}): SessionMessage =>
  ({ role: "assistant", content, timestamp: at(n), ...extra }) as SessionMessage;
const toolMsg = (toolCallId: string, content: string, n: number): SessionMessage =>
  ({ role: "tool", toolCallId, content, timestamp: at(n) });

const call = (id: string, name: string, args: string) => ({ id, name, arguments: args });
const asCall = (id: string, name: string, args: string) => ({ id, type: "function" as const, function: { name, arguments: args } });

describe("frozen: the prompt of a stored conversation", () => {
  test("a plain exchange", async () => {
    expect(await projected(session([userMsg("bonjour", 1), assistantMsg("salut", 2)]))).toEqual([
      { role: "user", content: "bonjour" },
      { role: "assistant", content: "salut" },
    ]);
  });

  test("the dominant shape: a turn that calls tools, then answers", async () => {
    // 5361 of the 5793 assistant turns in the real store carry tool calls.
    const data = session([
      userMsg("liste le dossier", 1),
      assistantMsg("je regarde", 2, { reasoning: "il faut lister", toolCalls: [call("c1", "bash", '{"command":"ls"}')] }),
      toolMsg("c1", "fichier.txt", 3),
      assistantMsg("il y a fichier.txt", 4),
    ]);
    expect(await projected(data)).toEqual([
      { role: "user", content: "liste le dossier" },
      { role: "assistant", content: "je regarde", tool_calls: [asCall("c1", "bash", '{"command":"ls"}')] },
      { role: "tool", tool_call_id: "c1", content: "fichier.txt" },
      { role: "assistant", content: "il y a fichier.txt" },
    ]);
  });

  test("several calls in one turn, answered in the order they were asked", async () => {
    // An OpenAI-compatible endpoint matches by id but rejects a result whose call it never saw.
    const data = session([
      assistantMsg("", 1, { toolCalls: [call("c1", "read", "{}"), call("c2", "ls", "{}")] }),
      toolMsg("c1", "contenu", 2),
      toolMsg("c2", "listing", 3),
    ]);
    expect(await projected(data)).toEqual([
      { role: "assistant", content: "", tool_calls: [asCall("c1", "read", "{}"), asCall("c2", "ls", "{}")] },
      { role: "tool", tool_call_id: "c1", content: "contenu" },
      { role: "tool", tool_call_id: "c2", content: "listing" },
    ]);
  });

  test("thinking is stored and never sent", async () => {
    // 2815 turns in the real store carry it. Both replay paths build their messages field by
    // field precisely so this one cannot leak -- docs/reasoning-visibility.md.
    const out = await projected(session([assistantMsg("la reponse", 1, { reasoning: "SECRET", reasoningTokens: 40 })]));
    expect(out).toEqual([{ role: "assistant", content: "la reponse" }]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  test("a turn cut into phases comes back as one turn", async () => {
    // Absent from live data: the cuts are a display concern, and a provider has no slot for them.
    const data = session([
      assistantMsg("un\n\ndeux", 1, { segments: [{ reasoning: "a", content: "un" }, { reasoning: "b", content: "deux" }] }),
    ]);
    expect(await projected(data)).toEqual([{ role: "assistant", content: "un\n\ndeux" }]);
  });

  test("a completed spawn is a tool call like any other", async () => {
    const spawn = { subagentId: "sa1", displayName: "chercheur", agentType: "research", mode: "run", action: "spawn", status: "complete", startedAt: at(1), finishedAt: at(2) };
    const data = session([
      assistantMsg("je delegue", 1, { toolCalls: [{ ...call("c1", "spawn", '{"name":"chercheur"}'), spawn }] }),
      toolMsg("c1", "voici le rapport", 2),
    ]);
    expect(await projected(data)).toEqual([
      { role: "assistant", content: "je delegue", tool_calls: [asCall("c1", "spawn", '{"name":"chercheur"}')] },
      { role: "tool", tool_call_id: "c1", content: "voici le rapport" },
    ]);
  });

  test("a compacted conversation starts at the summary", async () => {
    const summary = userMsg("[Prior context summarized]\nce qui precede\n\n[End of summary — respond to the message below]", 3, { summaryOf: 2 });
    const data = session([userMsg("vieux", 1), assistantMsg("vieille reponse", 2), summary, userMsg("la suite", 4)], { promptBase: 2 });
    expect(await projected(data)).toEqual([
      { role: "user", content: "[Prior context summarized]\nce qui precede\n\n[End of summary — respond to the message below]" },
      { role: "user", content: "la suite" },
    ]);
  });

  test("what was only ever on screen is not in the prompt", async () => {
    const data = session([userMsg("q", 1), assistantMsg("a", 5)], {
      commands: [{ input: "/status", output: "tout va bien", timestamp: at(2) }],
      failures: [{ error: "API Error 529", timestamp: at(3) }],
    });
    expect(await projected(data)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  test("a run killed mid-tool asks for the call it made and answers it", async () => {
    // The call is in no `tool` message because the run never came back. The card was on screen,
    // so the entry exists; the prompt stays legal because the entry carries an empty result
    // rather than leaving the request unanswered.
    const data = session([assistantMsg("je lance le build", 1, { toolCalls: [call("c1", "bash", '{"command":"make"}')] })]);
    expect(await projected(data)).toEqual([
      { role: "assistant", content: "je lance le build", tool_calls: [asCall("c1", "bash", '{"command":"make"}')] },
      { role: "tool", tool_call_id: "c1", content: "" },
    ]);
  });

  test("an attached image leaves the text alone", async () => {
    const data = session([userMsg("regarde ca", 1, { attachments: [{ type: "image", path: "/tmp/a.png" }], location: { latitude: 48.85, longitude: 2.35 } })]);
    expect(await projected(data)).toEqual([{ role: "user", content: "regarde ca" }]);
  });

  test("an empty conversation is an empty prompt", async () => {
    expect(await projected(session([]))).toEqual([]);
  });
});

describe("frozen: the invariant a provider enforces", () => {
  test("every call asked for is answered, in order, on a long mixed conversation", async () => {
    const messages: SessionMessage[] = [userMsg("vas-y", 0)];
    for (let i = 0; i < 30; i++) {
      messages.push(assistantMsg(`etape ${i}`, i * 3 + 1, { reasoning: `pense ${i}`, toolCalls: [call(`c${i}`, "bash", "{}")] }));
      messages.push(toolMsg(`c${i}`, `sortie ${i}`, i * 3 + 2));
    }
    const out = await projected(session(messages));
    const asked = out.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
    const answered = out.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(answered).toEqual(asked);
    expect(asked).toHaveLength(30);
  });
});

describe("while it still exists: the old path agrees", () => {
  /** `promptMessages` in the shape the new path produces. Deleted with the switch. */
  const legacy = (data: SessionData): ChatMessage[] =>
    promptMessages(data).map((message) => {
      if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      if (message.role === "user") return { role: "user", content: message.content };
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? { tool_calls: message.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      } as ChatMessage;
    });

  const cases: Array<[string, SessionData]> = [
    ["plain", session([userMsg("q", 1), assistantMsg("a", 2)])],
    ["tools", session([
      assistantMsg("je regarde", 1, { toolCalls: [call("c1", "bash", "{}")] }),
      toolMsg("c1", "ok", 2),
      assistantMsg("voila", 3),
    ])],
    ["asides", session([userMsg("q", 1), assistantMsg("a", 4)], {
      commands: [{ input: "/status", output: "ok", timestamp: at(2) }],
      failures: [{ error: "boom", timestamp: at(3) }],
    })],
  ];

  for (const [name, data] of cases) {
    test(`${name}: both paths send the same messages`, async () => {
      expect(await projected(data)).toEqual(legacy(data));
    });
  }
});
