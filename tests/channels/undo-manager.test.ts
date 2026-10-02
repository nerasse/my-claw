import { describe, test, expect, afterEach } from "bun:test";
import { UndoManager } from "../../src/channels/my-claw-app/undo.ts";

describe("undo manager", () => {
  let manager: UndoManager;

  afterEach(() => {
    manager?.clear();
  });

  test("prompt resolves with the chosen mode", async () => {
    manager = new UndoManager();
    let broadcasted = false;
    manager.setHandler((undo) => {
      broadcasted = true;
      expect(undo.threadId).toBe("t1");
      manager.choose(undo.id, "hard");
    });
    const outcome = await manager.prompt({
      sessionId: "s1",
      owner: "o1",
      threadId: "t1",
      diff: [{ root: "/ws", files: 1, additions: 2, deletions: 1 }],
      turnPreview: "test",
    });
    expect(broadcasted).toBe(true);
    expect(outcome).toEqual({ kind: "chosen", mode: "hard" });
  });

  test("cancel resolves as canceled", async () => {
    manager = new UndoManager();
    manager.setHandler((undo) => {
      manager.cancel(undo.id);
    });
    const outcome = await manager.prompt({
      sessionId: "s1",
      owner: "o1",
      threadId: "t1",
      diff: [],
      turnPreview: "test",
    });
    expect(outcome).toEqual({ kind: "canceled" });
  });

  test("choose on an unknown id is a no-op, no throw", () => {
    manager = new UndoManager();
    expect(manager.choose("nope", "soft")).toBeUndefined();
    expect(manager.cancel("nope")).toBeUndefined();
  });

  test("list exposes the pending prompts", () => {
    manager = new UndoManager();
    const outcomePromise = manager.prompt({
      sessionId: "s1",
      owner: "o1",
      threadId: "t1",
      diff: [],
      turnPreview: "test",
    });
    expect(manager.list()).toHaveLength(1);
    manager.cancel(manager.list()[0]!.id);
    expect(manager.list()).toHaveLength(0);
    void outcomePromise;
  });
});
