import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { RunRecorder, newTurnId } from "../../src/agent/run-recorder.ts";
import { openSessionLog, sessionDir, type SessionLog, type PhaseEntry, type ToolEntry } from "../../src/sessions/log.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import { readToolOutput } from "../../src/sessions/tool-output.ts";
import { setRunBubbles, withRunContext } from "../../src/utils/run-context.ts";

const SESSION = "recorder";

let entries: SessionLog;
beforeEach(async () => {
  await rm(sessionDir(SESSION), { recursive: true, force: true });
  await mkdir(sessionDir(SESSION), { recursive: true });
  entries = await openSessionLog(SESSION);
});

afterEach(async () => {
  // Drain the write queue before the next test destroys the directory. Without this, pending
  // writes from one test can race with rm -rf of the next, causing spurious ENOENT errors.
  await entries.flush();
});

const call = (callId: string, over: Partial<Parameters<RunRecorder["tool"]>[0]> = {}) => ({
  callId, name: "bash", arguments: '{"command":"ls"}', output: "ok", ok: true, ...over,
});

describe("RunRecorder: what a run produced", () => {
  test("a run_end keeps the media a tool produced", async () => {
    // The browser's screenshots reach the owner as attachments on the answer, and nothing in the
    // text names them. Without this line on the marker, a reopened thread showed the prose and
    // dropped the picture (2026-09-14).
    const recorder = new RunRecorder(entries);
    recorder.runEnd("done", ["/tmp/shots/screenshot.png"]);
    await entries.flush();

    const written = (await (await openSessionLog(SESSION)).all()).at(-1);
    expect(written).toMatchObject({ type: "run_end", reason: "done", media: ["/tmp/shots/screenshot.png"] });
  });

  test("a run that stored its pictures names the copy on the marker", async () => {
    // The id is what a device fetches, and the store finds it from any thread of the owner -- a
    // filename match in one thread directory cannot see a sub-agent's copy at all (2026-09-15).
    const recorder = new RunRecorder(entries);
    recorder.runEnd("done", ["/tmp/shots/screenshot.png"], ["f9929fee-16d2"]);
    await entries.flush();

    const written = (await (await openSessionLog(SESSION)).all()).at(-1);
    expect(written).toMatchObject({
      type: "run_end",
      media: ["/tmp/shots/screenshot.png"],
      mediaIds: ["f9929fee-16d2"],
    });
  });

  test("a run that produced nothing leaves the field off the marker", async () => {
    // Absent, not empty: every run before this one keeps reading exactly as it did.
    const recorder = new RunRecorder(entries);
    recorder.runEnd("done");
    await entries.flush();

    expect((await (await openSessionLog(SESSION)).all()).at(-1)).not.toHaveProperty("media");
  });

  test("an error marker carries why, so a roster never has to guess the reason", async () => {
    const recorder = new RunRecorder(entries);
    recorder.runEnd("error", undefined, undefined, "quota_exhausted");
    await entries.flush();

    expect((await (await openSessionLog(SESSION)).all()).at(-1)).toMatchObject({
      type: "run_end",
      reason: "error",
      failure: "quota_exhausted",
    });
  });

  test("a run that ended well never claims a failure", async () => {
    // A `done` with a class on it would be a contradiction to read later, whatever a caller passed.
    const recorder = new RunRecorder(entries);
    recorder.runEnd("done", undefined, undefined, "quota_exhausted");
    await entries.flush();

    expect((await (await openSessionLog(SESSION)).all()).at(-1)).not.toHaveProperty("failure");
  });
});

describe("newTurnId", () => {
  test("two ids are never the same", () => {
    expect(new Set(Array.from({ length: 100 }, () => newTurnId())).size).toBe(100);
  });
});

describe("RunRecorder: one model turn", () => {
  test("a user turn keeps the id of the bubble it was streamed beside", async () => {
    const recorder = new RunRecorder(entries);
    const user = recorder.user({ id: "bubble-user", text: "question" });
    await entries.flush();

    expect(user.id).toBe("bubble-user");
    expect((await (await openSessionLog(SESSION)).all())[0]!.id).toBe("bubble-user");
  });

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

  /**
   * Added 2026-09-11: the span used to live only in the app's memory, so a reopened conversation
   * kept the thought and lost how long it took.
   */
  test("how long the turn thought is written on the phase, and survives the log", async () => {
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({ content: "salut", reasoning: "je reflechis", reasoningMs: 4200 });
    await entries.flush();
    expect(phases[0]).toMatchObject({ type: "phase", reasoningMs: 4200 });
    const reopened = await openSessionLog(SESSION);
    const stored = (await reopened.all()).find((entry) => entry.type === "phase");
    expect(stored).toMatchObject({ reasoning: "je reflechis", reasoningMs: 4200 });
  });

  test("each phase of a cut turn keeps its own span", async () => {
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({
      content: "un\n\ndeux",
      segments: [
        { reasoning: "a", reasoningMs: 100, content: "un" },
        { reasoning: "b", reasoningMs: 900, content: "deux" },
      ],
    });
    expect(phases.map((p) => p.reasoningMs)).toEqual([100, 900]);
  });

  test("a turn that thought without reporting a span writes none", async () => {
    const recorder = new RunRecorder(entries);
    const phases = recorder.turn({ content: "salut", reasoning: "je reflechis" });
    expect(phases[0]).toMatchObject({ type: "phase" });
    expect(phases[0]!.reasoningMs).toBeUndefined();
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
    const reread = (await (await openSessionLog(SESSION)).all())[0] as PhaseEntry;
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
    const { entry } = await recorder.tool(call("c1", { durationMs: 12 }));
    expect(entry).toMatchObject({ type: "tool", callId: "c1", name: "bash", args: { command: "ls" }, output: "ok", ok: true, durationMs: 12 });
  });

  test("a tool's images are persisted on the entry, so a rebuilt prompt can show them again", async () => {
    const recorder = new RunRecorder(entries);
    const { entry } = await recorder.tool(
      call("c1", { attachments: [{ type: "image", path: "/tmp/shot.png", mimeType: "image/png" }] }),
    );
    expect(entry.attachments).toEqual([{ type: "image", path: "/tmp/shot.png", mimeType: "image/png" }]);
  });

  test("a tool with no image writes no attachments field", async () => {
    const recorder = new RunRecorder(entries);
    const { entry } = await recorder.tool(call("c1"));
    expect(entry.attachments).toBeUndefined();
  });

  test("a tool belongs to the turn that asked for it", async () => {
    const recorder = new RunRecorder(entries);
    const [phase] = recorder.turn({ content: "je regarde" });
    const { entry } = await recorder.tool(call("c1"));
    expect(entry.runId).toBe(phase!.runId);
  });

  test("half-written arguments are kept raw rather than lost", async () => {
    // A turn cut on `length` stops mid-serialization. The card must show what was attempted.
    const recorder = new RunRecorder(entries);
    const { entry } = await recorder.tool(call("c1", { arguments: '{"path":"x.ts","content":"half of' }));
    expect(entry.args).toEqual({ raw: '{"path":"x.ts","content":"half of' });
  });

  test("a long output goes beside the entry, which names it", async () => {
    const recorder = new RunRecorder(entries);
    const { entry } = await recorder.tool(call("c1", { output: "x".repeat(60_000) }));
    expect(entry.truncated).toBe(true);
    expect(entry.outputPath).toBeDefined();
    expect(await readToolOutput(SESSION, "c1")).toHaveLength(60_000);
  });

  test("the file exists by the time the entry names it", async () => {
    // The one state the card's see-all button cannot recover from is an entry pointing at a file
    // that is not there yet, which is why this await is not optional.
    const recorder = new RunRecorder(entries);
    const { entry } = await recorder.tool(call("c1", { output: "y".repeat(60_000) }));
    expect(await readToolOutput(SESSION, entry.callId)).not.toBeNull();
  });

  test("a failed call is still an entry", async () => {
    const recorder = new RunRecorder(entries);
    const { entry } = await recorder.tool(call("c1", { ok: false, output: "Error: nope" }));
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

    expect(promptOf((await entries.all()), entries.leaf())).toEqual([
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

    const out = promptOf((await entries.all()), entries.leaf());
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

    expect(promptOf((await entries.all()), entries.leaf())).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    // On disk all the same, which is what a reopened thread shows.
    expect((await entries.all()).map((e) => e.type)).toEqual(["user", "command", "failure", "phase"]);
  });
});

describe("RunRecorder: it writes where the log stands", () => {
  test("an attempt the owner branched away from stays reachable, coherent, and is not overwritten", async () => {
    // The recorder holds no cursor: it appends at the log's leaf, so moving the cursor is entirely
    // the commands' business. `/retry` moves to the parent of a user turn and the next run writes
    // there, which is what makes the abandoned attempt a sibling rather than something overwritten.
    const first = new RunRecorder(entries);
    const question = first.user({ text: "question" });
    first.turn({ content: "mauvaise reponse" });
    await first.tool(call("c1"));
    const abandoned = entries.leaf();

    entries.branch(question.id);
    const retry = new RunRecorder(entries);
    retry.turn({ content: "bonne reponse" });
    await entries.flush();

    expect(promptOf((await entries.all()), entries.leaf()).map((m) => m.content)).toEqual(["question", "bonne reponse"]);

    const revisited = promptOf((await entries.all()), abandoned);
    expect(revisited.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(revisited[1]!.content).toBe("mauvaise reponse");
    // Every call it asked for is answered: a branch nobody is on is still a legal exchange, which
    // is why revisiting one costs nothing and why nothing has to be sealed on it.
    const asked = revisited.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
    const answered = revisited.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(asked).toEqual(["c1"]);
    expect(answered).toEqual(asked);
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
    expect((await reread.all()).map((e) => e.type)).toEqual(["user", "phase", "tool"]);
    expect(promptOf((await reread.all()), reread.leaf())).toEqual(promptOf((await entries.all()), entries.leaf()));
  });

  test("a tool entry reread names the same file", async () => {
    const recorder = new RunRecorder(entries);
    await recorder.tool(call("c1", { output: "z".repeat(60_000) }));
    await entries.flush();
    const reread = (await (await openSessionLog(SESSION)).all())[0] as ToolEntry;
    expect(await readToolOutput(SESSION, reread.callId)).toHaveLength(60_000);
  });
});

describe("a phase keeps the id of the bubble it was streamed into", () => {
  // Before this, the channel minted a bubble id and the log minted an entry id, so one piece of
  // prose had two identities and nothing could tell they were the same -- docs/bubble-identity.md.
  const bubbles = (ids: string[]) => ({ take: () => ids.splice(0, ids.length) });

  // A log of its own per test: these tests write ids they chose, and a leaf pointer left behind
  // under a name another test reuses is a stale cursor rather than a finding.
  async function freshLog(name: string): Promise<{ id: string; log: SessionLog }> {
    const id = `${SESSION}-${name}`;
    await rm(sessionDir(id), { recursive: true, force: true });
    await mkdir(sessionDir(id), { recursive: true });
    return { id, log: await openSessionLog(id) };
  }

  test("takes the bubble ids of its own session", async () => {
    const { id, log } = await freshLog("own");
    const recorder = new RunRecorder(log);
    const phases = await withRunContext({ platform: "test" }, async () => {
      setRunBubbles(id, bubbles(["bubble-1", "bubble-2"]));
      return recorder.turn({ content: "deux temps", segments: [{ content: "un" }, { content: "deux" }] });
    });
    await log.flush();
    expect(phases.map((phase) => phase.id)).toEqual(["bubble-1", "bubble-2"]);
  });

  test("ignores a sink belonging to another session, which is a sub-agent's", async () => {
    const { log } = await freshLog("parent");
    const recorder = new RunRecorder(log);
    const phases = await withRunContext({ platform: "test" }, async () => {
      setRunBubbles("subagent/other", bubbles(["child-1"]));
      return recorder.turn({ content: "le parent ecrit" });
    });
    await log.flush();
    expect(phases[0]!.id).not.toBe("child-1");
  });

  test("mints as before when the counts disagree, rather than pairing the wrong two", async () => {
    // A segment can hold thinking that never became prose. Pairing by position through that would
    // give a phase the id of a bubble holding something else, and the client would merge them.
    const { id, log } = await freshLog("mismatch");
    const recorder = new RunRecorder(log);
    const phases = await withRunContext({ platform: "test" }, async () => {
      setRunBubbles(id, bubbles(["bubble-1", "bubble-2", "bubble-3"]));
      return recorder.turn({ content: "deux temps", segments: [{ content: "un" }, { content: "deux" }] });
    });
    await log.flush();
    expect(phases.map((phase) => phase.id)).not.toContain("bubble-1");
    expect(new Set(phases.map((phase) => phase.id)).size).toBe(2);
  });

  test("mints as before when nothing is painting the run, like cron", async () => {
    const { log } = await freshLog("cron");
    const recorder = new RunRecorder(log);
    const phases = await withRunContext({ platform: "cron" }, async () => recorder.turn({ content: "sans fenetre" }));
    await log.flush();
    expect(phases[0]!.id).toBeTruthy();
    expect(promptOf((await log.path()), phases[0]!.id).map((m) => m.content)).toContain("sans fenetre");
  });
});

/**
 * A tool name the model mangled never enters the log as itself -- 2026-11-02.
 *
 * The log is replayed on every request, so one bad name made a conversation permanently
 * unanswerable: Codex refuses a replayed call whose name is not `^[a-zA-Z0-9_-]+$`, and that
 * failure is the whole request, Continue included. Refusing it at the write is the only place that
 * can promise it never happens again -- the replay filter still covers logs written before this.
 */
describe("RunRecorder: a tool call whose name is not an identifier", () => {
  const bad = "docker 2>/dev/null; true</|DSML| parameter>\n</|DSML| invoke>";

  test("is written under a replayable name, with the original kept in the output", async () => {
    const recorder = new RunRecorder(entries);
    await recorder.tool(call("c1", { name: bad, output: `Error: unknown tool "${bad}"`, ok: false }));
    await entries.flush();

    const written = (await entries.all()).filter((e): e is ToolEntry => e.type === "tool");
    expect(written.map((e) => e.name)).toEqual(["unknown_tool"]);
    // Nothing about what happened is lost: the malformed name is still readable, just not replayable.
    expect(written[0]!.output).toContain("malformed");
    expect(written[0]!.output).toContain("docker 2>/dev/null");
  });

  test("a valid name is written exactly as the model wrote it", async () => {
    const recorder = new RunRecorder(entries);
    await recorder.tool(call("c1", { name: "mcp__brave__search" }));
    await entries.flush();
    const written = (await entries.all()).filter((e): e is ToolEntry => e.type === "tool");
    expect(written.map((e) => e.name)).toEqual(["mcp__brave__search"]);
  });

  test("the prompt built from that log carries no unplayable call", async () => {
    const recorder = new RunRecorder(entries);
    recorder.user({ id: "u1", text: "q" });
    await recorder.tool(call("c1", { name: bad, output: `Error: unknown tool`, ok: false }));
    await entries.flush();

    const messages = promptOf((await entries.all()), entries.leaf());
    const calls = messages.flatMap((m) => ("tool_calls" in m ? m.tool_calls ?? [] : []));
    for (const c of calls) {
      expect(c.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
