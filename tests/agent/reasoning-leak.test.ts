import { describe, expect, test } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { hooks } from "../../src/hooks/index.ts";
import { renderPriorConversation } from "../../src/agent/claude-sdk/history.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData, SessionMessage } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
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
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

/** A session whose history already carries a stored reasoning, as a real one would after a turn. */
function sessionWithReasoning(): SessionData {
  const messages: SessionMessage[] = [
    { role: "user", content: "first question", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      role: "assistant",
      content: "first answer",
      timestamp: "2026-01-01T00:00:01.000Z",
      reasoning: SECRET,
      // The per-phase copy is the same display-only text, so it is the same leak if it travels.
      segments: [{ reasoning: SECRET, content: "first answer" }],
    },
  ];
  return {
    id: "telegram/dm/u1",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages,
  };
}

/**
 * These two tests are the whole guarantee that a display feature cannot contaminate the context.
 * Both replay paths build their messages field by field, so a leak would be a deliberate edit --
 * which is exactly what must fail loudly. See docs/reasoning-visibility.md.
 */
describe("stored reasoning never reaches a model", () => {
  test("the home loop's prompt carries no reasoning, on the wire", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    let sentBody = "";
    const fetchMock = mockFetch(async (_url, init) => {
      sentBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "second answer" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never;
    });

    try {
      await bridge.handleMessage(createMessage(), sessionWithReasoning());
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
    }
  });

  test("the engine-switch transcript carries no reasoning", () => {
    const rendered = renderPriorConversation(sessionWithReasoning().messages, { maxTokens: 10_000 });
    expect(rendered).not.toBeNull();
    expect(rendered!.text).not.toContain(SECRET);
    expect(rendered!.text).toContain("first answer");
  });
});

describe("the source id of a turn is display-only too", () => {
  test("the home loop stores it on the user turn and never sends it", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    let sentBody = "";
    const fetchMock = mockFetch(async (_url, init) => {
      sentBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "answered" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never;
    });

    try {
      const session = sessionWithReasoning();
      await bridge.handleMessage(createMessage(), session);
      const turn = session.messages.find((m) => m.role === "user" && m.content === "hello");
      expect(turn?.role === "user" ? turn.sourceId : undefined).toBe("m1");

      const sent = JSON.parse(sentBody) as { messages: Array<Record<string, unknown>> };
      const asked = sent.messages.filter((m) => m["content"] === "hello");
      expect(asked).toHaveLength(1);
      expect("sourceId" in asked[0]!).toBe(false);
    } finally {
      fetchMock.restore();
    }
  });

  test("the engine-switch transcript carries no source id", () => {
    const messages: SessionMessage[] = [
      { role: "user", content: "first question", timestamp: "2026-01-01T00:00:00.000Z", sourceId: "send-42" },
      { role: "assistant", content: "first answer", timestamp: "2026-01-01T00:00:01.000Z" },
    ];
    const rendered = renderPriorConversation(messages, { maxTokens: 10_000 });
    expect(rendered).not.toBeNull();
    expect(rendered!.text).toContain("first question");
    expect(rendered!.text).not.toContain("send-42");
  });
});

describe("the home loop persists what the model thought", () => {
  test("a reasoning-carrying reply is stored on the assistant mirror message", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const fetchMock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "the answer", reasoning_content: "the thinking" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = sessionWithReasoning();
      await bridge.handleMessage(createMessage(), session);
      const last = session.messages[session.messages.length - 1];
      expect(last?.role).toBe("assistant");
      expect(last?.role === "assistant" ? last.reasoning : undefined).toBe("the thinking");
    } finally {
      fetchMock.restore();
    }
  });

  test("a turn that thought twice stores where the phases split", async () => {
    const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
    const fetchMock = mockFetch(async () =>
      new Response(sse(TWO_PHASES), { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
    );

    try {
      const session = sessionWithReasoning();
      await bridge.handleMessageStreaming(createMessage(), session, async () => {});
      const last = session.messages[session.messages.length - 1];
      expect(last?.role === "assistant" ? last.content : undefined).toBe("first answer second answer");
      expect(last?.role === "assistant" ? last.segments : undefined).toEqual([
        { reasoning: "first thought", content: "first answer" },
        { reasoning: "second thought", content: " second answer" },
      ]);
    } finally {
      fetchMock.restore();
    }
  });

  // The cuts are positions in the text the model produced. A hook that rewrites the answer moves
  // them, and a cut in the wrong place is worse than no cut at all.
  test("a hook that rewrites the answer drops the cuts instead of misplacing them", async () => {
    const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
    const rewrite = (payload: { response: string; sessionId: string; model: string }) => ({ ...payload, response: "rewritten" });
    hooks.tap("transform:agent:response", rewrite);
    const fetchMock = mockFetch(async () =>
      new Response(sse(TWO_PHASES), { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
    );

    try {
      const session = sessionWithReasoning();
      await bridge.handleMessageStreaming(createMessage(), session, async () => {});
      const last = session.messages[session.messages.length - 1];
      expect(last?.role === "assistant" ? last.content : undefined).toBe("rewritten");
      expect(last?.role === "assistant" ? "segments" in last : true).toBe(false);
    } finally {
      fetchMock.restore();
      hooks.untap("transform:agent:response", rewrite);
    }
  });

  test("a reply without reasoning leaves the field absent rather than empty", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const fetchMock = mockFetch(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as never,
    );

    try {
      const session = sessionWithReasoning();
      await bridge.handleMessage(createMessage(), session);
      const last = session.messages[session.messages.length - 1];
      expect(last?.role === "assistant" ? "reasoning" in last : true).toBe(false);
    } finally {
      fetchMock.restore();
    }
  });
});
