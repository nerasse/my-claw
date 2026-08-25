import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {}, memory: { enabled: false },
  };
}
function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}
function session(id: string): LegacySessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}
function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

// A git repo with a nested AGENTS.md, outside the test workspace, that a tool call touches.
function makeRepo(): { dir: string; file: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "bridge-nested-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "REPO LOCAL RULES", "utf-8");
  writeFileSync(join(repo, "f.ts"), "x", "utf-8");
  return { dir: repo, file: join(repo, "f.ts"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// Drive the LLM: call the `read` tool once (touching the repo file), then finish. Return the
// tool-role message content seen by the second LLM call.
async function runAndCaptureToolMessage(config: MyClawConfig, file: string): Promise<string> {
  runRegistry.clear();
  const reg = new ToolRegistry();
  reg.register({ name: "read", description: "read", parameters: {}, async execute() { return { success: true, output: "file body" }; } });
  const bridge = new AgentBridge(config, reg, new SkillRegistry());
  const sess = session("telegram/dm/u1");
  const { signal, end } = runRegistry.startRoot(sess.id);

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    call++;
    if (call === 1) {
      return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "read", arguments: JSON.stringify({ path: file }) } }] });
    }
    return llm({ content: "done" });
  });

  try {
    await bridge.handleMessage(msg("orig", "read that file"), sess, signal);
    const toolMsg = bodies[1]?.messages.find((m) => m.role === "tool");
    return typeof toolMsg?.content === "string" ? toolMsg.content : "";
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
}

test("bridge: nested AGENTS.md is appended to the tool result the LLM sees", async () => {
  const repo = makeRepo();
  try {
    const toolContent = await runAndCaptureToolMessage(baseConfig(), repo.file);
    assert.ok(toolContent.includes("file body"), "original tool output preserved");
    assert.ok(toolContent.includes("REPO LOCAL RULES"), "nested AGENTS.md injected");
    assert.ok(toolContent.includes("Local project instructions"), "precedence note present");
  } finally {
    repo.cleanup();
  }
});

test("bridge: agents.nested.enabled=false disables discovery", async () => {
  const repo = makeRepo();
  try {
    const config = baseConfig();
    config.agents.nested = { enabled: false };
    const toolContent = await runAndCaptureToolMessage(config, repo.file);
    assert.ok(toolContent.includes("file body"), "tool output still there");
    assert.ok(!toolContent.includes("REPO LOCAL RULES"), "no nested injection when disabled");
  } finally {
    repo.cleanup();
  }
});
