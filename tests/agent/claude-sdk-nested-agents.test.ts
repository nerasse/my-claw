import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolServerForRun } from "../../src/agent/claude-sdk/tools.ts";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { NestedAgentsCollector } from "../../src/agent/prompt/nested-agents.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function msg(): UnifiedMessage {
  return { id: "m1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "read that file", attachments: [], isForwarded: false, raw: {} };
}
function session(): SessionData {
  const now = new Date().toISOString();
  return { id: "telegram/dm/u1", platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}
function readTool(): Tool {
  return { name: "read", description: "read", parameters: {}, async execute() { return { success: true, output: "file body" }; } };
}

// A repo with a nested AGENTS.md, outside the workspace root, that a tool call touches.
function makeRepo(): { dir: string; file: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "sdk-nested-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "REPO LOCAL RULES", "utf-8");
  writeFileSync(join(repo, "f.ts"), "x", "utf-8");
  return { dir: repo, file: join(repo, "f.ts"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

interface RegisteredTools {
  _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
}

/**
 * Drives one tool call through the real in-process MCP server. The SDK exposes no public
 * invoker for a registered tool, so the test reaches the handler the SDK itself would call.
 */
async function callRead(file: string, collector?: NestedAgentsCollector): Promise<string> {
  const server = createToolServerForRun([readTool()], {
    message: msg(),
    session: session(),
    depth: 0,
    workspaceDir: tmpdir(),
    addAttachment: () => {},
    nestedAgents: collector,
  });
  const registered = (server.instance as unknown as RegisteredTools)._registeredTools;
  const result = await registered["read"]!.handler({ path: file }, {});
  return result.content.map((c) => c.text).join("");
}

function sdkConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
    },
    agents: {}, memory: { enabled: false },
  };
}

/**
 * Runs a real backend message and invokes the `read` tool on the MCP server the backend
 * itself built, so the collector wiring in backend.ts is what is under test here.
 */
async function callReadThroughBackend(config: MyClawConfig, file: string): Promise<string> {
  runRegistry.clear();
  const registry = new ToolRegistry();
  registry.register(readTool());

  let server: unknown;
  const queryFn: SdkQueryFn = ({ prompt, options }) => {
    server = (options as { mcpServers?: Record<string, unknown> }).mcpServers?.["myclaw"];
    return (async function* () {
      await prompt.next();
      yield { type: "result", subtype: "success", result: "ok" } as never;
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
  };

  const backend = new ClaudeSdkBackend(
    config, registry, new SkillRegistry(), undefined, undefined, 0, tmpdir(), undefined, undefined, undefined, queryFn,
  );
  try {
    await backend.handleMessage(msg(), session());
    const registered = ((server as { instance: unknown }).instance as RegisteredTools)._registeredTools;
    const result = await registered["read"]!.handler({ path: file }, {});
    return result.content.map((c) => c.text).join("");
  } finally {
    runRegistry.clear();
  }
}

test("claude-sdk: nested AGENTS.md is appended to the tool result", async () => {
  const repo = makeRepo();
  try {
    const text = await callRead(repo.file, new NestedAgentsCollector(tmpdir(), 32_000));
    assert.ok(text.includes("file body"), "original tool output preserved");
    assert.ok(text.includes("REPO LOCAL RULES"), "nested AGENTS.md injected");
    assert.ok(text.includes("Local project instructions"), "precedence note present");
  } finally {
    repo.cleanup();
  }
});

test("claude-sdk: no collector means no injection", async () => {
  const repo = makeRepo();
  try {
    const text = await callRead(repo.file);
    assert.ok(text.includes("file body"), "tool output still there");
    assert.ok(!text.includes("REPO LOCAL RULES"), "nothing injected when disabled");
  } finally {
    repo.cleanup();
  }
});

test("claude-sdk backend: builds the collector for its own tool server", async () => {
  const repo = makeRepo();
  try {
    const text = await callReadThroughBackend(sdkConfig(), repo.file);
    assert.ok(text.includes("REPO LOCAL RULES"), "backend wired the collector into the run");
  } finally {
    repo.cleanup();
  }
});

test("claude-sdk backend: agents.nested.enabled=false disables discovery", async () => {
  const repo = makeRepo();
  try {
    const config = sdkConfig();
    config.agents.nested = { enabled: false };
    const text = await callReadThroughBackend(config, repo.file);
    assert.ok(text.includes("file body"), "tool output still there");
    assert.ok(!text.includes("REPO LOCAL RULES"), "config gate honoured");
  } finally {
    repo.cleanup();
  }
});

test("claude-sdk: an edited nested AGENTS.md is picked up by the next run", async () => {
  const repo = makeRepo();
  try {
    const first = await callRead(repo.file, new NestedAgentsCollector(tmpdir(), 32_000));
    assert.ok(first.includes("REPO LOCAL RULES"), "initial content injected");

    writeFileSync(join(repo.dir, "AGENTS.md"), "RULES REWRITTEN MID SESSION", "utf-8");

    // A fresh collector is what the backend builds for the next message.
    const second = await callRead(repo.file, new NestedAgentsCollector(tmpdir(), 32_000));
    assert.ok(second.includes("RULES REWRITTEN MID SESSION"), "edit visible on the next run");
    assert.ok(!second.includes("REPO LOCAL RULES"), "stale content gone");
  } finally {
    repo.cleanup();
  }
});
