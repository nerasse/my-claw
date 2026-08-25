import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { RunRecorder, newRunId } from "../../src/agent/run-recorder.ts";
import { openSessionLog, sessionDir, type SessionLog, type PhaseEntry, type ToolEntry } from "../../src/sessions/log.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import { readToolOutput } from "../../src/sessions/tool-output.ts";

const SESSION = "recorder";

let entries: SessionLog;
beforeEach(async () => {
  await rm(sessionDir(SESSION), { recursive: true, force: true });
  await mkdir(sessionDir(SESSION), { recursive: true });
  entries = await openSessionLog(SESSION);
});

const call = (callId: string, over: Partial<Parameters<RunRecorder["tool"]>[0]> = {}) => ({
  callId, name: "bash", arguments: '{"command":"ls"}', output: "ok", ok: true, ...over,
});

describe("newRunId", () => {
  test("two ids are never the same", () => {
    expect(new Set(Array.from({ length: 100 }, () => newRunId())).size).toBe(100);
  });
});

describe("RunRecorder: one model turn", () => {
  test("a turn with no phases is its own only phase", async () => {
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({ content: "salut", reasoning: "je reflechis" });
    await entries.flush();
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ type: "phase", text: "salut", reasoning: "je reflechis" });
  });

  test("a cut turn keeps its cuts", async () => {
    // The live stream closes a bubble whenever thinking follows text. Glued back together, a
    // reopened conversation stacked every thought above prose they were not about.
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({
      content: "un\n\ndeux",
      segments: [{ reasoning: "a", content: "un" }, { reasoning: "b", content: "deux" }],
    });
    expect(phases.map((p) => p.text)).toEqual(["un", "deux"]);
    expect(phases.map((p) => p.reasoning)).toEqual(["a", "b"]);
  });

  test("the phases of one call share a run, two calls do not", async () => {
    const recorder = new RunRecorder(entries);
    const first = recorder.turn({ content: "x", segments: [{ content: "un" }, { content: "deux" }] });
    recorder.nextTurn();
    const second = recorder.turn({ content: "trois" });
    expect(first[0]!.runId).toBe(first[1]!.runId);
    expect(second[0]!.runId).not.toBe(first[0]!.runId);
  });

  test("the thinking count is on the turn, not on every phase", async () => {
    // Repeated per phase, every reader adding them up multiplies what the model actually thought.
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({ content: "x", reasoningTokens: 300, segments: [{ content: "un" }, { content: "deux" }] });
    expect(phases.map((p) => p.reasoningTokens)).toEqual([undefined, 300]);
  });
});

describe("RunRecorder: provider state", () => {
  const meta = { chat: { field: "reasoning_content", content: "chaine" } } as never;

  test("it is persisted, which it was not before", async () => {
    // It used to live only in the in-memory prompt array, so a run resumed after a restart lost
    // the chain -- docs/session-log.md §2.3.
    const recorder = new RunRecorder(entries);
    recorder.turn({ content: "x", providerMeta: meta });
    await entries.flush();
    const reread = (await openSessionLog(SESSION)).entries()[0] as PhaseEntry;
    expect(reread.providerMeta).toEqual(meta);
  });

  test("it rides on the last phase alone", async () => {
    // It describes where the provider left the turn; an earlier phase describes a position it has
    // already moved past.
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({ content: "x", providerMeta: meta, segments: [{ content: "un" }, { content: "deux" }] });
    expect(phases[0]!.providerMeta).toBeUndefined();
    expect(phases[1]!.providerMeta).toEqual(meta);
  });

  test("a cut turn hands back nothing", async () => {
    // A truncated turn can carry a half-formed reasoning item, and handing that back is how a
    // signed chain gets refused for the rest of the run.
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({ content: "x", providerMeta: meta, incomplete: true });
    expect(phases[0]!.providerMeta).toBeUndefined();
    // The visible text survives either way.
    expect(phases[0]!.text).toBe("x");
  });
});

describe("RunRecorder: tools", () => {
  test("a settled call becomes an entry carrying its result", async () => {
    const recorder = new RunRecorder(entries);
    const entry = await recorder.tool(call("c1", { durationMs: 12 }));
    expect(entry).toMatchObject({ type: "tool", callId: "c1", name: "bash", args: { command: "ls" }, output: "ok", ok: true, durationMs: 12 });
  });

  test("a tool belongs to the turn that asked for it", async () => {
    const recorder = new RunRecorder(entries);
    const [phase] = recorder.turn({ content: "je regarde" });
    const entry = await recorder.tool(call("c1"));
    expect(entry.runId).toBe(phase!.runId);
  });

  test("half-written arguments are kept raw rather than lost", async () => {
    // A turn cut on `length` stops mid-serialization. The card must show what was attempted.
    const recorder = new RunRecorder(entries);
    const entry = await recorder.tool(call("c1", { arguments: '{"path":"x.ts","content":"half of' }));
    expect(entry.args).toEqual({ raw: '{"path":"x.ts","content":"half of' });
  });

  test("a long output goes beside the entry, which names it", async () => {
    const recorder = new RunRecorder(entries);
    const entry = await recorder.tool(call("c1", { output: "x".repeat(60_000) }));
    expect(entry.truncated).toBe(true);
    expect(entry.outputPath).toBeDefined();
    expect(await readToolOutput(SESSION, "c1")).toHaveLength(60_000);
  });

  test("the file exists by the time the entry names it", async () => {
    // The one state the card's see-all button cannot recover from is an entry pointing at a file
    // that is not there yet, which is why this await is not optional.
    const recorder = new RunRecorder(entries);
    const entry = await recorder.tool(call("c1", { output: "y".repeat(60_000) }));
    expect(await readToolOutput(SESSION, entry.callId)).not.toBeNull();
  });

  test("a failed call is still an entry", async () => {
    const recorder = new RunRecorder(entries);
    const entry = await recorder.tool(call("c1", { ok: false, output: "Error: nope" }));
    expect(entry).toMatchObject({ ok: false, output: "Error: nope" });
  });
});

describe("RunRecorder: the prompt it produces", () => {
  test("a turn with tools projects to a legal exchange", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "liste" });
    recorder.turn({ content: "je regarde" });
    await recorder.tool(call("c1"));
    recorder.nextTurn();
    recorder.turn({ content: "voila" });
    await entries.flush();

    expect(promptOf(entries.entries(), entries.leaf())).toEqual([
      { role: "user", content: "liste" },
      { role: "assistant", content: "je regarde", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "voila" },
    ]);
  });

  test("a run killed between the call and its result asks for nothing", async () => {
    // The structural reason a dangling tool call cannot happen: the calls in the prompt are
    // derived from the entries that carry the results, so there is nothing to seal.
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "build" });
    recorder.turn({ content: "je lance" });
    await entries.flush();

    const out = promptOf(entries.entries(), entries.leaf());
    expect(out).toEqual([
      { role: "user", content: "build" },
      { role: "assistant", content: "je lance" },
    ]);
  });

  test("what is shown and never sent stays out", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "q" });
    recorder.command("/status", "tout va bien");
    recorder.failure("API Error 529");
    recorder.turn({ content: "a" });
    await entries.flush();

    expect(promptOf(entries.entries(), entries.leaf())).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    // On disk all the same, which is what a reopened thread shows.
    expect(entries.entries().map((e) => e.type)).toEqual(["user", "command", "failure", "phase"]);
  });
});

describe("RunRecorder: rewind never erases a user turn", () => {
  test("a run that fails after its opening question keeps that question", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "la question du proprio" });
    recorder.turn({ content: "un debut" });
    await recorder.tool(call("c1"));
    recorder.rewind();
    await entries.flush();

    const prompt = promptOf(entries.entries(), entries.leaf());
    expect(prompt.map((m) => m.content)).toEqual(["la question du proprio"]);
  });

  test("a mid-run injection survives a later failure", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "question initiale" });
    recorder.turn({ content: "debut" });
    await recorder.tool(call("c1"));
    recorder.nextTurn();
    recorder.user({ text: "steering mid-run" });
    recorder.turn({ content: "suite" });
    await recorder.tool(call("c2"));
    recorder.rewind();
    await entries.flush();

    const prompt = promptOf(entries.entries(), entries.leaf());
    expect(prompt.map((m) => m.content)).toEqual(["question initiale", "debut", "ok", "steering mid-run"]);
  });

  test("two injections: rewind stops at the last one", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "q1" });
    recorder.turn({ content: "a1" });
    recorder.user({ text: "q2" });
    recorder.turn({ content: "a2" });
    recorder.user({ text: "q3" });
    recorder.turn({ content: "a3 qui echoue" });
    recorder.rewind();
    await entries.flush();

    const prompt = promptOf(entries.entries(), entries.leaf());
    expect(prompt.map((m) => m.content)).toEqual(["q1", "a1", "q2", "a2", "q3"]);
  });
});

describe("RunRecorder: a run that fails", () => {
  test("rewinding keeps what the run wrote and takes it off the branch", async () => {
    // The old loop cut the array back, destroying the turn. A branch is what makes the abandoned
    // attempt a sibling of the retry rather than something the retry overwrote.
    // The user turn survives (it is the owner's question), only the model's work is abandoned.
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "avant" });
    recorder.turn({ content: "etabli" });
    await entries.flush();

    const failing = new RunRecorder(entries);
    failing.user({ text: "la question qui a echoue" });
    failing.turn({ content: "un debut de reponse" });
    await failing.tool(call("c1"));
    const writtenBefore = entries.entries().length;

    failing.rewind();
    await entries.flush();

    // Nothing was deleted.
    expect(entries.entries()).toHaveLength(writtenBefore);
    // The user's question survives; only the assistant's work is gone.
    expect(promptOf(entries.entries(), entries.leaf()).map((m) => m.content)).toEqual(["avant", "etabli", "la question qui a echoue"]);
  });

  test("the abandoned branch is still reachable, and coherent", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "q" });
    const failing = new RunRecorder(entries);
    failing.turn({ content: "mort" });
    const deadLeaf = entries.leaf();
    await failing.tool(call("c1"));
    const deadTip = entries.leaf();
    failing.rewind();
    await entries.flush();
    void deadLeaf;

    const revisited = promptOf(entries.entries(), deadTip);
    expect(revisited.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // Every call it asked for is answered: nothing to seal on a branch nobody is on.
    const asked = revisited.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
    const answered = revisited.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(answered).toEqual(asked);
  });

  test("a retry after a rewind is a sibling, not an overwrite", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "question" });
    const failing = new RunRecorder(entries);
    failing.turn({ content: "mauvaise reponse" });
    const dead = entries.leaf();
    failing.rewind();

    const retry = new RunRecorder(entries);
    retry.turn({ content: "bonne reponse" });
    await entries.flush();

    expect(promptOf(entries.entries(), entries.leaf()).map((m) => m.content)).toEqual(["question", "bonne reponse"]);
    expect(promptOf(entries.entries(), dead).map((m) => m.content)).toEqual(["question", "mauvaise reponse"]);
  });

  test("a run that wrote nothing rewinds to where it was", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "q" });
    await entries.flush();
    const leaf = entries.leaf();

    const failing = new RunRecorder(entries);
    failing.rewind();
    expect(entries.leaf()).toBe(leaf);
  });

  test("the first run of a conversation rewinds to nothing", async () => {
    const failing = new RunRecorder(entries);
    expect(failing.origin()).toBeNull();
    failing.turn({ content: "mort-ne" });
    failing.rewind();
    await entries.flush();
    expect(entries.leaf()).toBeNull();
    expect(promptOf(entries.entries(), entries.leaf())).toEqual([]);
    // Written all the same: the bubble was on screen.
    expect(entries.entries()).toHaveLength(1);
  });
});

describe("RunRecorder: durability", () => {
  test("what a run wrote survives a reopen", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ text: "q", attachments: [{ type: "image", path: "/tmp/a.png" }] });
    recorder.turn({ content: "a" });
    await recorder.tool(call("c1"));
    await entries.flush();

    const reread = await openSessionLog(SESSION, entries.leaf());
    expect(reread.entries().map((e) => e.type)).toEqual(["user", "phase", "tool"]);
    expect(promptOf(reread.entries(), reread.leaf())).toEqual(promptOf(entries.entries(), entries.leaf()));
  });

  test("a tool entry reread names the same file", async () => {
    const recorder = new RunRecorder(entries);
    await recorder.tool(call("c1", { output: "z".repeat(60_000) }));
    await entries.flush();
    const reread = (await openSessionLog(SESSION)).entries()[0] as ToolEntry;
    expect(await readToolOutput(SESSION, reread.callId)).toHaveLength(60_000);
  });
});
