import { describe, test, expect } from "bun:test";
import { hooks } from "../../src/hooks/index.ts";
import { openSessionLog, type Entry, type Provisioned, type SpawnStateEntry, type ToolEntry } from "../../src/sessions/log.ts";
import { contextEntries, promptOf } from "../../src/sessions/projection.ts";
import { appendSpawnState, cardOf, recordSpawnLifecycle, spawnStates, spawnView } from "../../src/sessions/spawn-state.ts";
import type { SessionSubAgentState } from "../../src/sessions/store.ts";

let counter = 0;
function freshId(): string {
  return `test-spawn-state-${process.pid}-${counter++}`;
}

let seq = 0;
/** Entries as the log would have written them: ids, seqs and a parent chain, without the disk. */
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

const tool = (callId: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "tool", prompt: true, callId, name: "spawn", args: { name: "auditor" },
    output: "started", truncated: false, ok: true, runId: "r1", ...extra,
  }) as Provisioned<Entry>;

const opened = (callId: string, subagentId: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "spawn_state", prompt: false, callId, subagentId, status: "running",
    displayName: "auditor", agentType: "research", mode: "run", action: "spawn", ...extra,
  }) as Provisioned<Entry>;

const settled = (callId: string, subagentId: string, extra: Record<string, unknown>) =>
  ({ type: "spawn_state", prompt: false, callId, subagentId, ...extra }) as Provisioned<Entry>;

describe("spawnStates: a card's state, folded out of the log", () => {
  test("a state written after the tool entry still lands on it", () => {
    // The whole reason this entry type exists. `spawn` hands back the moment the child is launched,
    // so the tool entry is written while it is still working and the ending arrives afterwards --
    // with nowhere to go, before this, because an entry is written once.
    const entries = chain([
      opened("call-1", "subagent/auditor"),
      tool("call-1"),
      settled("call-1", "subagent/auditor", { status: "complete", resultLength: 4096 }),
    ]);

    const state = spawnStates(entries).get("call-1");
    expect(state?.status).toBe("complete");
    expect(state?.resultLength).toBe(4096);
  });

  test("the identity comes from the opening state, the ending from the terminal one", () => {
    const entries = chain([
      opened("call-1", "subagent/auditor", { displayName: "dup-audit", agentType: "research", mode: "run" }),
      tool("call-1"),
      settled("call-1", "subagent/auditor", { status: "complete", resultLength: 12 }),
    ]);

    const state = spawnStates(entries).get("call-1") as SessionSubAgentState;
    // A terminal event knows the child and nothing else, so every name has to survive the fold.
    expect(state.displayName).toBe("dup-audit");
    expect(state.agentType).toBe("research");
    expect(state.mode).toBe("run");
    expect(state.action).toBe("spawn");
    // Started when the card opened, finished when it settled: two different entries.
    expect(state.startedAt).toBe(new Date(entries[0]!.ts).toISOString());
    expect(state.finishedAt).toBe(new Date(entries[2]!.ts).toISOString());
  });

  test("a terminal state is final", () => {
    // A roster sweep at shutdown kills whatever it still holds, including children that had already
    // answered. Letting that through rewrites every finished card in the history as aborted.
    const entries = chain([
      opened("call-1", "subagent/auditor"),
      tool("call-1"),
      settled("call-1", "subagent/auditor", { status: "complete", resultLength: 7 }),
      settled("call-1", "subagent/auditor", { status: "aborted", error: "sub-agent killed" }),
    ]);

    const state = spawnStates(entries).get("call-1");
    expect(state?.status).toBe("complete");
    expect(state?.error).toBeUndefined();
  });

  test("a running state is not final", () => {
    const entries = chain([
      opened("call-1", "subagent/auditor"),
      settled("call-1", "subagent/auditor", { status: "running" }),
      settled("call-1", "subagent/auditor", { status: "error", error: "boom" }),
    ]);

    const state = spawnStates(entries).get("call-1");
    expect(state?.status).toBe("error");
    expect(state?.error).toBe("boom");
  });

  test("a send to a live child gets its own card", () => {
    // Same sub-agent, two calls, two cards. Keyed on the call and not on the child, so the second
    // answer does not overwrite the first one's card.
    const entries = chain([
      opened("call-1", "subagent/switch"),
      tool("call-1"),
      settled("call-1", "subagent/switch", { status: "complete", resultLength: 1 }),
      opened("call-2", "subagent/switch", { action: "send" }),
      tool("call-2", { name: "send" }),
      settled("call-2", "subagent/switch", { status: "error", error: "boom" }),
    ]);

    const states = spawnStates(entries);
    expect(states.get("call-1")?.status).toBe("complete");
    expect(states.get("call-2")?.status).toBe("error");
    expect(states.get("call-2")?.action).toBe("send");
  });

  test("a state imported onto the tool entry is the floor", () => {
    // Sessions from before this entry type kept the lifecycle on the assistant turn's tool call, and
    // the migration copies it inline. It had already settled, so it is read as it stands.
    const inline: SessionSubAgentState = {
      subagentId: "subagent/old",
      displayName: "dup-audit",
      agentType: "research",
      mode: "run",
      action: "spawn",
      status: "complete",
      startedAt: "2026-08-24T15:49:48.654Z",
      resultLength: 14565,
      finishedAt: "2026-08-24T16:01:35.235Z",
    };
    const entries = chain([tool("call-old", { spawn: inline })]);

    expect(spawnStates(entries).get("call-old")).toEqual(inline);
  });

  test("a card nobody reported on has no state at all", () => {
    // Not a running spinner, not an empty object: absent. A plain tool call must stay a plain card.
    expect(spawnStates(chain([tool("call-1")])).has("call-1")).toBe(false);
  });
});

describe("spawn state: never part of a prompt", () => {
  test("the model reads the child's result in the tool output, not the spinner", () => {
    const entries = chain([
      { type: "user", prompt: true, text: "lance un audit" } as Provisioned<Entry>,
      { type: "phase", prompt: true, text: "j'y vais", runId: "r1" } as Provisioned<Entry>,
      opened("call-1", "subagent/auditor"),
      tool("call-1"),
      settled("call-1", "subagent/auditor", { status: "complete", resultLength: 9 }),
    ]);
    const leaf = entries[entries.length - 1]!.id;

    expect(contextEntries(entries, leaf).some((entry) => entry.type === "spawn_state")).toBe(false);
    // The turn still projects whole: the assistant message, its call, and the call's result.
    expect(promptOf(entries, leaf).map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });
});

describe("appendSpawnState: what gets written, and what does not", () => {
  test("a terminal event finds the card the opening state named", async () => {
    // The event that settles a child is nowhere near the call that asked for it, so it carries no
    // call id. The log answers instead.
    const log = await openSessionLog(freshId());
    await appendSpawnState(log, {
      subagentId: "subagent/auditor",
      status: "running",
      toolCallId: "call-1",
      displayName: "auditor",
      agentType: "research",
      mode: "run",
      action: "spawn",
    });
    const written = await appendSpawnState(log, { subagentId: "subagent/auditor", status: "complete", resultLength: 3 });
    await log.flush();

    expect(written?.callId).toBe("call-1");
    expect(cardOf((await log.all()), "subagent/auditor")).toBe("call-1");
    expect(spawnStates((await log.all())).get("call-1")?.status).toBe("complete");
  });

  test("a lifecycle with no card behind it is not written", async () => {
    // A child started from the roster rather than by a tool call annotates nothing, and a line no
    // reader ever asks for is a line that should not be there.
    const log = await openSessionLog(freshId());
    const written = await appendSpawnState(log, { subagentId: "subagent/orphan", status: "complete", resultLength: 3 });
    await log.flush();

    expect(written).toBeNull();
    expect((await log.all())).toHaveLength(0);
  });

  test("nothing is appended past a settled card", async () => {
    const log = await openSessionLog(freshId());
    await appendSpawnState(log, { subagentId: "subagent/auditor", status: "running", toolCallId: "call-1" });
    await appendSpawnState(log, { subagentId: "subagent/auditor", status: "complete", resultLength: 3 });
    const late = await appendSpawnState(log, { subagentId: "subagent/auditor", status: "aborted", error: "sub-agent killed" });
    await log.flush();

    expect(late).toBeNull();
    expect((await log.all())).toHaveLength(2);
  });

  test("a state survives a reopen, on the card it named", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    await appendSpawnState(log, {
      subagentId: "subagent/auditor",
      status: "running",
      toolCallId: "call-1",
      displayName: "auditor",
      agentType: "research",
      mode: "run",
      action: "spawn",
    });
    log.append<ToolEntry>({
      type: "tool", prompt: true, callId: "call-1", name: "spawn", args: {},
      output: "started", truncated: false, ok: true, runId: "r1",
    });
    await appendSpawnState(log, { subagentId: "subagent/auditor", status: "complete", resultLength: 42 });
    await log.flush();

    // The point of the whole exercise: a restart replays the ending instead of a spinner.
    const reopened = await openSessionLog(id);
    const state = spawnStates((await reopened.all())).get("call-1");
    expect(state?.status).toBe("complete");
    expect(state?.resultLength).toBe(42);
    expect(state?.displayName).toBe("auditor");
  });
});

describe("recordSpawnLifecycle: the bus writes into the parent's log", () => {
  test("a child spawned by a tool call has its ending on that card", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const recorder = recordSpawnLifecycle(async (sessionId) => {
      expect(sessionId).toBe(id);
      return log;
    });
    try {
      hooks.emit("subagent:spawn", {
        id: "subagent/auditor",
        displayName: "dup-audit",
        type: "research",
        mode: "run",
        parentSessionId: id,
        toolCallId: "call-1",
        action: "spawn",
      });
      hooks.emit("subagent:complete", { id: "subagent/auditor", resultLength: 128, parentSessionId: id });
      await recorder.settled();
      await log.flush();

      const state = spawnStates((await log.all())).get("call-1");
      expect(state?.status).toBe("complete");
      expect(state?.resultLength).toBe(128);
      expect(state?.displayName).toBe("dup-audit");
    } finally {
      recorder.stop();
    }
  });

  test("a kill records the wording the live card shows", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const recorder = recordSpawnLifecycle(async () => log);
    try {
      hooks.emit("subagent:spawn", {
        id: "subagent/auditor",
        displayName: "auditor",
        type: "research",
        mode: "run",
        parentSessionId: id,
        toolCallId: "call-1",
        action: "spawn",
      });
      hooks.emit("subagent:killed", { id: "subagent/auditor", parentSessionId: id });
      await recorder.settled();
      await log.flush();

      const state = spawnStates((await log.all())).get("call-1");
      expect(state?.status).toBe("aborted");
      expect(state?.error).toBe("sub-agent killed");
    } finally {
      recorder.stop();
    }
  });

  test("the opening state cannot land after the ending it precedes", async () => {
    // Both events arrive in the same tick and `logOf` is asynchronous, so without a chain per
    // conversation the ending can be written first -- and a card whose opening state comes last is
    // a card stuck on the spinner for good.
    const id = freshId();
    const log = await openSessionLog(id);
    let calls = 0;
    const recorder = recordSpawnLifecycle(async () => {
      // The first resolution is deliberately the slower one: the order these two events reach the
      // log must not depend on how long it takes to hand one out.
      const delay = calls++ === 0 ? 3 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return log;
    });
    try {
      hooks.emit("subagent:spawn", {
        id: "subagent/auditor",
        displayName: "auditor",
        type: "research",
        mode: "run",
        parentSessionId: id,
        toolCallId: "call-1",
        action: "spawn",
      });
      hooks.emit("subagent:complete", { id: "subagent/auditor", resultLength: 5, parentSessionId: id });
      await recorder.settled();
      await log.flush();

      expect(((await log.all()) as SpawnStateEntry[]).map((entry) => entry.status)).toEqual(["running", "complete"]);
      expect(spawnStates((await log.all())).get("call-1")?.status).toBe("complete");
    } finally {
      recorder.stop();
    }
  });

  test("a lifecycle with no parent conversation is dropped, not thrown", async () => {
    let asked = false;
    const recorder = recordSpawnLifecycle(async () => {
      asked = true;
      throw new Error("should not be reached");
    });
    try {
      hooks.emit("subagent:complete", { id: "subagent/auditor", resultLength: 1, parentSessionId: "" });
      await recorder.settled();
      expect(asked).toBe(false);
    } finally {
      recorder.stop();
    }
  });
});

describe("spawnView: the fold, and which cards the log already holds", () => {
  test("the opening state carries the task, and the fold keeps it", () => {
    // The tool entry carries the task too, but it lands only when the whole batch settles. A card
    // drawn from the state alone -- a reload while a sibling still runs -- would show no task at
    // all without this (2026-09-21).
    const entries = chain([
      opened("call-1", "subagent/auditor", { task: "balaye les agregateurs" }),
      settled("call-1", "subagent/auditor", { status: "error", error: "HTTP 400" }),
    ]);

    const state = spawnStates(entries).get("call-1");
    expect(state?.task).toBe("balaye les agregateurs");
    expect(state?.status).toBe("error");
  });

  test("a call id the log holds a tool entry for is carded; one it does not is not", () => {
    // What tells a state that draws its own card from one whose card is drawn at the tool entry.
    const entries = chain([
      opened("call-1", "subagent/auditor"),
      tool("call-1"),
      opened("call-2", "subagent/auditor"),
    ]);

    const view = spawnView(entries, () => true);
    expect(view.carded.has("call-1")).toBe(true);
    expect(view.carded.has("call-2")).toBe(false);
    expect(view.states.get("call-2")?.status).toBe("running");
  });

  // 2026-10-04: the server was killed while a child worked. Its card read `running` from the log
  // for good, and the parent's thread showed it spinning while nothing ran it.
  test("a running card whose child nothing runs any more reads as interrupted, and only that one", () => {
    const entries = chain([
      opened("call-1", "subagent/auditor"),
      opened("call-2", "subagent/writer"),
      opened("call-3", "subagent/done"),
      settled("call-3", "subagent/done", { status: "complete", resultLength: 3 }),
    ]);
    const view = spawnView(entries, (id) => id === "subagent/writer");
    expect(view.states.get("call-1")?.status).toBe("interrupted");
    expect(view.states.get("call-2")?.status).toBe("running");
    expect(view.states.get("call-3")?.status).toBe("complete");
    // A reading, never a write: the fold itself still says what the log says.
    expect(spawnStates(entries).get("call-1")?.status).toBe("running");
  });

  test("the task survives the terminal state, which never knew it", () => {
    const entries = chain([
      opened("call-1", "subagent/auditor", { task: "veille CMA CGM" }),
      settled("call-1", "subagent/auditor", { status: "complete", resultLength: 12 }),
    ]);
    expect(spawnStates(entries).get("call-1")?.task).toBe("veille CMA CGM");
  });
});
