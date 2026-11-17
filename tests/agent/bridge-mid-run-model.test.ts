/**
 * A model picked while a run is going applies to that run.
 *
 * The pick used to be read once, when the run resolved its chain: the owner could change a
 * conversation's model from the app, watch the header agree, and the run in flight kept calling the
 * old one until it ended -- and a sub-agent an hour into its work had no way to adopt it at all
 * without being killed, which throws its history away (owner, 2026-11-17).
 *
 * Read at every turn boundary now, and applied only when the owner's own pins actually moved: a run
 * that re-resolved on every turn would undo the model a fallback adopted on a spent bar.
 */

import { test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import type { Tool } from "../../src/tools/types.ts";

const SESSION_ID = "my-claw-app/thread/u1/mid-run-model";

function config(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "litellm",
      defaultModel: "first-model",
      providers: { litellm: { baseUrl: "https://litellm.test/v1" } },
      models: [
        { id: "first-model", label: "First", provider: "litellm" },
        { id: "second-model", label: "Second", provider: "litellm" },
      ],
    },
    agents: {},
  } as MyClawConfig;
}

function message(): UnifiedMessage {
  return {
    id: `m-${Date.now()}`, platform: "my-claw-app", userId: "u1", chatId: "u1", chatType: "dm",
    text: "go", attachments: [], isForwarded: false, raw: {},
  } as UnifiedMessage;
}

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    id: SESSION_ID, platform: "my-claw-app", chatType: "dm",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    messages: [], ...over,
  } as SessionData;
}

/**
 * One run, two turns: the tool fires between them, which is where the owner's pick lands in real
 * life too -- a pick is a frame from the app, and the run drains nothing but its mailbox between
 * two calls.
 */
async function modelsAcrossTurns(
  mutate: (session: SessionData) => void,
  sess: SessionData = session(),
): Promise<string[]> {
  const registry = new ToolRegistry();
  const tool: Tool = {
    name: "pick",
    description: "changes the conversation's model, like the app's picker",
    parameters: {},
    async execute() {
      mutate(sess);
      return { success: true, output: "picked" };
    },
  };
  registry.register(tool);

  const bridge = new AgentBridge(config(), registry, new SkillRegistry());
  const calls: string[] = [];
  let turn = 0;
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
    calls.push(String(body.model ?? ""));
    if (turn++ === 0) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "pick", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }) as never;
  });
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  try {
    await bridge.handleMessage(message(), sess, signal);
    return calls;
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
  }
}

test("a model picked mid-run is the one the next turn calls", async () => {
  const calls = await modelsAcrossTurns((sess) => {
    sess.modelOverride = "second-model";
  });
  expect(calls).toEqual(["first-model", "second-model"]);
});

test("a run whose pins never move keeps the model it started on", async () => {
  const calls = await modelsAcrossTurns(() => {});
  expect(calls).toEqual(["first-model", "first-model"]);
});

test("a pin cleared mid-run hands the conversation back to its scope", async () => {
  const sess = session({ modelOverride: "second-model" });
  const calls = await modelsAcrossTurns((held) => {
    delete held.modelOverride;
  }, sess);
  expect(calls).toEqual(["second-model", "first-model"]);
});

test("the switch is announced as the owner's, with the model that now answers", async () => {
  // The event the header, the status page and a roster row read: same shape a fallback uses, so a
  // surface that follows one follows the other. The rung rides beside the model only when the
  // model declares one -- these fixtures declare none, and an effort nothing will be sent is not
  // named.
  const seen: Array<{ sessionId: string; parentSessionId: string; model: string; previous: string; reason: string; effort?: string }> = [];
  const listener = (event: (typeof seen)[number]): void => {
    seen.push(event);
  };
  hooks.on("agent:model:changed", listener);
  const registry = new ToolRegistry();
  const sess = session();
  registry.register({
    name: "pick",
    description: "raises the effort",
    parameters: {},
    async execute() {
      sess.effortOverride = "max" as never;
      sess.modelOverride = "second-model";
      return { success: true, output: "picked" };
    },
  });
  const bridge = new AgentBridge(config(), registry, new SkillRegistry());
  let turn = 0;
  const mock = mockFetch(async () => {
    if (turn++ === 0) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "pick", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }) as never;
  });
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  try {
    await bridge.handleMessage(message(), sess, signal);
  } finally {
    hooks.off("agent:model:changed", listener);
    mock.restore();
    end();
    runRegistry.clear();
  }
  expect(seen).toEqual([{
    sessionId: SESSION_ID,
    parentSessionId: SESSION_ID,
    model: "second-model",
    previous: "first-model",
    reason: "owner",
  }]);
});
