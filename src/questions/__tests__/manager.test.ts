import { describe, expect, it } from "bun:test";
import { QuestionManager, type PendingQuestion } from "../manager.ts";

function make(questions?: Parameters<QuestionManager["ask"]>[0]["questions"], sessionId = "s1") {
  const manager = new QuestionManager((q) => asked.push(q));
  const asked: PendingQuestion[] = [];
  const signal = new AbortController();
  const ask = manager.ask({
    sessionId,
    owner: "owner-1",
    threadId: "projet",
    questions: questions ?? [{ header: "Langue", question: "Francais ou anglais ?", options: [{ label: "fr" }, { label: "en" }] }],
    signal: signal.signal,
  });
  return { manager, asked, ask, signal };
}

describe("QuestionManager", () => {
  it("broadcasts then resolves on reply", async () => {
    const { manager, asked, ask } = make();
    expect(asked.length).toBe(1);
    expect(asked[0]!.questions[0]!.header).toBe("Langue");
    expect(manager.reply(asked[0]!.id, [["fr"]])).toBe(asked[0]!);
    const outcome = await ask;
    expect(outcome).toEqual({ kind: "answered", answers: [["fr"]] });
    expect(manager.list().length).toBe(0);
  });

  it("resolves as canceled on cancel()", async () => {
    const { manager, asked, ask } = make();
    expect(manager.cancel(asked[0]!.id)).toBe(asked[0]!);
    expect(await ask).toEqual({ kind: "canceled" });
  });

  it("abort drops the pending entry but a late reply is ignored", async () => {
    const { manager, asked, ask, signal } = make();
    signal.abort();
    expect(await ask).toEqual({ kind: "canceled" });
    expect(manager.list().length).toBe(0);
    expect(manager.reply(asked[0]!.id, [["fr"]])).toBeUndefined();
  });

  it("aborts before the broadcast when the signal is already aborted", async () => {
    const manager = new QuestionManager(() => unanswered.push(1));
    const unanswered: number[] = [];
    const signal = new AbortController();
    signal.abort();
    const ask = manager.ask({
      sessionId: "s1",
      owner: "o",
      threadId: "t",
      questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
      signal: signal.signal,
    });
    expect(unanswered.length).toBe(0);
    expect(await ask).toEqual({ kind: "canceled" });
  });

  it("ofSession is scoped to the session id", async () => {
    const a = make(undefined, "s-a");
    expect(a.manager.ofSession("s-a")!.id).toBe(a.asked[0]!.id);
    expect(a.manager.ofSession("s-b")).toBeUndefined();
  });

  it("cancelBySession cancels every question of the session, and only that session", async () => {
    const a = make(undefined, "s-a");
    const manager = new QuestionManager(() => {});
    const second = manager.ask({
      sessionId: "s-a",
      owner: "o",
      threadId: "t",
      questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
    });
    expect(manager.cancelBySession("s-a")).toBe(true);
    expect(await second).toEqual({ kind: "canceled" });
    expect(a.manager.list().length).toBe(1);
  });

  it("list() exposes every pending question of the manager", () => {
    const a = make(undefined, "s-a");
    const b = make(undefined, "s-b");
    expect(a.manager.list().length).toBe(1);
    expect(b.manager.list().length).toBe(1);
  });

  it("hasSurface is false without a handler", () => {
    const manager = new QuestionManager(undefined);
    expect(manager.hasSurface()).toBe(false);
  });
});
