import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { BackendDispatcher } from "../../src/agent/dispatcher.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { resolveOpenAiLlmConfig, isSdkBackedModel } from "../../src/llm/resolver.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function mixedConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: {
        litellm: { baseUrl: "https://litellm.local/v1" },
        anthropic: { type: "claude-sdk" },
      },
      models: [
        { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
        { id: "mimo", label: "Mimo", provider: "litellm" },
      ],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
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

test("resolveOpenAiLlmConfig falls back off a claude-sdk default model", () => {
  const config = mixedConfig();
  const resolved = resolveOpenAiLlmConfig(config.llm);
  assert.equal(resolved.backend, undefined);
  assert.equal(resolved.model, "mimo");
  assert.equal(resolved.baseUrl, "https://litellm.local/v1");
});

test("resolveOpenAiLlmConfig throws when every model is SDK-backed", () => {
  const config = mixedConfig();
  config.llm.models = [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }];
  assert.throws(() => resolveOpenAiLlmConfig(config.llm), /No OpenAI-compatible model/);
});

test("isSdkBackedModel follows the default provider for unknown ids", () => {
  const config = mixedConfig();
  assert.equal(isSdkBackedModel(config.llm, "claude-sonnet-5"), true);
  assert.equal(isSdkBackedModel(config.llm, "mimo"), false);
  // Unknown id falls through to the default provider (anthropic here) without throwing.
  assert.equal(isSdkBackedModel(config.llm, "removed-model"), true);
  // With the provider itself gone, resolution throws and the helper answers false.
  const broken = mixedConfig();
  broken.llm.defaultProvider = "gone";
  delete broken.llm.providers!["anthropic"];
  assert.equal(isSdkBackedModel(broken.llm, "claude-sonnet-5"), false);
});

test("clearHistory drops the SDK session id", async () => {
  const manager = new SessionManager();
  const sess = await manager.getOrCreateWithMeta("s-clear", "telegram", "dm");
  sess.sdkSessionId = "sdk-old";
  sess.messages.push({ role: "user", content: "x", timestamp: new Date().toISOString() });
  manager.clearHistory("s-clear");
  assert.equal(sess.messages.length, 0);
  assert.equal(sess.sdkSessionId, undefined);
});

test("dispatcher self-heals a stale modelOverride instead of erroring forever", async () => {
  const config = mixedConfig();
  const calls: string[] = [];
  const home = { handleMessage: async () => { calls.push("home"); return "home"; } } as unknown as AgentBridge;
  const sdk = { handleMessage: async () => { calls.push("sdk"); return "sdk"; } } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, { home, sdk });

  const sess = session("s-stale", "mimo");
  config.llm.models = [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }];
  delete config.llm.providers!["litellm"];

  const out = await dispatcher.handleMessage(msg("m1"), sess);
  assert.equal(out, "sdk");
  assert.equal(sess.modelOverride, undefined);
});

test("compactSdkSession refuses to race an active run", async () => {
  runRegistry.clear();
  const config = mixedConfig();
  const sdk = { compact: async () => "compacted" } as unknown as ClaudeSdkBackend;
  const dispatcher = new BackendDispatcher(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, {
    home: {} as AgentBridge, sdk,
  });
  const sess = session("s-busy");
  sess.sdkSessionId = "sdk-1";

  const { end } = runRegistry.startRoot(sess.id);
  try {
    const out = await dispatcher.compactSdkSession(sess);
    assert.ok(out.includes("run is active"));
  } finally {
    end();
    runRegistry.clear();
  }
  const out2 = await dispatcher.compactSdkSession(sess);
  assert.equal(out2, "compacted");
});

test("a failed run rolls back both the mirror and the SDK session pointer", async () => {
  runRegistry.clear();
  const queryFn: SdkQueryFn = ({ prompt }) => {
    return (async function* () {
      await prompt.next();
      yield { type: "system", subtype: "init", session_id: "sdk-new" } as never;
      throw new Error("subprocess died");
    })() as AsyncIterable<never>;
  };
  const backend = new ClaudeSdkBackend(mixedConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);
  const sess = session("s-rollback");
  sess.sdkSessionId = "sdk-old";

  await assert.rejects(() => backend.handleMessage(msg("m1"), sess), /subprocess died/);
  assert.equal(sess.messages.length, 0);
  assert.equal(sess.sdkSessionId, "sdk-old");
});

test("compact maps an aborted (timed out) CLI to a friendly message", async () => {
  let controller: AbortController | undefined;
  const queryFn: SdkQueryFn = ({ options }) => {
    controller = (options as { abortController?: AbortController }).abortController;
    return (async function* () {
      // Hung CLI: throws only once the abort wall fires (same code path as the timeout).
      await new Promise((resolve) => controller?.signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("Claude Code process aborted by user");
    })() as AsyncIterable<never>;
  };
  const backend = new ClaudeSdkBackend(mixedConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);
  const sess = session("s-timeout");
  sess.sdkSessionId = "sdk-1";

  const p = backend.compact(sess);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(controller, "compact must pass an abortController");
  controller!.abort();
  const out = await p;
  assert.equal(out, "Compaction timed out.");
});
