import { describe, test, expect } from "bun:test";
import { displayOf, pageOf, runFold, withSpawnCards, type DisplayResolvers } from "../../../src/channels/my-claw-app/display.ts";
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
const runEnd = (reason: "done" | "aborted" | "error" = "done") => ({ type: "run_end", prompt: false, reason }) as Provisioned<Entry>;

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
    expect(drawn.map((e) => ("text" in e ? e.text : e.name))).toEqual(["q", "/status", "ok", "", "apres"]);
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

  test("a counted-but-hidden thought still earns its bubble", () => {
    expect(show(chain([phase("", { reasoningTokens: 120 })])).at(0)).toMatchObject({ reasoningTokens: 120 });
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

describe("displayOf: what is shown and never sent", () => {
  test("a command draws the two bubbles the device drew live", () => {
    const entries = chain([{ type: "command", prompt: false, input: "/compact", output: "fait", details: "900 tokens", sourceId: "send-1" }]);
    const drawn = show(entries);
    expect(drawn[0]).toMatchObject({ id: "send-1", role: "user", text: "/compact" });
    expect(drawn[1]).toMatchObject({ id: "cmd-send-1", role: "assistant", text: "fait", command: true, details: "900 tokens" });
    expect(drawn[0]!.id).not.toBe(drawn[1]!.id);
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
