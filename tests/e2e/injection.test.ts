import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { setSessionLogResolver, resetSessionLogResolver } from "../../src/sessions/log-access.ts";
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
   * The order the owner reads. A message that jumps a pending question cancels it, and the run's
   * reaction to that cancel is the very next turn -- so an entry written at the iteration boundary
   * lands underneath the rows the message caused, and the voice bubble reads as if it came after
   * the answer. Measured in thread 4d5775e7 on 2026-09-21: the question cancelled at 06:31:35, the
   * bubble written at 06:31:52, behind a phase and a bash call of the turn it had caused.
   */
  test("a message that arrives during a turn gets its entry above that turn's rows", async () => {
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
        // The arrival lands while this turn is in flight: after the run's last drain point, and
        // before any row of the turn is on the log.
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
      expect(call).toBe(3);
      expect(userAt).toBeGreaterThan(0);
      expect(reactionAt).toBeGreaterThan(0);
      expect(userAt).toBeLessThan(reactionAt);
    } finally {
      mock.restore(); runRegistry.clear(); resetSessionLogResolver();
    }
  });
  /**
   * A bubble is written once. The run now records an injected message's entry before the turn it
   * caused, so a run that force-closes can leave that entry on the log for the run its message is
   * rerouted to -- and `Log.append` throws on an id it already holds rather than writing a second
   * bubble. The same guard covers a channel replaying a message it has already sent.
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
});
