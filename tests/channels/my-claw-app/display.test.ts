import { describe, test, expect } from "bun:test";
import { displayOf, pageOf, pageBefore, runFold, runFoldPlan, withSpawnCards, type DisplayResolvers } from "../../../src/channels/my-claw-app/display.ts";
import type { Entry, Provisioned } from "../../../src/sessions/log.ts";
import type { SessionFile } from "../../../src/channels/my-claw-app/files.ts";

let seq = 0;
function chain(bodies: Array<Provisioned<Entry>>): Entry[] {
  const entries: Entry[] = [];
  let parent: string | null = null;
  for (const body of bodies) {
    const n = seq++;
    const made = { ...body, id: `e${n}`, seq: n, parentId: parent, ts: 1_800_000_000_000 + n * 1000 } as unknown as Entry;
    entries.push(made);
    parent = made.id;
  }
  return entries;
}

const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user", prompt: true, text, ...extra }) as Provisioned<Entry>;
const phase = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: "phase", prompt: true, text, runId: "r1", ...extra }) as Provisioned<Entry>;
const tool = (callId: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "tool", prompt: true, callId, name: "mcp__myclaw__bash", args: { command: "ls" },
    output: "ok", truncated: false, ok: true, runId: "r1", ...extra,
  }) as Provisioned<Entry>;

/** The two resolvers, stubbed: what they return is the file store's business, not this module's. */
const resolvers: DisplayResolvers = {
  attachmentsOf: (attachments) => attachments.map((a, i) => ({ id: `att-${i}`, type: "image", name: a.path, size: 1 })),
  attachmentsOfBlock: (entries) => entries.map((e, i) => ({ id: `blk-${i}`, type: e.type as "image", filename: e.source, sizeBytes: 1 })),
  mediaOf: (refs) => refs.map((r, i) => ({ id: `media-${i}`, type: "file", name: r.path, size: 1 })),
};

const show = (entries: readonly Entry[], limit = 1000, files: SessionFile[] = [], runs?: Map<string, import("../../../src/channels/my-claw-app/types.ts").MyClawAppRunMeta>) =>
  displayOf(entries, resolvers, limit, undefined, files, runs);

const runStart = (extra: Record<string, unknown> = {}) => ({ type: "run_start", prompt: false, ...extra }) as Provisioned<Entry>;
const runEnd = (reason: "done" | "aborted" | "error" = "done", media?: string[]) =>
  ({ type: "run_end", prompt: false, reason, ...(media ? { media } : {}) }) as Provisioned<Entry>;

describe("displayOf: one entry, one bubble", () => {
  test("an exchange draws in the order it happened", () => {
    const entries = chain([user("bonjour"), phase("salut")]);
    expect(show(entries).map((e) => [e.role, "text" in e ? e.text : ""])).toEqual([
      ["user", "bonjour"],
      ["assistant", "salut"],
    ]);
  });

  test("a bubble keeps the id of the entry it came from", () => {
    // The whole reason `sourceId` and its 30 s dedup window disappear: the entry is the bubble.
    const entries = chain([user("q"), phase("a")]);
    expect(show(entries).map((e) => e.id)).toEqual([entries[0]!.id, entries[1]!.id]);
  });

  test("nothing is recollated by timestamp", () => {
    // Commands and failures used to live in side journals and be folded back in by comparing
    // timestamps. Here they are entries, so two of them sharing a millisecond still land in the
    // order they were written.
    const entries = chain([
      user("q"),
      { type: "command", prompt: false, input: "/status", output: "ok" },
      { type: "failure", prompt: false, error: "boom" },
      phase("apres"),
    ]);
    for (const entry of entries) (entry as { ts: number }).ts = 1_800_000_000_000;
    const drawn = show(entries);
    expect(drawn.map((e) => (e.role === "tool" ? e.name : e.role === "run" ? "run" : e.text))).toEqual(["q", "/status", "ok", "", "apres"]);
  });
});

describe("displayOf: what the model said", () => {
  test("a phase that only thought is still a bubble", () => {
    // Dropping it is what made a reopened thread jump from the question to a tool card.
    const entries = chain([phase("", { reasoning: "je reflechis" })]);
    const drawn = show(entries);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ role: "assistant", text: "", reasoning: "je reflechis" });
  });

  test("a phase with nothing at all is not a bubble", () => {
    expect(show(chain([phase("   ")]))).toHaveLength(0);
    expect(show(chain([phase("")]))).toHaveLength(0);
  });

  /**
   * Added 2026-09-11: the span is measured at the stream and has to reach the device, or a reopened
   * conversation keeps the thought and loses how long it took.
   */
  test("a phase carries how long it thought, so a reload shows the span", () => {
    const entries = chain([phase("la reponse", { reasoning: "je reflechis", reasoningMs: 4200 })]);
    expect(show(entries).at(0)).toMatchObject({ reasoning: "je reflechis", reasoningMs: 4200 });
  });

  test("a phase written before the field existed sends none, rather than a zero", () => {
    const entries = chain([phase("la reponse", { reasoning: "je reflechis" })]);
    const drawn = show(entries).at(0) as { reasoningMs?: number };
    expect(drawn.reasoningMs).toBeUndefined();
  });

  test("a counted-but-hidden thought still earns its bubble", () => {
    expect(show(chain([phase("", { reasoningTokens: 120 })])).at(0)).toMatchObject({ reasoningTokens: 120 });
  });

  /**
   * Added 2026-09-14: the browser tool attaches its screenshots to the answer and the text never
   * names them, so the live bubble was the only place they existed. A reload brought the prose
   * back and dropped the picture, with the bytes still sitting in the thread's file store.
   */
  test("the media a tool produced lands on the turn it belongs to", () => {
    const entries = chain([
      user("trouve une serie"),
      runStart(),
      phase("voila"),
      runEnd("done", ["/tmp/shots/screenshot.png"]),
    ]);
    const drawn = show(entries);
    const answer = drawn.find((e) => e.role === "assistant") as { attachments?: Array<{ name: string }> };
    expect(answer.attachments?.map((a) => a.name)).toEqual(["/tmp/shots/screenshot.png"]);
  });

  test("a turn's own refs come before the media a tool produced", () => {
    // The live frame is built that way -- docs 505/509 of the adapter -- and a replay that turned
    // the order around would show the same answer with its pictures swapped.
    const entries = chain([
      user("q"),
      runStart(),
      phase("voici\nMEDIA:/tmp/a.png"),
      runEnd("done", ["/tmp/shots/b.png"]),
    ]);
    const answer = show(entries).find((e) => e.role === "assistant") as {
      text: string;
      attachments?: Array<{ name: string }>;
    };
    expect(answer.text).toBe("voici");
    expect(answer.attachments?.map((a) => a.name)).toEqual(["/tmp/a.png", "/tmp/shots/b.png"]);
  });

  test("the media of a run does not leak onto the next turn", () => {
    const entries = chain([
      user("q"),
      runStart(),
      phase("reponse"),
      runEnd("done", ["/tmp/b.png"]),
      user("et ensuite ?"),
    ]);
    const last = show(entries).at(-1) as { role: string; attachments?: unknown };
    expect(last.role).toBe("user");
    expect(last.attachments).toBeUndefined();
  });

  test("a MEDIA ref becomes an attachment and leaves the text", () => {
    const entries = chain([phase("voici le fichier\nMEDIA:/tmp/out.png")]);
    const drawn = show(entries)[0] as { text: string; attachments?: Array<{ name: string }> };
    expect(drawn.text).toBe("voici le fichier");
    expect(drawn.attachments?.map((a) => a.name)).toEqual(["/tmp/out.png"]);
  });
});

describe("displayOf: tool cards", () => {
  test("a card is keyed on the model's call id, not on the entry", () => {
    // A card drawn by history and a card drawn live must be one card: they used to differ, so a
    // tool finishing after a reload appended a second card beside the one just drawn.
    const entries = chain([tool("call_42")]);
    expect(show(entries)[0]!.id).toContain("call_42");
  });

  test("the card shows the tool, not the plumbing", () => {
    expect(show(chain([tool("c1")]))[0]).toMatchObject({ name: "bash" });
  });

  test("a card is never drawn spinning", () => {
    // An entry exists only once the call settled, so history cannot invent a running card. What is
    // still in flight is carried by the live frames and by chat.history.activeRun.
    const drawn = show(chain([tool("c1"), tool("c2", { ok: false, output: "erreur" })]));
    expect(drawn.every((e) => !("running" in e))).toBe(true);
    expect(drawn[1]).toMatchObject({ ok: false, output: "erreur" });
  });

  test("a long output is clipped and says so", () => {
    const drawn = show(chain([tool("c1", { output: "x".repeat(50) })]), 10) as Array<{ output: string; truncated: boolean }>;
    expect(drawn[0]!.output).toHaveLength(10);
    expect(drawn[0]!.truncated).toBe(true);
  });

  test("an output already clipped on disk stays flagged", () => {
    // The entry carries an extract; the rest is in tool-output/. Re-measuring the extract would
    // call it whole and hide the "see more" the reader needs.
    const drawn = show(chain([tool("c1", { output: "court", truncated: true })])) as Array<{ truncated: boolean }>;
    expect(drawn[0]!.truncated).toBe(true);
  });
});

describe("displayOf: a sub-agent's card", () => {
  const spawnState = (extra: Record<string, unknown> = {}) => ({
    subagentId: "subagent/auditor", displayName: "dup-audit", agentType: "research", mode: "run",
    action: "spawn" as const, status: "complete" as const, startedAt: "2026-08-24T15:49:48.654Z", ...extra,
  });

  test("a state entry draws no bubble of its own", () => {
    // It describes another entry. Drawn as a bubble it would read as an empty assistant turn
    // between the question and the card it belongs to.
    const entries = chain([
      user("lance un audit"),
      { type: "spawn_state", prompt: false, callId: "c1", subagentId: "subagent/auditor", status: "running" },
      tool("c1", { name: "spawn" }),
    ]);
    expect(show(entries).map((e) => e.role)).toEqual(["user", "tool"]);
  });

  test("the card carries the state folded from the whole log, not from its page", () => {
    // A child spawned fifty entries ago settles here, so its state entry falls outside the window
    // the page was cut to. Folding over the page alone leaves the card spinning for good.
    const entries = chain([tool("c1", { name: "spawn" })]);
    const drawn = displayOf(entries, resolvers, 1000, new Map([["c1", spawnState()]]));
    expect(drawn[0]).toMatchObject({ spawn: { displayName: "dup-audit", status: "complete" } });
  });

  test("a state imported onto the entry still draws when nothing folded over it", () => {
    // Sessions from before the state entry existed keep it inline. They must not go blank.
    const entries = chain([tool("c1", { name: "spawn", spawn: spawnState({ resultLength: 14565 }) })]);
    expect(show(entries)[0]).toMatchObject({ spawn: { resultLength: 14565 } });
  });

  test("a card nobody reported on carries no state", () => {
    expect("spawn" in show(chain([tool("c1")]))[0]!).toBe(false);
  });
});

describe("withSpawnCards: what a delta can draw", () => {
  test("a state alone becomes the card it revised", () => {
    // The card arrived pages ago, while the child was still running. The client keys on the call id,
    // so resending it whole updates that card instead of drawing a second one.
    const all = chain([tool("c1", { name: "spawn" }), user("et apres")]);
    const state = chain([{ type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "complete" }]);
    const delta = withSpawnCards(state, [...all, ...state]);
    expect(delta).toEqual([all[0]!]);
  });

  test("a card in the delta is not sent twice, whichever side its states fall on", () => {
    // The order production actually writes: `spawn` awaits its child, so both states are appended
    // *before* the tool entry. Standing in for the card on the first state and then letting the
    // real entry through sent it twice, and the client keeps both -- it replaces by id against what
    // it already holds, not within one delta. Shipped in 0.4.61, doubled on every reload.
    const before = chain([
      { type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "running" },
      { type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "complete" },
      tool("c1", { name: "spawn" }),
    ]);
    expect(withSpawnCards(before, before)).toEqual([before[2]!]);

    // And the other way round, for a state that lands after the call settled.
    const after = chain([
      tool("c2", { name: "spawn" }),
      { type: "spawn_state", prompt: false, callId: "c2", subagentId: "s", status: "complete" },
    ]);
    expect(withSpawnCards(after, after)).toEqual([after[0]!]);
  });

  test("the card keeps its own position, it is not hoisted onto its state", () => {
    // Substituting in place would move a settled card ahead of the turn that produced it.
    const all = chain([
      user("q"),
      { type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "complete" },
      phase("j'y vais"),
      tool("c1", { name: "spawn" }),
    ]);
    expect(withSpawnCards(all, all)).toEqual([all[0]!, all[2]!, all[3]!]);
  });

  test("two states on one absent card send it once", () => {
    const all = chain([
      tool("c1", { name: "spawn" }),
      { type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "running" },
      { type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "complete" },
    ]);
    expect(withSpawnCards(all.slice(1), all)).toEqual([all[0]!]);
  });

  test("a state whose call never settled is dropped", () => {
    // There is no card to revise yet: the tool is still running and the live frames carry it.
    const state = chain([{ type: "spawn_state", prompt: false, callId: "c1", subagentId: "s", status: "running" }]);
    expect(withSpawnCards(state, state)).toEqual([]);
  });

  test("a delta with no state entry is handed back untouched", () => {
    const entries = chain([user("q"), phase("a")]);
    expect(withSpawnCards(entries, entries)).toEqual(entries);
  });
});

describe("displayOf: user turns read back the storage form", () => {
  test("a stored voice note loses its [Audio] marker and keeps its words on the attachment", () => {
    const entries = chain([user(`regarde ca\n\n[Audio]: "rappelle-moi demain"\n\n[Attachments]\n- audio: /home/neras/.my-claw/files/my-claw-app/neras/thr/0f23058a-8e46-4d55-8967-fd6e5953f6aa__voice.m4a (12710 ms)`, { transcripts: { "/home/neras/.my-claw/files/my-claw-app/neras/thr/0f23058a-8e46-4d55-8967-fd6e5953f6aa__voice.m4a": "rappelle-moi demain" } })]);
    const drawn = show(entries, 1000, [
      { id: "0f23058a-8e46-4d55-8967-fd6e5953f6aa", filename: "voice.m4a", storedName: "0f23058a-8e46-4d55-8967-fd6e5953f6aa__voice.m4a", type: "audio", mimeType: "audio/mp4", sizeBytes: 4, ts: "2026-01-01" },
    ]);
    const userEntry = drawn[0]!;
    expect(userEntry.role).toBe("user");
    if (userEntry.role !== "user") throw new Error("expected a user entry");
    expect(userEntry.text).toBe("regarde ca");
    expect(userEntry.attachments).toHaveLength(1);
    // The id is the file store's business (attachmentsOfBlock); here the entry reaches the resolver.
    expect(userEntry.transcripts).toEqual({ "0f23058a-8e46-4d55-8967-fd6e5953f6aa": "rappelle-moi demain" });
  });

  test("a failed transcription keeps the fact the owner needs to see", () => {
    const entries = chain([user(`[Audio]: [Transcription failed: boom]`)]);
    const drawn = show(entries);
    if (drawn[0]!.role !== "user") throw new Error("expected a user entry");
    expect(drawn[0]!.text).toContain("[Transcription failed");
  });

  test("an image turn loses the [Attachments] block of server paths", () => {
    const entries = chain([user(`regarde\n\n[Attachments]\n- image: /srv/data/img.png (image/png, 3 bytes, img.png)`)]);
    const drawn = show(entries)[0]!;
    if (drawn.role !== "user") throw new Error("expected a user entry");
    expect(drawn.text).toBe("regarde");
    expect(drawn.attachments).toHaveLength(1);
    expect(drawn.attachments![0]!.filename).toContain("img.png");
  });

  test("a plain user turn is untouched", () => {
    const entries = chain([user("bonjour")]);
    const drawn = show(entries)[0]!;
    if (drawn.role !== "user") throw new Error("expected a user entry");
    expect(drawn.text).toBe("bonjour");
    expect(drawn.attachments).toBeUndefined();
  });
});

const textOf = (item: import("../../../src/channels/my-claw-app/types.ts").MyClawAppHistoryEntry): string =>
  "text" in item ? item.text : "";

describe("displayOf: what is shown and never sent", () => {
  test("a command draws the two bubbles the device drew live", () => {
    const entries = chain([{ type: "command", prompt: false, input: "/compact", output: "fait", details: "900 tokens", sourceId: "send-1" }]);
    const drawn = show(entries);
    expect(drawn[0]).toMatchObject({ id: "send-1", role: "user", text: "/compact" });
    expect(drawn[1]).toMatchObject({ id: "cmd-send-1", role: "assistant", text: "fait", command: true, details: "900 tokens" });
    expect(drawn[0]!.id).not.toBe(drawn[1]!.id);
  });

  test("a /compact that wrote the boundary above it does not repeat it as a bubble", () => {
    // The pair as it is actually stored: the boundary entry, then the command entry right after,
    // both carrying the same summary. Drawn whole it was the same text twice, back to back.
    const entries = chain([
      { type: "compaction", prompt: true, summary: "ce qui precede", count: 116, firstKeptEntryId: "e-keep", tokensBefore: 104039 },
      { type: "command", prompt: false, input: "/compact", output: "Context compacted: 293 -> 178 messages.", details: "ce qui precede", sourceId: "send-1" },
    ]);
    const drawn = show(entries);
    // The rule stands, and the line the owner typed stands: only the redundant report is gone.
    expect(drawn.map(textOf)).toEqual(["ce qui precede", "/compact"]);
    expect(drawn[0]).toMatchObject({ summaryOf: 116 });
    expect(drawn.some((item) => "command" in item && item.command === true)).toBe(false);
  });

  test("a /compact that wrote no boundary keeps its bubble, it is the only trace", () => {
    // An engine that summarized on its own leaves no compaction entry. Dropping this line too
    // would erase the compaction from the thread entirely.
    const entries = chain([
      { type: "user", prompt: true, text: "avant" },
      { type: "command", prompt: false, input: "/compact", output: "Context compacted (SDK session summarized).", sourceId: "send-1" },
    ]);
    const drawn = show(entries);
    expect(drawn.map(textOf)).toEqual(["avant", "/compact", "Context compacted (SDK session summarized)."]);
  });

  test("a refused /compact keeps its reason, boundary above or not", () => {
    const entries = chain([
      { type: "compaction", prompt: true, summary: "ce qui precede", count: 12, firstKeptEntryId: "e-keep", tokensBefore: 4200 },
      { type: "command", prompt: false, input: "/compact", output: "A compaction is already running on this session.", sourceId: "send-1" },
    ]);
    const drawn = show(entries);
    expect(drawn.map(textOf)).toEqual([
      "ce qui precede",
      "/compact",
      "A compaction is already running on this session.",
    ]);
  });

  test("a quiet command replays the result bubble only", () => {
    const entries = chain([{ type: "command", prompt: false, input: "/undo", output: "Undo: conversation rembobinée", sourceId: "send-1", quiet: true }]);
    const drawn = show(entries);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ id: "cmd-send-1", role: "assistant", text: "Undo: conversation rembobinée", command: true });
  });

  test("an old command without a source id keeps a stable fallback", () => {
    const entry = chain([{ type: "command", prompt: false, input: "/status", output: "ok" }])[0]!;
    const drawn = show([entry]);
    expect(drawn.map((item) => item.id)).toEqual([entry.id, `cmd-${entry.id}`]);
  });

  test("a dead run replays as the error the owner was shown", () => {
    const drawn = show(chain([user("q"), { type: "failure", prompt: false, error: "provider down" }]));
    expect(drawn[1]).toMatchObject({ role: "assistant", text: "", error: "provider down" });
  });

  test("a compaction draws as a boundary, not as words the owner typed", () => {
    const entries = chain([
      { type: "compaction", prompt: true, summary: "resume", firstKeptEntryId: "x", tokensBefore: 900, count: 12 },
    ]);
    const drawn = show(entries)[0] as { text: string; summaryOf?: number };
    expect(drawn).toMatchObject({ role: "user", summaryOf: 12 });
    // The summary alone: the instructions wrapped around it are addressed to the model.
    expect(drawn.text).toBe("resume");
  });

  test("a boundary replayed from history carries how long the summary took", () => {
    // The device that watched it run has the counter; the one that opens the thread later has
    // nothing to count from unless the span travelled -- the same gap the thinking duration had.
    const entries = chain([
      { type: "compaction", prompt: true, summary: "resume", firstKeptEntryId: "x", tokensBefore: 900, count: 12, compactionMs: 84_500 },
    ]);
    expect(show(entries)[0]).toMatchObject({ role: "user", summaryOf: 12, compactionMs: 84_500 });
  });

  test("a boundary nobody timed shows no span rather than a zero", () => {
    const entries = chain([
      { type: "compaction", prompt: true, summary: "resume", firstKeptEntryId: "x", tokensBefore: 900, count: 12 },
    ]);
    expect(show(entries)[0]).not.toHaveProperty("compactionMs");
  });

  test("a stopped compaction draws the same rule, holding what it left instead of a summary", () => {
    const entries = chain([
      { type: "compaction_stopped", prompt: false, kept: 12 },
    ]);
    const drawn = show(entries)[0];
    // The same shape as the boundary -- a rule across the thread, one count, no body, because
    // there is no summary to show: the turns are all still underneath it.
    expect(drawn).toMatchObject({ role: "user", text: "", summaryOf: 12, compactionStopped: true });
    expect(drawn).not.toHaveProperty("compactionMs");
  });

  test("a stopped pass that was timed travels with its span, like the boundary it never became", () => {
    const entries = chain([
      { type: "compaction_stopped", prompt: false, kept: 4, compactionMs: 2_100 },
    ]);
    expect(show(entries)[0]).toMatchObject({ role: "user", summaryOf: 4, compactionMs: 2_100 });
  });

  test("the trace is never folded into the run it interrupted", () => {
    // A mid-conversation compaction runs while a root run is open, so the trace lands inside the
    // run's markers. Folding it away would hide it behind a header about tool calls.
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 10 }, (_, i) => tool(`c${i}`)),
      { type: "compaction_stopped", prompt: false, kept: 6 },
      runEnd(),
    ]);
    const runs = runFold(path);
    const plan = runFoldPlan(path, path, runs);
    const trace = path[path.length - 2]!;
    expect(plan.folded.has(trace.id)).toBe(false);
    const shown = displayOf(path, resolvers, 1000, undefined, [], runs, plan);
    expect(shown.some((e) => "compactionStopped" in e && e.compactionStopped === true)).toBe(true);
  });
});

describe("pageOf", () => {
  const long = () => chain([user("q1"), phase("a1"), user("q2"), phase("a2"), tool("c1"), phase("a3"), user("q3"), phase("a4")]);

  test("the newest page is the tail", () => {
    const path = long();
    const { window, hasMore } = pageOf(path, 2, 0);
    expect(window.map((e) => e.id)).toEqual([path[6]!.id, path[7]!.id]);
    expect(hasMore).toBe(true);
  });

  test("a page starts on a question, not mid-work", () => {
    // A count cuts inside a turn; a reader sees work with no question above it and reads a lost
    // message rather than pagination.
    const path = long();
    const { window } = pageOf(path, 3, 0);
    expect(window[0]!.type).toBe("user");
    // The count asked to start inside the turn opened by `q2`; the page starts at `q2` instead.
    expect(window[0]!.id).toBe(path[2]!.id);
  });

  test("the next page ends where this one began", () => {
    const path = long();
    const first = pageOf(path, 3, 0);
    const second = pageOf(path, 3, first.nextBefore);
    expect(second.window[second.window.length - 1]!.id).toBe(path[1]!.id);
    expect(first.window.some((e) => second.window.some((s) => s.id === e.id))).toBe(false);
  });

  test("the oldest page says there is nothing above it", () => {
    const path = long();
    expect(pageOf(path, 100, 0).hasMore).toBe(false);
  });

  test("scrolling past the start is an empty page, not an error", () => {
    expect(pageOf(long(), 10, 999)).toMatchObject({ window: [], hasMore: false });
    expect(pageOf([], 10, 0)).toMatchObject({ window: [], hasMore: false });
  });

  test("a turn longer than the lookback starts mid-flight rather than dragging the session in", () => {
    const path = chain([user("q"), ...Array.from({ length: 40 }, (_, i) => phase(`a${i}`))]);
    const { window } = pageOf(path, 5, 0, 3);
    expect(window[0]!.type).toBe("phase");
    expect(window).toHaveLength(8);
  });
});

describe("runFold: the branch read as runs", () => {

  test("work between the markers belongs to the run they delimit", () => {
    const entries = chain([user("q"), runStart(), phase("thinking", { reasoning: "hmm" }), tool("c1"), runEnd(), phase("next")]);
    const runs = runFold(entries);
    expect(runs.get(entries[2]!.id)).toMatchObject({ status: "done" });
    expect(runs.get(entries[3]!.id)?.id).toBe(entries[1]!.id);
    // Past the run_end there is no run anymore.
    expect(runs.get(entries[5]!.id)).toBeUndefined();
  });

  test("the run is named by the id the wire announced it under, not by its marker's entry id", () => {
    // `chat.run.start` carries the run context's correlation id; the marker stores the same one,
    // so a live item and its persisted entry agree on the run without the app renaming anything.
    const entries = chain([user("q"), runStart({ runId: "c0ffee42" }), tool("c1"), runEnd()]);
    const runs = runFold(entries);
    expect(runs.get(entries[2]!.id)?.id).toBe("c0ffee42");
    expect(runs.get(entries[1]!.id)?.id).toBe("c0ffee42");
  });

  test("a marker written before runs carried their id names the run after its own entry", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), runEnd()]);
    expect(runFold(entries).get(entries[2]!.id)?.id).toBe(entries[1]!.id);
  });

  test("two runs are distinct groups", () => {
    const entries = chain([user("q1"), runStart(), tool("c1"), runEnd(), user("q2"), runStart(), tool("c2"), runEnd()]);
    const runs = runFold(entries);
    const first = runs.get(entries[2]!.id)!;
    const second = runs.get(entries[6]!.id)!;
    expect(first.id).not.toBe(second.id);
    expect([first.status, second.status]).toEqual(["done", "done"]);
  });

  test("the reason of the end marker is the run's status", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), runEnd("error")]);
    expect(runFold(entries).get(entries[2]!.id)?.status).toBe("error");
    const aborted = chain([user("q"), runStart(), phase("half"), runEnd("aborted")]);
    expect(runFold(aborted).get(aborted[2]!.id)?.status).toBe("aborted");
  });

  test("a run whose end is missing closes when the next run starts, and does not swallow the turn that started it", () => {
    // The shape a dead branch or a crash leaves: run 1 has a start and no end on this branch,
    // then the owner asks again. Left open, run 1 rendered as running forever (the app settles
    // only the trailing run) and the new question read as a steer folded into it.
    const entries = chain([user("q1"), runStart(), tool("c1"), phase("half"), user("q2"), runStart(), tool("c2"), runEnd()]);
    const runs = runFold(entries);
    const first = runs.get(entries[2]!.id)!;
    expect(first.status).toBe("done");
    // Closed at its last own entry, not at the next run's start.
    expect(first.endTs).toBe(new Date(entries[3]!.ts).toISOString());
    expect(runs.get(entries[4]!.id)).toBeUndefined();
    expect(runs.get(entries[6]!.id)?.id).toBe(entries[5]!.id);
  });

  test("two starts in a row (no trigger turn between them) still close the first", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), runStart(), tool("c2"), runEnd()]);
    const runs = runFold(entries);
    expect(runs.get(entries[2]!.id)).toMatchObject({ status: "done", endTs: new Date(entries[2]!.ts).toISOString() });
    expect(runs.get(entries[4]!.id)?.id).toBe(entries[3]!.id);
  });

  test("a user turn inside the run (injection) belongs to it", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), user("steer"), phase("answer"), runEnd()]);
    const runs = runFold(entries);
    expect(runs.get(entries[3]!.id)?.id).toBe(entries[1]!.id);
    expect(runs.get(entries[4]!.id)?.id).toBe(entries[1]!.id);
  });

  test("a trailing run with no end stays running", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), phase("still working")]);
    expect(runFold(entries).get(entries[3]!.id)?.status).toBe("running");
  });

  test("a run_end without an open run is ignored", () => {
    const entries = chain([user("q"), runEnd(), phase("orphan")]);
    expect(runFold(entries).get(entries[2]!.id)).toBeUndefined();
  });

  test("the markers themselves carry their own meta, keyed by their id", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), runEnd()]);
    const meta = runFold(entries).get(entries[1]!.id)!;
    expect(meta.status).toBe("done");
    expect(meta.startTs).toBe(new Date(entries[1]!.ts).toISOString());
  });
});

describe("displayOf with run meta", () => {
  test("the markers are not bubbles", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), runEnd(), phase("answer")]);
    const shown = show(entries);
    expect(shown.map((e) => e.id)).toEqual([entries[0]!.id, "t-c1", entries[4]!.id]);
  });

  test("each kept bubble carries its run", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), runEnd(), phase("answer")]);
    const runs = runFold(entries);
    const shown = show(entries, 1000, [], runs);
    expect(shown[1]!.run).toMatchObject({ status: "done" });
    expect(shown[1]!.run?.id).toBe(entries[1]!.id);
    expect(shown[0]!.run).toBeUndefined();
    expect(shown[2]!.run).toBeUndefined();
  });

  test("an injection user bubble inside a run keeps its run too", () => {
    const entries = chain([user("q"), runStart(), tool("c1"), user("steer"), phase("answer"), runEnd()]);
    const runs = runFold(entries);
    const shown = show(entries, 1000, [], runs);
    expect(shown[2]!.run?.id).toBe(entries[1]!.id);
  });
});

describe("runFoldPlan: a finished run travels as its header", () => {
  /** A run of `n` tool calls, wrapped in its markers, after the question that caused it. */
  const withRun = (n: number, end: "done" | "aborted" | "error" | null = "done") =>
    chain([
      user("q"),
      runStart(),
      ...Array.from({ length: n }, (_, i) => tool(`c${i}`)),
      ...(end ? [runEnd(end)] : []),
    ]);

  const foldedShow = (path: Entry[], window: Entry[] = path, minItems?: number) => {
    const runs = runFold(path);
    return displayOf(window, resolvers, 1000, undefined, [], runs, runFoldPlan(path, window, runs, minItems));
  };

  test("the work is replaced by one row, where the run stood", () => {
    const path = withRun(10);
    const shown = foldedShow(path);
    // The question, then the run as a single row. The ten cards do not travel.
    expect(shown.map((e) => e.role)).toEqual(["user", "run"]);
    // Keyed on the first entry it stands for: a run cut into segments has one row per segment,
    // and the run id could not tell them apart.
    expect(shown[1]!.id).toBe(`run-${path[2]!.id}`);
  });

  test("the header carries what it draws, and the counts are the run's", () => {
    const path = withRun(10);
    const summary = foldedShow(path)[1]!;
    expect(summary).toMatchObject({
      role: "run",
      toolCount: 10,
      itemCount: 10,
      firstTool: "bash",
      run: { id: path[1]!.id, status: "done" },
    });
    // The row stands where the work stood, so segments sort in the order the reader met them.
    expect(summary.ts).toBe(new Date(path[2]!.ts).toISOString());
  });

  test("itemCount is the number of rows that will arrive, not of entries", () => {
    // A turn writes a phase per tool call, and the ones that only thought carry nothing to draw.
    // Counting entries claimed 528 items for a run rendering 386 on the measured session: the
    // skeleton would be a third too long and the scrollbar would jump when the items land.
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 9 }, (_, i) => [phase(""), tool(`c${i}`)]).flat(),
      runEnd(),
    ]);
    const runs = runFold(path);
    const rendered = displayOf(path, resolvers, 1000, undefined, [], runs).filter((e) => e.run).length;
    const summary = foldedShow(path)[1]!;
    expect(summary.role === "run" ? summary.itemCount : -1).toBe(rendered);
    expect(rendered).toBe(9);
  });

  test("nothing folds unless asked", () => {
    // The same page without a plan: this is what an app that did not ask still receives.
    const path = withRun(10);
    const runs = runFold(path);
    expect(displayOf(path, resolvers, 1000, undefined, [], runs).map((e) => e.role)).toEqual([
      "user", ...Array.from({ length: 10 }, () => "tool" as const),
    ]);
  });

  test("a small run stays whole", () => {
    // Under the threshold the header costs more than the work it hides, and opening it would
    // buy a round trip to see three lines.
    const path = withRun(3);
    expect(foldedShow(path).map((e) => e.role)).toEqual(["user", "tool", "tool", "tool"]);
  });

  test("a run still going is never folded", () => {
    // It is what the live frames are appending to: folding it would fight the stream.
    const path = withRun(10, null);
    expect(foldedShow(path).filter((e) => e.role === "tool")).toHaveLength(10);
  });

  test("an aborted run folds like a finished one, and says so", () => {
    const path = withRun(10, "aborted");
    expect(foldedShow(path)[1]).toMatchObject({ role: "run", run: { status: "aborted" } });
  });

  test("a run the page boundary cut folds on both pages, with distinct rows", () => {
    // Requiring the run to sit wholly inside the window refused to fold anything on the deep
    // pages, which are the heavy ones. Keying each row on the first entry it stands for makes the
    // two ids distinct by construction, so there is nothing left to protect against.
    const path = withRun(20);
    const lower = path.slice(0, 12);
    const upper = path.slice(12);
    const a = foldedShow(path, lower);
    const b = foldedShow(path, upper);
    expect(a.filter((e) => e.role === "run")).toHaveLength(1);
    expect(b.filter((e) => e.role === "run")).toHaveLength(1);
    expect(a.find((e) => e.role === "run")!.id).not.toBe(b.find((e) => e.role === "run")!.id);
    // Between them they still stand for every card, once.
    const rows = [a, b].flat().filter((e) => e.role === "run") as Array<{ itemCount: number }>;
    expect(rows.reduce((n, r) => n + r.itemCount, 0)).toBe(20);
  });

  test("a folded row is bounded, so hydration can ask for an exact range", () => {
    const path = withRun(10);
    const summary = foldedShow(path)[1]!;
    expect(summary.role === "run" ? summary.lastId : "").toBe(path[path.length - 2]!.id);
  });

  test("a run whose end marker is on the next page still folds", () => {
    // `run_end` renders to nothing and the status comes from the whole-branch fold, so its
    // absence from the window costs the reader nothing.
    const path = withRun(10);
    const window = path.slice(0, path.length - 1);
    expect(foldedShow(path, window)[1]).toMatchObject({ role: "run", run: { status: "done" } });
  });

  test("a state entry folded into its card does not unfold the run", () => {
    // `withSpawnCards` drops a `spawn_state` whose card is already in the delta, so the window
    // no longer holds every entry of the run. Requiring it would unfold every run that spawned.
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)),
      { type: "spawn_state", prompt: false, callId: "c0", state: { status: "running" } } as unknown as Provisioned<Entry>,
      runEnd(),
    ]);
    const window = path.filter((e) => e.type !== "spawn_state");
    expect(foldedShow(path, window).map((e) => e.role)).toEqual(["user", "run"]);
  });

  test("the run's answer stays on screen, outside the fold", () => {
    // The whole point of hoisting: fold the answer away and a reopened conversation is a list of
    // questions with collapsed headers and nothing under them.
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)),
      phase("voila ce que j'ai trouve"),
      runEnd(),
    ]);
    const shown = foldedShow(path);
    expect(shown.map((e) => e.role)).toEqual(["user", "run", "assistant"]);
    expect(shown[2]).toMatchObject({ text: "voila ce que j'ai trouve" });
  });

  test("a run that died before answering keeps everything in the fold", () => {
    // Its last entry is a tool card, so there is no answer to hoist.
    const path = chain([
      user("q"), runStart(), ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)), runEnd("aborted"),
    ]);
    expect(foldedShow(path).map((e) => e.role)).toEqual(["user", "run"]);
  });

  test("a turn the owner injected mid-run cuts the fold in two", () => {
    // The steering message splits the group around it, so the work before and after it stay
    // separately readable -- and each half gets its own header, which is why a summary cannot be
    // keyed by run id.
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 9 }, (_, i) => tool(`a${i}`)),
      user("plutot comme ca"),
      ...Array.from({ length: 9 }, (_, i) => tool(`b${i}`)),
      phase("fait"),
      runEnd(),
    ]);
    const shown = foldedShow(path);
    expect(shown.map((e) => e.role)).toEqual(["user", "run", "user", "run", "assistant"]);
    expect(shown[1]!.id).not.toBe(shown[3]!.id);
    // Both headers name the same run: they are two segments of one turn.
    expect(shown[1]!.run!.id).toBe(shown[3]!.run!.id);
  });

  test("a command bubble inside a run stays visible", () => {
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 9 }, (_, i) => tool(`a${i}`)),
      { type: "command", prompt: false, input: "/status", output: "context 12%" } as unknown as Provisioned<Entry>,
      ...Array.from({ length: 9 }, (_, i) => tool(`b${i}`)),
      runEnd(),
    ]);
    // The two bubbles a command draws, between the two halves of the work.
    expect(foldedShow(path).map((e) => e.role)).toEqual(["user", "run", "user", "assistant", "run"]);
  });

  test("a segment too small to fold keeps its items while the big one folds", () => {
    const path = chain([
      user("q"),
      runStart(),
      tool("a0"), tool("a1"),
      user("attends"),
      ...Array.from({ length: 9 }, (_, i) => tool(`b${i}`)),
      runEnd(),
    ]);
    expect(foldedShow(path).map((e) => e.role)).toEqual(["user", "tool", "tool", "user", "run"]);
  });

  test("what lives outside a run is untouched", () => {
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)),
      runEnd(),
      phase("after the run"),
    ]);
    const shown = foldedShow(path);
    expect(shown.map((e) => e.role)).toEqual(["user", "run", "assistant"]);
    expect(shown[2]!.id).toBe(path[path.length - 1]!.id);
  });

  test("two finished runs fold into two distinct rows", () => {
    const path = chain([
      user("q1"), runStart(), ...Array.from({ length: 9 }, (_, i) => tool(`a${i}`)), runEnd(),
      user("q2"), runStart(), ...Array.from({ length: 9 }, (_, i) => tool(`b${i}`)), runEnd(),
    ]);
    const shown = foldedShow(path);
    expect(shown.map((e) => e.role)).toEqual(["user", "run", "user", "run"]);
    expect(shown[1]!.id).not.toBe(shown[3]!.id);
  });

  test("the fold is what makes the page small", () => {
    // The measurement the whole thing exists for, in miniature: the same window, both ways.
    const path = chain([
      user("q"),
      runStart(),
      ...Array.from({ length: 20 }, (_, i) => tool(`c${i}`, { output: "x".repeat(4000) })),
      runEnd(),
    ]);
    const runs = runFold(path);
    const whole = JSON.stringify(displayOf(path, resolvers, 4000, undefined, [], runs)).length;
    const folded = JSON.stringify(foldedShow(path)).length;
    expect(folded * 20).toBeLessThan(whole);
  });
});

describe("pageBefore: a folded run as the cursor", () => {
  test("`run-<id>` pages back from the first entry the fold stands for", () => {
    // The client's oldest held row can be a summary. If its id resolves to nothing the page comes
    // back empty, the app reads that as the top of the conversation, and paging dies for good --
    // which is exactly what shipped in 0.4.83 with `t-<callId>`.
    const path = chain([
      user("older"), phase("answer"),
      user("q"), runStart(), ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)), runEnd(),
    ]);
    const firstFolded = path[4]!; // the first tool: what the summary stands on
    const { window, hasMore } = pageBefore(path, `run-${firstFolded.id}`, 10, 0);
    // Everything above the work, and none of it.
    expect(window.map((e) => e.id)).toEqual(path.slice(0, 4).map((e) => e.id));
    expect(window.some((e) => e.type === "tool")).toBe(false);
    expect(hasMore).toBe(false);
  });

  test("the cursor of a summary is the id the fold actually emitted", () => {
    const path = chain([user("q"), runStart(), ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)), runEnd()]);
    const runs = runFold(path);
    const summary = displayOf(path, resolvers, 1000, undefined, [], runs, runFoldPlan(path, path, runs))[1]!;
    // Held id in, entries out: the round trip the app makes on scroll. Never an empty page.
    const { window } = pageBefore(path, summary.id, 10, 0);
    expect(window.length).toBeGreaterThan(0);
    expect(window.some((e) => e.type === "tool")).toBe(false);
    expect(window[0]!.id).toBe(path[0]!.id);
  });

  test("an id no branch holds still falls back rather than emptying the page", () => {
    const path = chain([user("q"), runStart(), ...Array.from({ length: 9 }, (_, i) => tool(`c${i}`)), runEnd()]);
    const { window } = pageBefore(path, "run-nope", 5, 0);
    expect(window.length).toBeGreaterThan(0);
  });
});
