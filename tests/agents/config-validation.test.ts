import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  configuredAgentKeys,
  findUnknownAgents,
  findUnknownAgentWorkspaces,
  findUnknownScopeEntries,
  type MyClawConfig,
} from "../../src/core/config.ts";

function config(agents: Record<string, unknown>, workspaces?: Record<string, string>): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: { provider: "t", baseUrl: "u", model: "m" },
    agents,
    ...(workspaces ? { workspaces } : {}),
  } as MyClawConfig;
}

test("nested is never mistaken for an agent", () => {
  // It shares the `agents` namespace without being one, which is also why a file cannot be named it.
  assert.deepEqual(configuredAgentKeys(config({ nested: { enabled: false }, general: {} })), ["general"]);
  assert.deepEqual(findUnknownAgents(config({ nested: { enabled: false } }), []), []);
});

test("a config section for an agent nobody defines is reported", () => {
  // Config is an override layer: without a file or a role, the section is read by nothing.
  assert.deepEqual(findUnknownAgents(config({ reviewer: { maxIterations: 5 } }), []), ["reviewer"]);
  assert.deepEqual(findUnknownAgents(config({ reviewer: { maxIterations: 5 } }), ["reviewer"]), []);
});

test("the reserved roles never need a file to be valid config targets", () => {
  assert.deepEqual(findUnknownAgents(config({ orchestrator: {}, cron: {} }), []), []);
});

test("a scope typo under a file-defined agent is reported, not just under the roles", () => {
  // The check used to iterate the four reserved keys, so anything under `agents.reviewer` was
  // invisible: the agent quietly lost the skill and nothing said why.
  const entries = findUnknownScopeEntries(
    config({ reviewer: { skills: ["ghost"], mcp: ["nowhere"] } }),
    { skills: ["real"], mcpServers: ["srv"] },
  );
  assert.deepEqual(entries.map((e) => e.path).sort(), ["agents.reviewer.mcp", "agents.reviewer.skills"]);
});

test("a workspace typo under a file-defined agent is reported too", () => {
  const found = findUnknownAgentWorkspaces(config({ reviewer: { workspace: "nope" } }, { proj: "/p" }));
  assert.deepEqual(found, [{ path: "agents.reviewer.workspace", key: "nope" }]);
  assert.deepEqual(findUnknownAgentWorkspaces(config({ reviewer: { workspace: "proj" } }, { proj: "/p" })), []);
});

test("a config that predates file agents still validates clean", () => {
  // The upgrade path: general and research were config keys, they are now files, and an existing
  // entry for either must keep working without being flagged.
  const legacy = config({
    orchestrator: { llm: { defaultModel: "a" } },
    general: { skills: ["real"] },
    research: { mcp: ["srv"] },
    cron: { llm: { defaultModel: "b" } },
  });
  assert.deepEqual(findUnknownAgents(legacy, ["general", "research"]), []);
  assert.deepEqual(findUnknownScopeEntries(legacy, { skills: ["real"], mcpServers: ["srv"] }), []);
});
