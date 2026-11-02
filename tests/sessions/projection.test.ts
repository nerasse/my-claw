import { describe, test, expect } from "bun:test";
import { promptOf, contextEntries, keepCurrentTurnReasoning, SUMMARY_OPEN } from "../../src/sessions/projection.ts";
import type { Entry, Provisioned, UserEntry, PhaseEntry, ToolEntry, CompactionEntry } from "../../src/sessions/log.ts";
import type { ChatMessage, ProviderMeta } from "../../src/llm/provider.ts";

/**
 * Entries built by hand rather than through a log: the projection is pure, so it must be testable
 * without a file, and a hand-built tree is the only way to reach shapes the log cannot produce.
 */
let seq = 0;
function entry<T extends Entry>(parentId: string | null, body: Provisioned<Entry>): T {
  const n = seq++;
  return { ...body, id: `e${n}`, seq: n, parentId, ts: 1_800_000_000_000 + n } as unknown as T;
}

/** A linear branch: each entry parented on the one before. Returns the entries and the leaf. */
function chain(bodies: Array<Provisioned<Entry>>): { entries: Entry[]; leaf: string } {
  const entries: Entry[] = [];
  let parent: string | null = null;
  for (const body of bodies) {
    const made: Entry = entry<Entry>(parent, body);
    entries.push(made);
    parent = made.id;
  }
  return { entries, leaf: entries[entries.length - 1]!.id };
}

const user = (text: string) => ({ type: "user", prompt: true, text } as Provisioned<UserEntry>);
const phase = (text: string, runId = "r1", extra: Record<string, unknown> = {}) =>
  ({ type: "phase", prompt: true, text, runId, ...extra } as Provisioned<PhaseEntry>);
const tool = (callId: string, runId = "r1", extra: Record<string, unknown> = {}) =>
  ({
    type: "tool", prompt: true, callId, name: "bash", args: { command: "ls" },
    output: `out-${callId}`, truncated: false, ok: true, runId, ...extra,
  } as Provisioned<ToolEntry>);

describe("promptOf: what the model is handed", () => {
  test("a plain exchange projects turn for turn", () => {
    const { entries, leaf } = chain([user("bonjour"), phase("salut")]);
    expect(promptOf(entries, leaf)).toEqual([
      { role: "user", content: "bonjour" },
      { role: "assistant", content: "salut" },
    ]);
  });

  test("a user turn projects the prompt text, not the bubble text", () => {
    const { entries, leaf } = chain([
      { type: "user", prompt: true, text: "bonjour", promptText: "<context>\nCurrent time: now\n</context>\n\nbonjour" } as Provisioned<UserEntry>,
      phase("salut"),
    ]);
    expect(promptOf(entries, leaf)[0]).toEqual({
      role: "user",
      content: "<context>\nCurrent time: now\n</context>\n\nbonjour",
    });
  });

  test("an empty branch is an empty prompt, not a crash", () => {
    expect(promptOf([], null)).toEqual([]);
    expect(promptOf([], "gone")).toEqual([]);
  });

  test("what is shown and never sent stays out", () => {
    // The line the single tableau never drew: a slash command, a dead run and a hand-back note are
    // things the owner must see again and the model must never read.
    const { entries, leaf } = chain([
      user("bonjour"),
      { type: "command", prompt: false, input: "/status", output: "tout va bien" },
      { type: "failure", prompt: false, error: "boom" },
      { type: "note", prompt: false, text: "pour info" },
      { type: "model_change", prompt: false, model: "opus-5" },
      phase("salut"),
    ]);
    expect(promptOf(entries, leaf)).toEqual([
      { role: "user", content: "bonjour" },
      { role: "assistant", content: "salut" },
    ]);
  });
});

describe("promptOf: one model turn, many phases", () => {
  test("the phases of a turn fold back into one assistant message", () => {
    // The streamer cuts a turn at every thinking block so the reader sees the thought beside the
    // text it produced. A provider has no slot for that: it gets the turn it actually produced.
    const { entries, leaf } = chain([
      user("q"),
      phase("je commence", "r1", { reasoning: "hmm" }),
      phase("je continue", "r1", { reasoning: "encore" }),
    ]);
    expect(promptOf(entries, leaf)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "je commence\n\nje continue" },
    ]);
  });

  test("thinking never reaches the model", () => {
    const { entries, leaf } = chain([user("q"), phase("visible", "r1", { reasoning: "SECRET", reasoningTokens: 40 })]);
    expect(JSON.stringify(promptOf(entries, leaf))).not.toContain("SECRET");
  });

  test("two turns stay two messages", () => {
    const { entries, leaf } = chain([user("q"), phase("un", "r1"), phase("deux", "r2")]);
    const out = promptOf(entries, leaf);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: "assistant", content: "un" });
    expect(out[2]).toEqual({ role: "assistant", content: "deux" });
  });

  test("a phase with no text does not leave a blank line in the turn", () => {
    // A phase that only thought, then called a tool, wrote no prose.
    const { entries, leaf } = chain([user("q"), phase("", "r1", { reasoning: "je reflechis" }), phase("voila", "r1")]);
    expect(promptOf(entries, leaf)[1]).toEqual({ role: "assistant", content: "voila" });
  });

  test("only the last phase's provider state is replayed", () => {
    // Opaque state describes where the provider left the turn; an earlier phase describes a
    // position it has already moved past -- docs/reasoning-replay.md.
    const { entries, leaf } = chain([
      user("q"),
      phase("un", "r1", { providerMeta: { chat: { field: "reasoning_content", content: "vieux" } } }),
      phase("deux", "r1", { providerMeta: { chat: { field: "reasoning_content", content: "recent" } } }),
    ]);
    const assistant = promptOf(entries, leaf)[1] as { providerMeta?: { chat?: { content?: string } } };
    expect(assistant.providerMeta?.chat?.content).toBe("recent");
  });
});

describe("promptOf: tools", () => {
  test("a turn's calls ride on its message and its results follow", () => {
    const { entries, leaf } = chain([user("q"), phase("je regarde", "r1"), tool("c1"), tool("c2"), phase("voila", "r2")]);
    const out = promptOf(entries, leaf);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    const assistant = out[1] as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    expect(assistant.tool_calls?.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(assistant.tool_calls?.[0]!.function.arguments).toBe('{"command":"ls"}');
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "out-c1" });
  });

  test("every call the assistant asked for is answered, and nothing else is", () => {
    // The invariant a provider enforces: an assistant tool_call with no tool message after it makes
    // the whole request illegal, which used to kill a conversation for good. Here the calls are
    // derived from the entries that carry the results, so the two cannot drift apart.
    const { entries, leaf } = chain([user("q"), phase("", "r1"), tool("c1"), tool("c2"), phase("fini", "r2")]);
    const out = promptOf(entries, leaf);
    const asked = out.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
    const answered = out.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(answered).toEqual(asked);
  });

  test("a run killed mid-tool projects an assistant turn that asked for nothing", () => {
    // The phases were written, the tool never settled so no entry exists. That is the structural
    // reason a dangling call cannot happen here rather than being repaired after the fact.
    const { entries, leaf } = chain([user("q"), phase("je lance le build", "r1")]);
    const out = promptOf(entries, leaf);
    expect(out[1]).toEqual({ role: "assistant", content: "je lance le build" });
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  test("tools of another turn do not attach to this one", () => {
    const { entries, leaf } = chain([user("q"), phase("un", "r1"), tool("c1", "r1"), phase("deux", "r2"), tool("c2", "r2")]);
    const out = promptOf(entries, leaf);
    const first = out[1] as { tool_calls?: Array<{ id: string }> };
    const second = out[3] as { tool_calls?: Array<{ id: string }> };
    expect(first.tool_calls?.map((c) => c.id)).toEqual(["c1"]);
    expect(second.tool_calls?.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("promptOf: the compaction boundary", () => {
  const compaction = (firstKeptEntryId: string, summary = "resume") =>
    ({ type: "compaction", prompt: true, summary, firstKeptEntryId, tokensBefore: 900, count: 2 } as Provisioned<CompactionEntry>);

  test("the summary replaces what it covers and keeps the tail", () => {
    const built = chain([user("vieux 1"), phase("vieux 2"), user("garde 1"), phase("garde 2"), user("apres")]);
    const kept = built.entries[2]!.id;
    // The boundary is appended after the tail, which is where a mid-run compaction writes it.
    const boundary = entry<CompactionEntry>(built.leaf, compaction(kept));
    const entries = [...built.entries, boundary];

    const out = promptOf(entries, boundary.id);
    expect(out[0]!.content).toContain(SUMMARY_OPEN);
    expect(out[0]!.content).toContain("resume");
    expect(out.slice(1).map((m) => m.content)).toEqual(["garde 1", "garde 2", "apres"]);
    // What it replaced is still on disk, which is the difference with deleting it.
    expect(entries).toHaveLength(6);
  });

  test("the summary arrives as a user turn, not as the model's own words", () => {
    const built = chain([user("vieux"), user("garde")]);
    const boundary = entry<CompactionEntry>(built.leaf, compaction(built.entries[1]!.id));
    expect(promptOf([...built.entries, boundary], boundary.id)[0]!.role).toBe("user");
  });

  test("the newest boundary wins over an older one", () => {
    // Compactions accumulate; only the last describes the current floor.
    const built = chain([user("tres vieux"), user("vieux"), user("recent")]);
    const first = entry<CompactionEntry>(built.leaf, compaction(built.entries[1]!.id, "vieux resume"));
    const second = entry<CompactionEntry>(first.id, compaction(built.entries[2]!.id, "nouveau resume"));
    const out = promptOf([...built.entries, first, second], second.id);
    expect(out[0]!.content).toContain("nouveau resume");
    expect(out[0]!.content).not.toContain("vieux resume");
    expect(out.slice(1).map((m) => m.content)).toEqual(["recent"]);
  });

  test("a boundary naming an entry the branch does not hold sends the branch whole", () => {
    // Costing tokens is recoverable; dropping turns is not.
    const built = chain([user("un"), user("deux")]);
    const boundary = entry<CompactionEntry>(built.leaf, compaction("never-written"));
    const out = promptOf([...built.entries, boundary], boundary.id);
    expect(out.map((m) => m.content)).toEqual(["un", "deux", expect.stringContaining("resume")]);
  });

  test("contextEntries and promptOf agree on what survives", () => {
    const built = chain([user("vieux"), user("garde")]);
    const boundary = entry<CompactionEntry>(built.leaf, compaction(built.entries[1]!.id));
    const entries = [...built.entries, boundary];
    expect(contextEntries(entries, boundary.id).map((e) => e.id)).toEqual([boundary.id, built.entries[1]!.id]);
  });
});

describe("promptOf: branches", () => {
  test("a retried turn is invisible from the branch that replaced it", () => {
    const built = chain([user("question"), phase("mauvaise reponse", "r1")]);
    // The retry: branch back before the answer, answer again.
    const retry = entry<PhaseEntry>(built.entries[0]!.id, phase("bonne reponse", "r2"));
    const entries = [...built.entries, retry];

    expect(promptOf(entries, retry.id).map((m) => m.content)).toEqual(["question", "bonne reponse"]);
    // And the abandoned turn is reachable, which is what makes the retry reversible.
    expect(promptOf(entries, built.leaf).map((m) => m.content)).toEqual(["question", "mauvaise reponse"]);
  });

  test("a compaction on one branch does not move the floor of another", () => {
    const built = chain([user("un"), user("deux")]);
    const boundary = entry<CompactionEntry>(built.leaf, {
      type: "compaction", prompt: true, summary: "resume", firstKeptEntryId: built.entries[1]!.id, tokensBefore: 1, count: 1,
    });
    const other = entry<PhaseEntry>(built.entries[0]!.id, phase("autre branche", "r9"));
    const entries = [...built.entries, boundary, other];
    expect(promptOf(entries, other.id).map((m) => m.content)).toEqual(["un", "autre branche"]);
  });
});

describe("promptOf: purity", () => {
  test("projecting twice gives the same thing and touches nothing", () => {
    const { entries, leaf } = chain([user("q"), phase("un", "r1"), tool("c1"), phase("deux", "r2")]);
    const snapshot = JSON.stringify(entries);
    const first = promptOf(entries, leaf);
    const second = promptOf(entries, leaf);
    expect(first).toEqual(second);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});

describe("a turn that says nothing and asks for nothing", () => {
  // Mid-run steering rebuilds the prompt while a call is still running. The phase of a model that
  // called a tool without a word of prose is empty, and its tool entry does not exist yet, so the
  // turn carries no text and no tool call. Anthropic refuses the whole request for that ("text
  // content blocks must be non-empty") and the retry reposts it, so one unsettled call used to
  // take the conversation down instead of one turn.
  test("is dropped: an unsettled call must not kill the conversation", () => {
    const { entries, leaf } = chain([user("vas-y"), phase("")]);
    expect(promptOf(entries, leaf)).toEqual([{ role: "user", content: "vas-y" }]);
  });

  test("the turns around it are untouched", () => {
    const { entries, leaf } = chain([
      user("vas-y"),
      phase("je regarde", "r1"),
      tool("c1", "r1"),
      phase("", "r2"),
      user("et maintenant ?"),
    ]);
    expect(promptOf(entries, leaf).map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  test("an empty phase whose call HAS settled is kept: the call is what it said", () => {
    const { entries, leaf } = chain([user("liste"), phase(""), tool("c1")]);
    const prompt = promptOf(entries, leaf);
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(prompt[1]).toMatchObject({ content: "", tool_calls: [{ id: "c1" }] });
  });
});

describe("a filed report reaches the model as context, and never parts a call from its result", () => {
  const filed = (output: string, prompt = true) =>
    ({ type: "command", prompt, input: "cron delivery", output, quiet: true } as Provisioned<Entry>);
  const asContext = (output: string) => ({
    role: "user" as const,
    content: `[Filed in this conversation, for context: cron delivery. Nothing to answer unless asked.]\n\n${output}`,
  });

  test("filed at rest: a context turn where it was filed; an owner's command still never is", () => {
    const { entries, leaf } = chain([user("hi"), phase("hello"), filed("[Cron: veille]\n\n3 offres"), filed("/status", false), user("et alors ?")]);
    expect(promptOf(entries, leaf)).toEqual<ChatMessage[]>([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      asContext("[Cron: veille]\n\n3 offres"),
      { role: "user", content: "et alors ?" },
    ]);
  });

  test("filed first, before the agent has said anything: a context turn all the same", () => {
    const { entries, leaf } = chain([filed("[Cron: veille]"), user("lu ?")]);
    expect(promptOf(entries, leaf)).toEqual([asContext("[Cron: veille]"), { role: "user", content: "lu ?" }]);
  });

  test("filed between a call and its result: given after the turn, the call keeps its result", () => {
    const { entries, leaf } = chain([user("go"), phase("je lance", "r1"), filed("rapport"), tool("c1", "r1"), phase("fini", "r2")]);
    expect(promptOf(entries, leaf)).toEqual<ChatMessage[]>([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "je lance",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }],
      },
      { role: "tool", tool_call_id: "c1", content: "out-c1" },
      asContext("rapport"),
      { role: "assistant", content: "fini" },
    ]);
  });

  test("filed inside a turn that turns out empty: the turn goes, the report stays", () => {
    const { entries, leaf } = chain([user("go"), phase("", "r1"), filed("rapport")]);
    expect(promptOf(entries, leaf)).toEqual([{ role: "user", content: "go" }, asContext("rapport")]);
  });
});

describe("keepCurrentTurnReasoning: the reasoning a request may carry", () => {
  const meta: ProviderMeta = { backend: "anthropic", model: "claude-opus-5-5", thinking: [{ type: "thinking", thinking: "why", signature: "SIG" }] };
  const assistant = (content: string, providerMeta = meta): ChatMessage => ({ role: "assistant", content, providerMeta });

  test("an earlier turn loses its reasoning, the current turn keeps its own", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      assistant("old answer"),
      { role: "user", content: "second" },
      assistant("current answer"),
    ];
    const kept = keepCurrentTurnReasoning(messages);
    expect(kept[1]).not.toHaveProperty("providerMeta");
    expect(kept[3]!.role === "assistant" && kept[3]!.providerMeta).toEqual(meta);
    expect(messages[1]).toHaveProperty("providerMeta");
  });

  test("tool results do not move the floor: the whole tool-use chain is kept", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      assistant("calling"),
      { role: "tool", tool_call_id: "c1", content: "out" },
      assistant("done"),
    ];
    expect(keepCurrentTurnReasoning(messages).filter((m) => m.role === "assistant" && m.providerMeta)).toHaveLength(2);
  });

  test("a prompt ending on the user turn carries no earlier reasoning", () => {
    const messages: ChatMessage[] = [assistant("old"), { role: "user", content: "new" }];
    expect(keepCurrentTurnReasoning(messages)[0]).not.toHaveProperty("providerMeta");
  });

  test("no user turn at all leaves the messages untouched", () => {
    const messages: ChatMessage[] = [assistant("one"), assistant("two")];
    expect(keepCurrentTurnReasoning(messages)).toEqual(messages);
  });
});

/**
 * A tool name the model mangled never reaches a request -- 2026-11-02.
 *
 * A small model emitted its own `<DSML| invoke>` markup with a shell redirect in the name field.
 * The call was recorded as an unknown tool, which was tidy, but the entry stayed in the log and
 * every later request of that conversation replayed it. Codex answers such a name with HTTP 400
 * (`Invalid 'input[380].name': string does not match pattern`), so the conversation could not be
 * continued at all -- Continue failed, and so did every new message.
 *
 * The log is history and is not edited. What stops mattering is the replay.
 */
describe("a tool name that is not an identifier", () => {
  const mangled = (callId: string) =>
    tool(callId, "r1", { name: "docker 2>/dev/null; true</|DSML| parameter>\n</|DSML| invoke>" });

  test("is left out of the assistant turn and out of the tool results", () => {
    const { entries, leaf } = chain([user("q"), phase("je regarde", "r1"), mangled("c1"), phase("voila", "r2")]);
    const messages = promptOf(entries, leaf);
    const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(assistant).toBeUndefined();
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    // The prose is untouched: only the call that cannot be replayed is dropped.
    expect(messages.some((m) => m.role === "assistant" && m.content === "je regarde")).toBe(true);
  });

  /** The calls the assistant turn of the prompt carries, as the provider would read them. */
  const callsOf = (entries: Entry[], leaf: string) => {
    const assistant = promptOf(entries, leaf).find(
      (m): m is ChatMessage & { tool_calls: Array<{ id: string; function: { name: string } }> } =>
        m.role === "assistant" && "tool_calls" in m && m.tool_calls !== undefined,
    );
    return assistant?.tool_calls ?? [];
  };

  test("does not take a valid sibling down with it", () => {
    const { entries, leaf } = chain([user("q"), phase("", "r1"), tool("c1"), mangled("c2")]);
    const messages = promptOf(entries, leaf);
    expect(callsOf(entries, leaf).map((c) => c.id)).toEqual(["c1"]);
    expect(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["c1"]);
  });

  test("every name this install offers passes the rule", () => {
    const { entries, leaf } = chain([user("q"), phase("", "r1"), tool("c1", "r1", { name: "mcp__brave__search" })]);
    expect(callsOf(entries, leaf).map((c) => c.function.name)).toEqual(["mcp__brave__search"]);
  });
});

describe("a call id that is not an identifier", () => {
  test("is left out with its result, so the provider is never handed an unpaired half", () => {
    const { entries, leaf } = chain([user("q"), phase("", "r1"), tool("call with spaces", "r1")]);
    const messages = promptOf(entries, leaf);
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    const assistant = messages.find((m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls);
    expect(assistant).toBeUndefined();
  });
});
