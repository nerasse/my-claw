import { test } from "bun:test";
import assert from "node:assert/strict";
import { producesRemoteContent } from "../../src/tools/registry.ts";

test("remote-content tools are classified for normalisation", () => {
  for (const name of [
    "fetch",
    "web_search",
    "delegate_browser_task",
    "browser_click",
    "browser_snapshot",
    "mcp__atlassian__search",
  ]) {
    assert.equal(producesRemoteContent(name), true, `should be normalised: ${name}`);
  }
});

test("local file tools are excluded, so an edit round-trip cannot silently drop characters", () => {
  // The deliberate line: the agent must see a local file exactly as it is. Normalising `read`
  // would let it rewrite the file without invisible characters the owner put there on purpose.
  for (const name of ["read", "search", "ls", "bash", "write", "memory", "spawn"]) {
    assert.equal(producesRemoteContent(name), false, `must stay verbatim: ${name}`);
  }
});

// End to end through the home loop: the classification above is only useful if the bridge actually
// applies it. Before this, tool results reached the model verbatim and only the SDK *replay* path
// normalised them -- so a fetched page carrying Unicode tag characters arrived intact on the very
// pass that mattered.

import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
};

function message(): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm",
    text: "go", attachments: [], isForwarded: false, raw: {},
  };
}

function session(): LegacySessionData {
  return {
    id: "telegram/dm/u1", platform: "my-claw-app", chatType: "dm",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [],
  };
}

/** Runs one tool call and returns the tool message the model was given. */
async function toolMessageFor(toolName: string, output: string): Promise<string> {
  const registry = new ToolRegistry();
  registry.register({
    name: toolName,
    description: toolName,
    parameters: {},
    async execute() { return { success: true, output }; },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_url, init) => {
    bodies.push(JSON.parse(String((init as { body?: string }).body ?? "{}")));
    call++;
    const payload = call === 1
      ? { choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: toolName, arguments: "{}" } }] } }] }
      : { choices: [{ message: { content: "ok" } }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
  });
  try {
    await bridge.handleMessage(message(), session());
    const toolMsg = (bodies[1]?.messages ?? []).filter((m) => m.role === "tool").at(-1);
    return typeof toolMsg?.content === "string" ? toolMsg.content : "";
  } finally {
    mock.restore();
  }
}

test("a fetch result is normalised before the model sees it", async () => {
  const hidden = [..."evil"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  const content = await toolMessageFor("fetch", `Prices 2026${hidden}`);
  assert.equal(content, "Prices 2026");
});

test("a read result reaches the model byte for byte", async () => {
  const raw = "const a = 1;\u200b // trailing zero-width";
  const content = await toolMessageFor("read", raw);
  assert.equal(content, raw);
});
