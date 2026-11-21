/**
 * What the model is actually sent, on the wire, when the owner's message arrives while a reader is
 * on the same conversation.
 *
 * The body of the request is the only truth: the log can hold the question (the thread draws it)
 * and the prompt can still be the previous turn. That is what the owner saw on 2026-11-21: a
 * question in the thread, four answers to the turn before it (thread 4d5775e7, message ff4ca8dd).
 *
 * The hook that files the second write is `transform:user:content`: it runs after the run has
 * taken its branch and before it appends its own user turn, which is exactly the window.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog } from "../helpers/session-log.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { hooks } from "../../src/hooks/index.ts";
import { resetSessionLogResolver } from "../../src/sessions/log-access.ts";
import { openSessionLog, type UserEntry } from "../../src/sessions/log.ts";
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
function llm(reply: object): never {
  return new Response(JSON.stringify({ choices: [{ message: reply }] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}
interface Body {
  messages: Array<{ role: string; content: unknown }>;
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  runRegistry.clear();
  resetSessionLogResolver();
});

describe("the prompt carries the turn the owner just sent", () => {
  test("a reader on the same conversation does not leave the question behind", async () => {
    const setup = await setupSessionLog(SESSION_ID);
    cleanup = setup.cleanup;
    const { log } = setup;
    // A compacted session: its context is rebuilt from the boundary on every read.
    log.append<UserEntry>({ type: "user", prompt: true, text: "premier" });
    const answer = log.append({ type: "phase", prompt: true, text: "réponse au premier", runId: "run-1" });
    log.append({
      type: "compaction", prompt: true, summary: "## Goal\n- premier",
      firstKeptEntryId: answer.id, tokensBefore: 900, count: 1,
    });
    await log.flush();

    const bodies: Body[] = [];
    const mock = mockFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
      return llm({ content: "réponse au second" });
    });

    // The window: a second handle files something (a runner's marker, a cron delivery), then a
    // status report reads the run's own log. Both are what the production thread went through.
    let raced = false;
    const reader = async (payload: { content: string; sessionId: string }): Promise<{ content: string; sessionId: string }> => {
      if (!raced) {
        raced = true;
        const other = await openSessionLog(SESSION_ID);
        other.append({ type: "command", prompt: false, input: "/cron", output: "filed" });
        await other.flush();
        await log.context();
      }
      return payload;
    };
    hooks.tap("transform:user:content", reader);

    try {
      const router = new MessageRouter(new SessionManager(), new AgentBridge(config, new ToolRegistry(), new SkillRegistry()), config);
      await router.route(message("m2", "et ensuite ?"));
    } finally {
      hooks.untap("transform:user:content", reader);
      mock.restore();
    }

    expect(bodies.length).toBe(1);
    const sent = bodies[0]!.messages;
    const lastUser = [...sent].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content)).toContain("et ensuite ?");
    expect(sent[sent.length - 1]!.role).toBe("user");
  });

  test("without the reader, the same run sends the same single turn", async () => {
    const setup = await setupSessionLog(SESSION_ID);
    cleanup = setup.cleanup;
    const { log } = setup;
    log.append<UserEntry>({ type: "user", prompt: true, text: "premier" });
    const answer = log.append({ type: "phase", prompt: true, text: "réponse au premier", runId: "run-1" });
    log.append({
      type: "compaction", prompt: true, summary: "## Goal\n- premier",
      firstKeptEntryId: answer.id, tokensBefore: 900, count: 1,
    });
    await log.flush();

    const bodies: Body[] = [];
    const mock = mockFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
      return llm({ content: "réponse au second" });
    });
    try {
      const router = new MessageRouter(new SessionManager(), new AgentBridge(config, new ToolRegistry(), new SkillRegistry()), config);
      await router.route(message("m3", "et ensuite ?"));
    } finally {
      mock.restore();
    }

    expect(bodies.length).toBe(1);
    const sent = bodies[0]!.messages;
    expect(String(sent[sent.length - 1]!.content)).toContain("et ensuite ?");
  });
});
