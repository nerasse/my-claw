import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { resolveAgentLlm, type MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

/**
 * The orchestrator's configured model used to be dead config: `agents.orchestrator.llm` was written
 * by hand, documented, and read by nobody. These tests assert the model that actually reaches the
 * provider, not the one a resolver claims, because that is exactly the gap that hid the bug.
 */

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "litellm",
      defaultModel: "global-model",
      providers: { litellm: { baseUrl: "https://litellm.test/v1" } },
      models: [
        { id: "global-model", label: "Global", provider: "litellm" },
        { id: "agent-model", label: "Agent", provider: "litellm" },
        { id: "session-model", label: "Session", provider: "litellm" },
      ],
    },
    agents: {},
  } as MyClawConfig;
}

function message(platform: "telegram" | "cron"): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform, userId: "u1", chatId: "c1", chatType: "dm",
    text: "hello", attachments: [], isForwarded: false, raw: {},
  } as UnifiedMessage;
}

function session(over?: Partial<SessionData>): SessionData {
  return {
    id: "telegram/dm/u1", platform: "telegram", chatType: "dm",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    messages: [], ...over,
  } as SessionData;
}

/** Runs one turn and returns the model id the provider was actually asked for. */
async function modelSentToProvider(
  config: MyClawConfig,
  platform: "telegram" | "cron" = "telegram",
  // A cron run is a cron session: the role is read off the session, not the message.
  sess: SessionData = platform === "cron" ? { ...session(), id: "cron/0123456789ab/1", platform: "cron" } : session(),
): Promise<string> {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  let sent = "";
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
    sent = String(body.model ?? "");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });
  try {
    await bridge.handleMessage(message(platform), sess);
    return sent;
  } finally {
    mock.restore();
  }
}

describe("orchestrator model from config", () => {
  test("with no agent entry the global default is used", async () => {
    expect(await modelSentToProvider(baseConfig())).toBe("global-model");
  });

  test("agents.orchestrator.llm.defaultModel reaches the provider", async () => {
    const config = baseConfig();
    config.agents.orchestrator = { llm: { defaultModel: "agent-model" } };
    expect(await modelSentToProvider(config)).toBe("agent-model");
  });

  test("a per-chat /model still overrules the configured default", async () => {
    const config = baseConfig();
    config.agents.orchestrator = { llm: { defaultModel: "agent-model" } };
    expect(await modelSentToProvider(config, "telegram", session({ modelOverride: "session-model" })))
      .toBe("session-model");
  });
});

describe("cron model from config", () => {
  test("agents.cron pins a scheduled run without moving the chat default", async () => {
    const config = baseConfig();
    config.agents.cron = { llm: { defaultModel: "agent-model" } };
    expect(await modelSentToProvider(config, "cron")).toBe("agent-model");
    expect(await modelSentToProvider(config, "telegram")).toBe("global-model");
  });

  test("with no cron entry it inherits the orchestrator's pin", async () => {
    const config = baseConfig();
    config.agents.orchestrator = { llm: { defaultModel: "agent-model" } };
    expect(await modelSentToProvider(config, "cron")).toBe("agent-model");
  });

  test("its own entry wins over the inherited one", async () => {
    const config = baseConfig();
    config.agents.orchestrator = { llm: { defaultModel: "agent-model" } };
    config.agents.cron = { llm: { defaultModel: "session-model" } };
    expect(await modelSentToProvider(config, "cron")).toBe("session-model");
  });
});

describe("scoping is not disturbed by the new cron config key", () => {
  test("an absent agents.cron leaves the orchestrator inheritance in place", () => {
    const config = baseConfig();
    config.agents.orchestrator = { llm: { defaultModel: "agent-model" } };
    expect(resolveAgentLlm(config, "cron")).toEqual({ defaultModel: "agent-model" });
    // general and research must NOT inherit: their absent entry means the global default.
    expect(resolveAgentLlm(config, "general")).toBeUndefined();
    expect(resolveAgentLlm(config, "research")).toBeUndefined();
  });

  test("a legacy {model} under any agent key is migrated, orchestrator included", async () => {
    const { parseConfig } = await import("../../src/core/config.ts");
    const raw = JSON.stringify({
      whitelist: [], channels: {},
      llm: { defaultProvider: "p", defaultModel: "g", providers: { p: {} } },
      agents: {
        orchestrator: { llm: { model: "legacy-orch" } },
        cron: { llm: { model: "legacy-cron" } },
      },
    });
    const parsed = parseConfig(raw);
    expect(parsed.agents.orchestrator?.llm).toEqual({ defaultModel: "legacy-orch", defaultProvider: undefined });
    expect(parsed.agents.cron?.llm).toEqual({ defaultModel: "legacy-cron", defaultProvider: undefined });
  });
});
