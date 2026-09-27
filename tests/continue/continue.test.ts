/**
 * Continue: a stopped or failed run picks up where it was, with no new turn -- docs/continue.md.
 *
 * The shapes below are the ones the logs of this install actually hold (2026-09-28): a run that
 * failed after a tool result (37), stopped mid-answer (18), and, most of all, stopped while its
 * sub-agents worked (295), whose calls the prompt no longer showed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { Entry, SessionLog, ToolEntry } from "../../src/sessions/log.ts";
import {
  continuable,
  CUT_OFF_NUDGE,
  endsOnOwnText,
  interruptedSubagents,
  lastAnswer,
  orphanCalls,
} from "../../src/sessions/resume.ts";
import type { Tool } from "../../src/tools/types.ts";

const SESSION_ID = "test-continue";
const config: MyClawConfig = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {}, memory: { enabled: false },
};

const session = (): LegacySessionData => ({ id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] });
const message = (resume: boolean): UnifiedMessage => ({
  id: resume ? "continue-1" : "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm",
  text: "compte les fichiers", attachments: [], isForwarded: false, raw: {}, ...(resume ? { resume: true } : {}),
});
const answer = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
const tool = (name: string, run: (args: Record<string, unknown>) => Promise<string>): Tool => ({
  name, description: name, parameters: {}, execute: async (args) => ({ success: true, output: await run(args) }),
});

let log: SessionLog;
let cleanup: () => void;
beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, session());
  ({ log, cleanup } = await setupSessionLog(SESSION_ID));
});
afterEach(() => cleanup());

/** A run as the log keeps it: the question, the run marker, then what the run got through. */
function stoppedRun(after: (turnId: string) => void, reason: "aborted" | "error" | null = "aborted"): void {
  log.append({ type: "user", prompt: true, text: "compte les fichiers" });
  log.append({ type: "run_start", prompt: false });
  const turnId = "turn-1";
  after(turnId);
  if (reason) log.append({ type: "run_end", prompt: false, reason });
}

const toolEntry = (turnId: string, callId: string, name: string, output: string, extra: Partial<ToolEntry> = {}) =>
  log.append<ToolEntry>({ type: "tool", prompt: true, callId, name, args: {}, output, truncated: false, ok: true, runId: turnId, ...extra });

describe("reading what a conversation stopped on", () => {
  test("a stopped, a failed and a lost run can be continued; a finished one cannot", () => {
    stoppedRun((t) => log.append({ type: "phase", prompt: true, text: "", runId: t }), "aborted");
    expect(continuable(log.entries(), log.leaf())).toMatchObject({ ok: true, lastUserText: "compte les fichiers", ended: "aborted" });
    log.append({ type: "run_start", prompt: false });
    expect(continuable(log.entries(), log.leaf())).toMatchObject({ ok: true, ended: "lost" });
    log.append({ type: "phase", prompt: true, text: "57 fichiers.", runId: "turn-2" });
    log.append({ type: "run_end", prompt: false, reason: "done" });
    expect(continuable(log.entries(), log.leaf()).ok).toBe(false);
    expect(lastAnswer(log.entries(), log.leaf())).toBe("57 fichiers.");
  });

  test("a sub-agent call the server lost is found from its card, in the turn that made it", () => {
    stoppedRun((t) => {
      log.append({ type: "phase", prompt: true, text: "", runId: t });
      toolEntry(t, "c-bash", "bash", "ok");
      log.append({ type: "spawn_state", prompt: false, callId: "c-spawn", subagentId: "subagent/wttj-4f2a", status: "running", action: "spawn", displayName: "wttj", agentType: "research", mode: "run", task: "offres WTTJ" });
    }, null);
    expect(orphanCalls(log.entries(), log.leaf())).toEqual([{
      turnId: "turn-1", callId: "c-spawn", subagentId: "subagent/wttj-4f2a", name: "spawn",
      args: { name: "wttj", type: "research", mode: "run", task: "offres WTTJ" },
    }]);
  });

  test("once the model has moved on, a lost call is left where it is", () => {
    stoppedRun((t) => {
      log.append({ type: "phase", prompt: true, text: "", runId: t });
      log.append({ type: "spawn_state", prompt: false, callId: "c-spawn", subagentId: "subagent/x", status: "running", action: "spawn" });
      log.append({ type: "phase", prompt: true, text: "later", runId: "turn-2" });
    }, null);
    expect(orphanCalls(log.entries(), log.leaf())).toEqual([]);
  });

  test("where the prompt ends decides whether it needs to be told it was cut off", () => {
    stoppedRun((t) => log.append({ type: "phase", prompt: true, text: "Voici 5 conseils : 1.", runId: t }));
    expect(endsOnOwnText(log.entries(), log.leaf())).toBe(true);
  });
});

describe("a Stop keeps the whole batch", () => {
  test("the sibling that finished is kept, the call that was cut says so and names its sub-agent", async () => {
    const registry = new ToolRegistry();
    // Stopped once the sibling is really done: a call that returns after the Stop is dropped on
    // purpose (a stop is a stop), so the moment matters.
    let bashDone!: () => void;
    const started = new Promise<void>((r) => { bashDone = r; });
    const onEnd = ({ toolName }: { toolName: string }): void => { if (toolName === "bash") bashDone(); };
    hooks.on("tool:execute:end", onEnd);
    registry.register(tool("bash", async () => "57"));
    registry.register({
      name: "spawn", description: "spawn", parameters: {},
      async execute(args) {
        log.append({ type: "spawn_state", prompt: false, callId: String(args["__toolCallId"]), subagentId: "subagent/wttj-4f2a", status: "running", action: "spawn" });
        const signal = args["__signal"] as AbortSignal;
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new AbortedError())));
        return { success: true, output: "never" };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const mock = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [
      { id: "c-bash", function: { name: "bash", arguments: "{}" } },
      { id: "c-spawn", function: { name: "spawn", arguments: "{\"task\":\"offres\"}" } },
    ] } }] }), { status: 200 }) as never);
    const controller = new AbortController();
    try {
      const run = bridge.handleMessage(message(false), session(), controller.signal);
      await started;
      controller.abort();
      await expect(run).rejects.toThrow();
      await log.flush();
      const tools = log.entries().filter((e): e is ToolEntry => e.type === "tool");
      // Both used to be thrown away with the batch.
      expect(tools.map((t) => [t.callId, t.ok, t.interrupted ?? false])).toEqual([["c-bash", true, false], ["c-spawn", false, true]]);
      expect(tools[1]!.output).toContain("subagent/wttj-4f2a");
      expect(tools[1]!.output).toContain("with no message resumes it");
    } finally {
      hooks.off("tool:execute:end", onEnd);
      mock.restore();
    }
  });
});

describe("Continue", () => {
  function capture(responses: Response[]): { bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>; restore: () => void } {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const mock = mockFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return (responses.shift() ?? answer("?")) as never;
    });
    return { bodies, restore: () => mock.restore() };
  }

  test("after a failure on a tool result: no new turn, the prompt ends on the result, the run completes", async () => {
    stoppedRun((t) => {
      log.append({ type: "phase", prompt: true, text: "", runId: t });
      toolEntry(t, "c1", "bash", "57");
    }, "error");
    const users = log.entries().filter((e) => e.type === "user").length;
    const { bodies, restore } = capture([answer("Il y a 57 fichiers.")]);
    try {
      const text = await new AgentBridge(config, new ToolRegistry(), new SkillRegistry()).handleMessage(message(true), session());
      expect(text).toBe("Il y a 57 fichiers.");
      const last = bodies[0]!.messages.at(-1)!;
      expect(last.role).toBe("tool");
      await log.flush();
      expect(log.entries().filter((e) => e.type === "user").length).toBe(users);
      const ends = log.entries().filter((e): e is Entry & { reason: string } => e.type === "run_end").map((e) => e.reason);
      expect(ends).toEqual(["error", "done"]);
    } finally {
      restore();
    }
  });

  test("after a Stop mid-answer: the run is told where it was cut, in the prompt only", async () => {
    stoppedRun((t) => log.append({ type: "phase", prompt: true, text: "Voici 5 conseils : 1. Révise", runId: t }));
    const { bodies, restore } = capture([answer(" les fondamentaux.")]);
    try {
      await new AgentBridge(config, new ToolRegistry(), new SkillRegistry()).handleMessage(message(true), session());
      expect(bodies[0]!.messages.at(-1)).toEqual({ role: "user", content: CUT_OFF_NUDGE });
      await log.flush();
      expect(JSON.stringify(log.entries())).not.toContain("[Continue]");
    } finally {
      restore();
    }
  });

  test("interrupted sub-agents are resumed first, by the run itself, and their answers are the model's to read", async () => {
    stoppedRun((t) => {
      log.append({ type: "phase", prompt: true, text: "", runId: t });
      log.append({ type: "spawn_state", prompt: false, callId: "c-spawn", subagentId: "subagent/wttj-4f2a", status: "running", action: "spawn" });
      toolEntry(t, "c-spawn", "spawn", "Interrupted: ...", { ok: false, interrupted: true });
    });
    const sent: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register(tool("send", async (args) => {
      sent.push({ id: args["id"], message: args["message"] });
      return "14 offres lues, 5 retenues.";
    }));
    const { bodies, restore } = capture([answer("Résumé : 5 offres.")]);
    try {
      const text = await new AgentBridge(config, registry, new SkillRegistry()).handleMessage(message(true), session());
      expect(text).toBe("Résumé : 5 offres.");
      // The real id, no message: a resume. Not left to the model, which copied ids wrong.
      expect(sent).toEqual([{ id: "subagent/wttj-4f2a", message: undefined }]);
      const prompt = JSON.stringify(bodies[0]!.messages);
      expect(prompt).toContain("14 offres lues, 5 retenues.");
      expect(bodies).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("after a crash, a sub-agent the server lost gets its result and is resumed", async () => {
    stoppedRun((t) => {
      log.append({ type: "phase", prompt: true, text: "", runId: t });
      log.append({ type: "spawn_state", prompt: false, callId: "c-lost", subagentId: "subagent/lost-1", status: "running", action: "spawn", task: "t" });
    }, null);
    const sent: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("send", async (args) => {
      sent.push(String(args["id"]));
      return "done";
    }));
    const { bodies, restore } = capture([answer("ok")]);
    try {
      await new AgentBridge(config, registry, new SkillRegistry()).handleMessage(message(true), session());
      expect(sent).toEqual(["subagent/lost-1"]);
      expect(interruptedSubagents(log.entries(), log.leaf())).toEqual([]);
      const prompt = bodies[0]!.messages;
      const spawnCall = prompt.find((m) => m.role === "assistant" && JSON.stringify(m).includes("c-lost"));
      expect(spawnCall).toBeDefined();
    } finally {
      restore();
    }
  });

  test("a run that finished has nothing to continue, and nothing is called", async () => {
    stoppedRun((t) => log.append({ type: "phase", prompt: true, text: "fini", runId: t }), null);
    log.append({ type: "run_end", prompt: false, reason: "done" });
    const { bodies, restore } = capture([]);
    try {
      const text = await new AgentBridge(config, new ToolRegistry(), new SkillRegistry()).handleMessage(message(true), session());
      expect(text).toContain("Nothing to continue");
      expect(bodies).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
