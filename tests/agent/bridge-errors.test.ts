import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, ToolEntry, UserEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-errors";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: ["dangerous"],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(text = "hello"): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text,
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(): LegacySessionData {
  return {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

function okResponse(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function toolCallResponse(toolName: string, args: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "tc1", function: { name: toolName, arguments: JSON.stringify(args) } }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

describe("AgentBridge error handling", () => {
  test("tool that throws returns error content, does not crash", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "broken",
      description: "throws",
      parameters: {},
      async execute() {
        throw new Error("tool explosion");
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("broken") as never;
      return okResponse("handled error") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("handled error");
      await log.flush();
      const toolEntry = log.entries().find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.output).toContain("tool explosion");
    } finally {
      mock.restore();
      end();
    }
  });

  test("unknown tool returns error message", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("nonexistent_tool") as never;
      return okResponse("ok") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("ok");
      await log.flush();
      const toolEntry = log.entries().find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.output).toContain("unknown tool");
    } finally {
      mock.restore();
      end();
    }
  });

  test("blacklisted tool without handler is denied", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "dangerous",
      description: "requires approval",
      parameters: {},
      async execute() {
        return { success: true, output: "should not run" };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("dangerous") as never;
      return okResponse("denied path") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("denied path");
      await log.flush();
      const toolEntry = log.entries().find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.output).toContain("denied");
    } finally {
      mock.restore();
      end();
    }
  });

  test("LLM returns no content and no tool calls", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    });

    try {
      const session = createSession();
      await expect(bridge.handleMessage(createMessage(), session, signal)).rejects.toThrow("empty final turn");
      // 1 initial call + MAX_EMPTY_TURN_RETRIES(2) retries.
      expect(callCount).toBe(3);
    } finally {
      mock.restore();
      end();
    }
  });

  test("an empty turn is retried and a valid answer completes the run", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as never;
      }
      return okResponse("recovered") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("recovered");
      expect(callCount).toBe(3);
    } finally {
      mock.restore();
      end();
    }
  });

  test("empty-turn retries do not consume the iteration budget", async () => {
    // maxIterations=1: without the grant(1) refund, the two retries would exhaust the budget and
    // fall through to the max-iterations summary path, masking the failure with a fake answer.
    const tightConfig: MyClawConfig = {
      ...config,
      agents: { orchestrator: { maxIterations: 1 } },
    };
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(tightConfig, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as never;
      }
      return okResponse("budget preserved") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("budget preserved");
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
      end();
    }
  });

  test("the empty-turn counter resets after a valid turn", async () => {
    // empty, valid, empty, valid: the second empty must still be retried, proving the counter
    // reset rather than accumulating across turns.
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: {},
      async execute() {
        return { success: true, output: "echoed" };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      // 1: empty (retry) -> 2: tool call -> 3: empty (retry, counter was reset) -> 4: final text
      if (callCount === 1 || callCount === 3) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as never;
      }
      if (callCount === 2) return toolCallResponse("echo") as never;
      return okResponse("done after reset") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("done after reset");
      expect(callCount).toBe(4);
    } finally {
      mock.restore();
      end();
    }
  });

  test("LLM returns null content", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = createSession();
      await expect(bridge.handleMessage(createMessage(), session, signal)).rejects.toThrow("empty final turn");
    } finally {
      mock.restore();
      end();
    }
  });

  test("tool returns success:false is still passed to LLM", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "failing_tool",
      description: "always fails",
      parameters: {},
      async execute() {
        return { success: false, output: "not found", error: "File does not exist" };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("failing_tool") as never;
      return okResponse("handled failure") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("handled failure");
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
      end();
    }
  });

  test("session messages are recorded even when LLM fails", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { message: "overloaded" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = createSession();
      await expect(bridge.handleMessage(createMessage("test msg"), session, signal)).rejects.toThrow();
      // User message should still be recorded in the log
      await log.flush();
      const userEntry = log.entries().find((e): e is UserEntry => e.type === "user");
      expect(userEntry).toBeDefined();
      expect(userEntry!.text).toBe("test msg");
    } finally {
      mock.restore();
      end();
    }
  });

  test("memory tool runs without approval when not blacklisted (full autonomy)", async () => {
    const memoryConfig: MyClawConfig = {
      ...config,
      blacklist: [],
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "memory",
      description: "read/write memory",
      parameters: {},
      async execute() {
        return { success: true, output: "memory write ok" };
      },
    });
    const bridge = new AgentBridge(memoryConfig, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("memory") as never;
      return okResponse("saved") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("saved");
      await log.flush();
      const toolEntry = log.entries().find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.output).toContain("memory write ok");
    } finally {
      mock.restore();
      end();
    }
  });

  test("memory tool requires per-invocation approval when blacklisted", async () => {
    const memoryConfig: MyClawConfig = {
      ...config,
      blacklist: ["memory"],
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "memory",
      description: "read/write memory",
      parameters: {},
      async execute() {
        return { success: true, output: "should not run without approval" };
      },
    });
    const bridge = new AgentBridge(memoryConfig, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("memory") as never;
      return okResponse("denied") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session, signal);
      expect(result).toBe("denied");
      await log.flush();
      const toolEntry = log.entries().find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.output).toContain("denied");
    } finally {
      mock.restore();
      end();
    }
  });
});
