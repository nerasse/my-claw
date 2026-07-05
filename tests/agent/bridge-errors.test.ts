import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: ["dangerous"],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
};

function createMessage(text = "hello"): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text,
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(): SessionData {
  return {
    id: "test-session",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

function okResponse(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
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
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

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

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("broken") as never;
      return okResponse("handled error") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("handled error");
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("tool explosion");
    } finally {
      mock.restore();
    }
  });

  test("unknown tool returns error message", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("nonexistent_tool") as never;
      return okResponse("ok") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("ok");
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("unknown tool");
    } finally {
      mock.restore();
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

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("dangerous") as never;
      return okResponse("denied path") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("denied path");
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("denied");
    } finally {
      mock.restore();
    }
  });

  test("LLM returns no content and no tool calls", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("");
    } finally {
      mock.restore();
    }
  });

  test("LLM returns null content", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: null } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("");
    } finally {
      mock.restore();
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

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("failing_tool") as never;
      return okResponse("handled failure") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("handled failure");
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("session messages are recorded even when LLM fails", async () => {
    const registry = new ToolRegistry();
    const bridge = new AgentBridge(config, registry, new SkillRegistry());

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { message: "overloaded" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const session = createSession();
      await expect(bridge.handleMessage(createMessage("test msg"), session)).rejects.toThrow();
      // User message should still be recorded
      expect(session.messages.length).toBeGreaterThanOrEqual(1);
      expect(session.messages[0]!.role).toBe("user");
    } finally {
      mock.restore();
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
    // No approval handler set: with an empty blacklist none is needed.

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("memory") as never;
      return okResponse("saved") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("saved");
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("memory write ok");
    } finally {
      mock.restore();
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

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse("memory") as never;
      return okResponse("denied") as never;
    });

    try {
      const session = createSession();
      const result = await bridge.handleMessage(createMessage(), session);
      expect(result).toBe("denied");
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("denied");
    } finally {
      mock.restore();
    }
  });
});
