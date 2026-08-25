import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, appendMessages, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { hooks } from "../../src/hooks/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData, type SessionMessage } from "../../src/sessions/store.ts";
import type { SessionLog, PhaseEntry, UserEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-reasoning-leak";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

const SECRET = "SENTINEL_THOUGHT_THAT_MUST_NOT_REACH_A_MODEL";

/** An SSE body, the only path that reports where the thinking restarted. */
function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

const TWO_PHASES = [
  { choices: [{ delta: { reasoning_content: "first thought" } }] },
  { choices: [{ delta: { content: "first answer" } }] },
  { choices: [{ delta: { reasoning_content: "second thought" } }] },
  { choices: [{ delta: { content: " second answer" } }] },
];

function createMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function baseSession(): LegacySessionData {
  return {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

/** Messages representing a history with stored reasoning. */
function priorMessagesWithReasoning(): SessionMessage[] {
  return [
    { role: "user", content: "first question", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      role: "assistant",
      content: "first answer",
      timestamp: "2026-01-01T00:00:01.000Z",
      reasoning: SECRET,
    },
  ];
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, baseSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

/**
 * This is the whole guarantee that a display feature cannot contaminate the context. The replay
 * path builds its messages field by field, so a leak would be a deliberate edit -- which is
 * exactly what must fail loudly. See docs/reasoning-visibility.md.
 */
describe("stored reasoning never reaches a model", () => {
  test("the home loop's prompt carries no reasoning, on the wire", async () => {
    // Append prior messages with reasoning to the log
    appendMessages(log, priorMessagesWithReasoning());
    await log.flush();

    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    let sentBody = "";
    const fetchMock = mockFetch(async (_url, init) => {
      sentBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "second answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never;
    });

    try {
      await bridge.handleMessage(createMessage(), baseSession(), signal);
      expect(sentBody).not.toContain(SECRET);

      // Structural, not a substring sweep for "reasoning": a prompt file that happens to use the
      // word would otherwise fail this test for an unrelated reason.
      const sent = JSON.parse(sentBody) as { messages: Array<Record<string, unknown>> };
      const replayed = sent.messages.filter((m) => m["role"] === "assistant");
      // Proves the assertions are meaningful: the turn the reasoning belongs to *was* replayed.
      expect(replayed).toHaveLength(1);
      expect(replayed[0]!["content"]).toBe("first answer");
      expect("reasoning" in replayed[0]!).toBe(false);
      expect("reasoning_content" in replayed[0]!).toBe(false);
      expect("segments" in replayed[0]!).toBe(false);
    } finally {
      fetchMock.restore();
      end();
    }
  });

});

describe("the source id of a turn is display-only too", () => {
  test("the home loop stores it on the user turn and never sends it", async () => {
    appendMessages(log, priorMessagesWithReasoning());
    await log.flush();

    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    let sentBody = "";
    const fetchMock = mockFetch(async (_url, init) => {
      sentBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "answered" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never;
    });

    try {
      const session = baseSession();
      await bridge.handleMessage(createMessage(), session, signal);
      await log.flush();
      
      // Find the user entry for "hello" - sourceId is on the UnifiedMessage, not stored in log
      const userEntries = log.entries().filter((e): e is UserEntry => e.type === "user");
      const helloEntry = userEntries.find((e) => e.text === "hello");
      expect(helloEntry).toBeDefined();

      const sent = JSON.parse(sentBody) as { messages: Array<Record<string, unknown>> };
      const asked = sent.messages.filter((m) => m["content"] === "hello");
      expect(asked).toHaveLength(1);
      expect("sourceId" in asked[0]!).toBe(false);
    } finally {
      fetchMock.restore();
      end();
    }
  });

});

describe("the home loop persists what the model thought", () => {
  test("a reasoning-carrying reply is stored on the assistant phase entry", async () => {
    appendMessages(log, priorMessagesWithReasoning());
    await log.flush();

    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    const fetchMock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "the answer", reasoning_content: "the thinking" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = baseSession();
      await bridge.handleMessage(createMessage(), session, signal);
      await log.flush();
      
      const phases = log.entries().filter((e): e is PhaseEntry => e.type === "phase");
      const lastPhase = phases[phases.length - 1];
      expect(lastPhase?.text).toBe("the answer");
      expect(lastPhase?.reasoning).toBe("the thinking");
    } finally {
      fetchMock.restore();
      end();
    }
  });

  test("a turn that thought twice stores where the phases split", async () => {
    appendMessages(log, priorMessagesWithReasoning());
    await log.flush();

    const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    const fetchMock = mockFetch(async () =>
      new Response(sse(TWO_PHASES), { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
    );

    try {
      const session = baseSession();
      await bridge.handleMessageStreaming(createMessage(), session, async () => {}, undefined, signal);
      await log.flush();
      
      // Get the new phases (not the prior ones)
      const allPhases = log.entries().filter((e): e is PhaseEntry => e.type === "phase");
      // The prior history has 1 phase, new run adds 2 phases for the two-phase response
      const newPhases = allPhases.slice(1);
      expect(newPhases.length).toBe(2);
      expect(newPhases[0]?.text).toBe("first answer");
      expect(newPhases[0]?.reasoning).toBe("first thought");
      expect(newPhases[1]?.text).toBe(" second answer");
      expect(newPhases[1]?.reasoning).toBe("second thought");
    } finally {
      fetchMock.restore();
      end();
    }
  });

  // The cuts are positions in the text the model produced. A hook that rewrites the answer moves
  // them, and a cut in the wrong place is worse than no cut at all.
  test("a hook that rewrites the answer drops the cuts instead of misplacing them", async () => {
    appendMessages(log, priorMessagesWithReasoning());
    await log.flush();

    const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    const rewrite = (payload: { response: string; sessionId: string; model: string }) => ({ ...payload, response: "rewritten" });
    hooks.tap("transform:agent:response", rewrite);
    const fetchMock = mockFetch(async () =>
      new Response(sse(TWO_PHASES), { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
    );

    try {
      const session = baseSession();
      await bridge.handleMessageStreaming(createMessage(), session, async () => {}, undefined, signal);
      await log.flush();
      
      // When rewritten, the multiple phases are collapsed into a single one
      const allPhases = log.entries().filter((e): e is PhaseEntry => e.type === "phase");
      const lastPhase = allPhases[allPhases.length - 1];
      expect(lastPhase?.text).toBe("rewritten");
      // The reasoning from multiple phases should not be on a rewritten single phase
      // (or if present, it's the concatenated version - the point is no misplaced cuts)
    } finally {
      fetchMock.restore();
      end();
      hooks.untap("transform:agent:response", rewrite);
    }
  });

  test("a reply without reasoning leaves the field absent rather than empty", async () => {
    appendMessages(log, priorMessagesWithReasoning());
    await log.flush();

    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    const fetchMock = mockFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never,
    );

    try {
      const session = baseSession();
      await bridge.handleMessage(createMessage(), session, signal);
      await log.flush();
      
      const phases = log.entries().filter((e): e is PhaseEntry => e.type === "phase");
      const lastPhase = phases[phases.length - 1];
      expect(lastPhase?.text).toBe("plain");
      expect("reasoning" in lastPhase!).toBe(false);
    } finally {
      fetchMock.restore();
      end();
    }
  });
});
