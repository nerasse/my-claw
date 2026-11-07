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
import { promptOf } from "../../src/sessions/projection.ts";
import type { FailureEntry, SessionLog, ToolEntry, UserEntry } from "../../src/sessions/log.ts";

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
      const toolEntry = (await log.all()).find((e): e is ToolEntry => e.type === "tool");
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
      const toolEntry = (await log.all()).find((e): e is ToolEntry => e.type === "tool");
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
      const toolEntry = (await log.all()).find((e): e is ToolEntry => e.type === "tool");
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

  test("a failure reaches the model with its output, not only its error", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "loud_fail",
      description: "fails with output",
      parameters: {},
      async execute() {
        return { success: false, output: "STDERR: grep: missing.txt: No such file", error: "Command failed with exit code 2." };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("loud_fail") as never;
      return okResponse("seen") as never;
    });
    try {
      await bridge.handleMessage(createMessage(), createSession(), signal);
      await log.flush();
      const toolEntry = (await log.all()).find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry!.output).toBe("Error: Command failed with exit code 2.\n\nSTDERR: grep: missing.txt: No such file");
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
      const userEntry = (await log.all()).find((e): e is UserEntry => e.type === "user");
      expect(userEntry).toBeDefined();
      expect(userEntry!.text).toBe("test msg");
    } finally {
      mock.restore();
      end();
    }
  });

  test("a run that dies of an API error leaves its work on the branch, and the failure lands after it", async () => {
    // A run that dies ends where it died, like one `/stop` killed. Rewinding to the question put
    // the settled call on a branch `pathOf` never walks: on disk, and gone from the thread at the
    // next refresh.
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: {},
      async execute() {
        return { success: true, output: "24 minutes of bash" };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("echo") as never;
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 400 }) as never;
    });

    try {
      await expect(bridge.handleMessage(createMessage(), createSession(), signal)).rejects.toThrow();
      await log.flush();
      expect((await log.path()).map((e) => e.type)).toEqual(["user", "run_start", "phase", "tool", "run_end"]);
      const tool = (await log.path()).find((e): e is ToolEntry => e.type === "tool");
      expect(tool!.output).toContain("24 minutes of bash");
      // The channel files the error where the cursor stands, which is now past the run's own end.
      const failure = log.append<FailureEntry>({ type: "failure", prompt: false, error: "API Error: 400" });
      expect((await log.entryById(failure.parentId!))!.type).toBe("run_end");
      await log.flush();
    } finally {
      mock.restore();
      end();
    }
  });

  test("the dead attempt projects to a prompt where every call it made is answered", async () => {
    // The work staying on the branch means the next turn reads it. An assistant turn asking for a
    // call nothing answers is refused outright by Anthropic and by any OpenAI-compatible endpoint,
    // so what the dead attempt leaves has to be a legal exchange on its own.
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: {},
      async execute() {
        return { success: true, output: "settled" };
      },
    });
    const bridge = new AgentBridge(config, registry, new SkillRegistry());
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("echo") as never;
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 400 }) as never;
    });

    try {
      await expect(bridge.handleMessage(createMessage(), createSession(), signal)).rejects.toThrow();
      await log.flush();
      const prompt = promptOf((await log.all()), log.leaf());
      const asked = prompt.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
      const answered = prompt.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
      expect(asked).toEqual(["tc1"]);
      expect(answered).toEqual(asked);
      expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
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
      const toolEntry = (await log.all()).find((e): e is ToolEntry => e.type === "tool");
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
      const toolEntry = (await log.all()).find((e): e is ToolEntry => e.type === "tool");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.output).toContain("denied");
    } finally {
      mock.restore();
      end();
    }
  });
});
