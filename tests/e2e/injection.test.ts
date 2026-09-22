import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { setSessionLogResolver, resetSessionLogResolver } from "../../src/sessions/log-access.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { UserEntry } from "../../src/sessions/log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const config: MyClawConfig = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {}, memory: { enabled: false },
};
const SESSION_ID = "my-claw-app/dm/u1";

function message(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}
function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}
// SSE response for streaming calls (router.route with onToken -> chatCompletionStream).
function sse(parts: object[]): never {
  const text = parts.map((p) => `data: ${JSON.stringify(p)}\n`).join("") + "data: [DONE]\n";
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
}
function noopTool() {
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  return reg;
}
function makeRouter(reg: ToolRegistry): MessageRouter {
  return makeRouterWith(new SessionManager(), reg);
}
function makeRouterWith(manager: SessionManager, reg: ToolRegistry): MessageRouter {
  return new MessageRouter(manager, new AgentBridge(config, reg, new SkillRegistry()), config);
}
function userContents(body: { messages: Array<{ role: string; content: unknown }> }): unknown[] {
  return body.messages.filter((m) => m.role === "user").map((m) => m.content);
}

describe("E2E mid-run injection", () => {
  test("an injected message is addressed in the same run and gets its own threaded bubble", async () => {
    runRegistry.clear();
    const router = makeRouter(noopTool());

    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      call++;
      if (call === 1) {
        // a user message arrives while the first run is mid tool round
        runRegistry.enqueueInjection(SESSION_ID, message("m2", "and what about X?"));
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "noop", arguments: "{}" } }] } }] }]);
      }
      return sse([{ choices: [{ delta: { content: "final answer" } }] }]);
    });

    // mirror index.ts onMessage: a mutable `active` bubble switched by onTurnSwitch
    const bubbles: string[] = [];
    let active = "m1";
    try {
      const r1 = await router.route(message("m1", "tell me about X"), {
        onToken: async () => {},
        onTurnSwitch: async (im) => { bubbles.push(active); active = im.id; },
      });
      bubbles.push(active);

      expect(call).toBe(2); // the run continued to address the injection
      expect(r1?.text).toBe("final answer");
      expect(bubbles).toEqual(["m1", "m2"]); // output switched to a fresh bubble for m2
      expect(userContents(bodies[1]!).some((c) => typeof c === "string" && c.includes("and what about X?"))).toBe(true);
    } finally {
      mock.restore(); runRegistry.clear();
    }
  });

  test("non-streaming: an injected message is still answered in the same run", async () => {
    runRegistry.clear();
    const router = makeRouter(noopTool());

    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      call++;
      if (call === 1) {
        runRegistry.enqueueInjection(SESSION_ID, message("m2", "follow-up question"));
        return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "noop", arguments: "{}" } }] });
      }
      return llm({ content: "done" });
    });

    try {
      const r1 = await router.route(message("m1", "first")); // non-streaming (no onToken / onTurnSwitch)
      expect(call).toBe(2);
      expect(r1?.text).toBe("done");
      expect(userContents(bodies[1]!).some((c) => typeof c === "string" && c.includes("follow-up question"))).toBe(true);
    } finally {
      mock.restore(); runRegistry.clear();
    }
  });

  test("a normal message with no active run is unaffected (single run)", async () => {
    runRegistry.clear();
    const router = makeRouter(new ToolRegistry());
    let call = 0;
    const mock = mockFetch(async () => { call++; return llm({ content: "hello" }); });
    try {
      const r = await router.route(message("m1", "hi"));
      expect(call).toBe(1);
      expect(r?.text).toBe("hello");
    } finally {
      mock.restore(); runRegistry.clear();
    }
  });
  /**
   * The order the owner reads is the order the model read: at the drain.
   *
   * The app parks a send at the bottom of the thread until its ack, and every row the run emits
   * meanwhile lands above it; the model reads it at the next iteration boundary. The log is the
   * replay of that screen, so the entry takes the same place. It used to be written at the return
   * of the turn in flight (9aacf30), above that turn's rows, and a reopened thread showed the
   * owner's voice note above a phase and two bash calls that had started before it was sent --
   * the opposite of what the same thread had shown live (thread fbe927c6, 2026-09-22 23:04).
   */
  test("a message that arrives during a final answer is written after it, before the turn it opens", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    const router = makeRouterWith(manager, noopTool());

    let call = 0;
    const mock = mockFetch(async () => {
      call++;
      if (call === 1) {
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "noop", arguments: "{}" } }] } }] }]);
      }
      if (call === 2) {
        // The arrival lands while this turn is in flight: after the run's last drain point.
        runRegistry.enqueueInjection(SESSION_ID, message("m-late", "steer"));
        return sse([{ choices: [{ delta: { content: "reacting" } }] }]);
      }
      return sse([{ choices: [{ delta: { content: "done" } }] }]);
    });

    try {
      await router.route(message("m1", "start"), { onToken: async () => {} });
      const entries = (await manager.logOf(SESSION_ID)).entries();
      const userAt = entries.findIndex((entry) => entry.id === "m-late");
      const reactionAt = entries.findIndex((entry) => entry.type === "phase" && entry.text === "reacting");
      const doneAt = entries.findIndex((entry) => entry.type === "phase" && entry.text === "done");
      expect(call).toBe(3);
      expect(reactionAt).toBeGreaterThan(0);
      expect(userAt).toBeGreaterThan(reactionAt);
      expect(userAt).toBeLessThan(doneAt);
    } finally {
      mock.restore(); runRegistry.clear(); resetSessionLogResolver();
    }
  });

  /**
   * The case measured on 2026-09-22: the turn in flight calls tools. Its phase and its tool rows
   * are all above the message, which is read at the boundary once their results are in.
   */
  test("a message that arrives during a turn that calls tools is written after those tools", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    const router = makeRouterWith(manager, noopTool());

    let call = 0;
    const mock = mockFetch(async () => {
      call++;
      if (call === 1) {
        runRegistry.enqueueInjection(SESSION_ID, message("m-mid", "et d'ailleurs"));
        return sse([
          { choices: [{ delta: { content: "Compris" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "noop", arguments: "{}" } }] } }] },
        ]);
      }
      return sse([{ choices: [{ delta: { content: "next" } }] }]);
    });

    try {
      await router.route(message("m1", "start"), { onToken: async () => {} });
      const entries = (await manager.logOf(SESSION_ID)).entries();
      const phaseAt = entries.findIndex((entry) => entry.type === "phase" && entry.text === "Compris");
      const toolAt = entries.findIndex((entry) => entry.type === "tool");
      const userAt = entries.findIndex((entry) => entry.id === "m-mid");
      const nextAt = entries.findIndex((entry) => entry.type === "phase" && entry.text === "next");
      expect(phaseAt).toBeGreaterThan(0);
      expect(toolAt).toBeGreaterThan(phaseAt);
      expect(userAt).toBeGreaterThan(toolAt);
      expect(nextAt).toBeGreaterThan(userAt);
    } finally {
      mock.restore(); runRegistry.clear(); resetSessionLogResolver();
    }
  });

  /**
   * The voice note sent mid-run kept its waveform and lost its words on reload: the trigger turn
   * wrote `transcripts`, the injected one did not (thread fbe927c6, 2026-09-22, seq 30569).
   */
  test("an injected voice note keeps its transcript on the log", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    const bridge = new AgentBridge(config, noopTool(), new SkillRegistry());
    const preprocessor = (bridge as unknown as { preprocessor: { transcriptsOf: (id: string) => Array<{ path: string; text: string }> } }).preprocessor;
    const original = preprocessor.transcriptsOf.bind(preprocessor);
    preprocessor.transcriptsOf = (id) => (id === "m-voice" ? [{ path: "/files/voice.m4a", text: "vérifie les headers" }] : original(id));
    const router = new MessageRouter(manager, bridge, config);

    let call = 0;
    const mock = mockFetch(async () => {
      call++;
      if (call === 1) {
        runRegistry.enqueueInjection(SESSION_ID, message("m-voice", "[Audio]: vérifie les headers"));
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "noop", arguments: "{}" } }] } }] }]);
      }
      return sse([{ choices: [{ delta: { content: "ok" } }] }]);
    });

    try {
      await router.route(message("m1", "start"), { onToken: async () => {} });
      const voice = (await manager.logOf(SESSION_ID)).entries().find((entry): entry is UserEntry => entry.id === "m-voice");
      expect(voice?.transcripts).toEqual({ "/files/voice.m4a": "vérifie les headers" });
    } finally {
      mock.restore(); runRegistry.clear(); resetSessionLogResolver();
    }
  });
  /**
   * A bubble is written once. A run that force-closes can leave an injected entry on the log for
   * the run its message is rerouted to -- and `Log.append` throws on an id it already holds rather
   * than writing a second bubble. The same guard covers a channel replaying a message it has
   * already sent.
   */
  test("a message whose bubble is already on the log is not written a second time", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    const log = await manager.logOf(SESSION_ID);
    log.append({ type: "user", prompt: true, text: "already here" }, "m-once");
    const router = makeRouterWith(manager, noopTool());

    const mock = mockFetch(async () => sse([{ choices: [{ delta: { content: "ok" } }] }]));
    try {
      await router.route(message("m-once", "already here"), { onToken: async () => {} });
      const bubbles = log.entries().filter((entry): entry is UserEntry => entry.type === "user" && entry.id === "m-once");
      expect(bubbles.length).toBe(1);
      expect(bubbles[0]!.text).toBe("already here");
    } finally {
      mock.restore(); runRegistry.clear(); resetSessionLogResolver();
    }
  });
/**
 * The owner, 2026-09-21: "si je renvoie un autre vocal alors que le compact n'est pas fini, ça
 * s'additionne à la queue et ça s'envoie en une fois [...] tant qu'il y a des items en queue on va
 * pas envoyer plusieurs fois à chacun son tour".
 *
 * Measured on his own threads the same evening -- thread 3fad6e60, a /compact at 19:27:28, two
 * voice notes at 19:28:16 and 19:28:37: the first started a run when the compaction released at
 * 19:31:52, the second waited for that whole run and took its turn at 19:48:47, twenty minutes
 * later. Two runs, two calls, two answers.
 */
test("two messages released by the same compaction ride one call, not two runs", async () => {
  runRegistry.clear();
  const router = makeRouter(noopTool());
  const held = runRegistry.beginCompaction(SESSION_ID);
  if (!held) throw new Error("the compaction hold was refused");

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let runs = 0;
  const onRunStart = (): void => { runs++; };
  hooks.on("message:route:start", onRunStart);
  const parked = [waiter(), waiter()];

  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return sse([{ choices: [{ delta: { content: "addressed" } }] }]);
  });

  try {
    const first = router.route(message("m1", "the first request"), { onToken: async () => {} });
    const second = router.route(message("m2", "and the second one"), { onToken: async () => {} });
    // Both are waiting on the compaction -- the event, not a sleep.
    await Promise.all(parked.map((p) => p.wait));
    expect(bodies).toHaveLength(0);

    held.release();
    await Promise.all([first, second]);

    expect(runs).toBe(1);
    // One call, and it carries both: the second message was in the mailbox before this run's first
    // turn, which only works because `startRoot` keeps a mailbox the session already claimed.
    expect(bodies).toHaveLength(1);
    const turn = userContents(bodies[0]!);
    expect(turn.some((c) => typeof c === "string" && c.includes("the first request"))).toBe(true);
    expect(turn.some((c) => typeof c === "string" && c.includes("and the second one"))).toBe(true);
  } finally {
    hooks.off("message:route:start", onRunStart);
    for (const p of parked) p.off();
    mock.restore(); runRegistry.clear();
  }
});

/** A promise that resolves when the router parks a message on a compaction, and its listener. */
function waiter(): { wait: Promise<void>; off: () => void } {
  let resolve!: () => void;
  const wait = new Promise<void>((r) => { resolve = r; });
  const handler = (): void => resolve();
  hooks.on("message:queued", handler);
  return { wait, off: () => hooks.off("message:queued", handler) };
}
});
