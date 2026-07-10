import { test } from "bun:test";
import assert from "node:assert/strict";
import { BackendDispatcher } from "../../src/agent/dispatcher.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ClaudeSdkBackend } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function mixedConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: {
        litellm: { baseUrl: "https://litellm.local/v1" },
        anthropic: { type: "claude-sdk", fallbackModel: "claude-haiku-4" },
      },
      models: [
        { id: "mimo", label: "Mimo", provider: "litellm" },
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
      ],
      defaultProvider: "litellm",
      defaultModel: "mimo",
    },
    agents: {}, memory: { enabled: false },
  };
}

function msg(id: string): UnifiedMessage {
  return { id, platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}

function session(id: string, modelOverride?: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [], modelOverride };
}

test("resolver marks claude-sdk providers and leaves openai providers untouched", () => {
  const config = mixedConfig();
  const home = resolveLlmConfig(config.llm, "mimo");
  assert.equal(home.backend, undefined);
  assert.equal(home.baseUrl, "https://litellm.local/v1");

  const sdk = resolveLlmConfig(config.llm, "claude-sonnet-5");
  assert.equal(sdk.backend, "claude-sdk");
  assert.equal(sdk.baseUrl, "claude-sdk");
  assert.equal(sdk.fallbackModel, "claude-haiku-4");
});

test("dispatcher routes runs by the session's resolved model", async () => {
  const config = mixedConfig();
  const calls: string[] = [];
  const home = { handleMessage: async () => { calls.push("home"); return "home"; } } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => { calls.push("sdk"); return "sdk"; } } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  assert.equal(await dispatcher.handleMessage(msg("m1"), session("s1")), "home");
  assert.equal(await dispatcher.handleMessage(msg("m2"), session("s2", "claude-sonnet-5")), "sdk");
  assert.equal(await dispatcher.handleMessage(msg("m3"), session("s3", "mimo")), "home");
  assert.deepEqual(calls, ["home", "sdk", "home"]);
});

test("setApprovalHandler reaches both engines", () => {
  const config = mixedConfig();
  const seen: string[] = [];
  const home = { setApprovalHandler: () => { seen.push("home"); } } as unknown as AgentBridge;
  const sdk = { setApprovalHandler: () => { seen.push("sdk"); } } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });
  dispatcher.setApprovalHandler(async () => "allow-once");
  assert.deepEqual(seen, ["home", "sdk"]);
});
