import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  isMyClawAppChannelEnabled,
  resolveMaxIterations,
  resolveAgentSkills,
  resolveAgentMcp,
  scopeAllows,
  findUnknownScopeEntries,
  providerRetryDelays,
  readConfigFromDisk,
  loadConfig,
  MY_CLAW_DIR,
  CONFIG_PATH,
  DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  type MyClawConfig,
} from "../src/core/config.ts";

function createConfig(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      provider: "test",
      baseUrl: "https://example.com",
      model: "test-model",
    },
    agents: {},
  };
}

test("the channel helper defaults to enabled when the channel config exists", () => {
  const config = createConfig();
  config.channels["my-claw-app"] = { port: 8080 };

  assert.equal(isMyClawAppChannelEnabled(config), true);
});

test("the channel helper disables the channel when enabled is false", () => {
  const config = createConfig();
  config.channels["my-claw-app"] = { enabled: false, port: 8080 };

  assert.equal(isMyClawAppChannelEnabled(config), false);
});

test("the channel helper disables a missing channel", () => {
  const config = createConfig();

  assert.equal(isMyClawAppChannelEnabled(config), false);
});

test("resolveMaxIterations returns orchestrator default", () => {
  const config = createConfig();
  assert.equal(resolveMaxIterations(config, "orchestrator"), DEFAULT_ORCHESTRATOR_MAX_ITERATIONS);
});

test("resolveMaxIterations returns subagent default for general", () => {
  const config = createConfig();
  assert.equal(resolveMaxIterations(config, "general"), DEFAULT_SUBAGENT_MAX_ITERATIONS);
});

test("resolveMaxIterations returns subagent default for research", () => {
  const config = createConfig();
  assert.equal(resolveMaxIterations(config, "research"), DEFAULT_SUBAGENT_MAX_ITERATIONS);
});

test("resolveMaxIterations returns custom orchestrator value", () => {
  const config = createConfig();
  config.agents = { orchestrator: { maxIterations: 120 } };
  assert.equal(resolveMaxIterations(config, "orchestrator"), 120);
});

test("resolveMaxIterations returns custom general value", () => {
  const config = createConfig();
  config.agents = { general: { maxIterations: 30 } };
  assert.equal(resolveMaxIterations(config, "general"), 30);
});

test("resolveMaxIterations falls back to default for zero/negative/NaN", () => {
  const config = createConfig();

  config.agents = { orchestrator: { maxIterations: 0 } };
  assert.equal(resolveMaxIterations(config, "orchestrator"), DEFAULT_ORCHESTRATOR_MAX_ITERATIONS);

  config.agents = { general: { maxIterations: -5 } };
  assert.equal(resolveMaxIterations(config, "general"), DEFAULT_SUBAGENT_MAX_ITERATIONS);

  config.agents = { research: { maxIterations: NaN } };
  assert.equal(resolveMaxIterations(config, "research"), DEFAULT_SUBAGENT_MAX_ITERATIONS);
});

test("resolveMaxIterations returns defaults when agents config is empty", () => {
  const config = createConfig();
  config.agents = {};
  assert.equal(resolveMaxIterations(config, "orchestrator"), DEFAULT_ORCHESTRATOR_MAX_ITERATIONS);
  assert.equal(resolveMaxIterations(config, "general"), DEFAULT_SUBAGENT_MAX_ITERATIONS);
  assert.equal(resolveMaxIterations(config, "research"), DEFAULT_SUBAGENT_MAX_ITERATIONS);
});

// ── .env hot-reload of secrets ───────────────────────────────────────────────

const ENV_PATH = join(MY_CLAW_DIR, ".env");
const MIN_CONFIG = JSON.stringify({
  whitelist: [], blacklist: [], channels: {},
  llm: { provider: "p", baseUrl: "https://e.com", model: "m" }, agents: {},
});

test("readConfigFromDisk force-refreshes a rotated secret from .env", async () => {
  const key = "TEST_HOTRELOAD_SECRET";
  writeFileSync(CONFIG_PATH, MIN_CONFIG);
  writeFileSync(ENV_PATH, `${key}=first\n`);
  try {
    delete process.env[key];
    await readConfigFromDisk();
    assert.equal(process.env[key], "first");
    // Rotate the file: a hot reload must overwrite the stale in-memory value,
    // otherwise a rotated OAuth token survives until the next process restart.
    writeFileSync(ENV_PATH, `${key}=second\n`);
    await readConfigFromDisk();
    assert.equal(process.env[key], "second");
  } finally {
    delete process.env[key];
    rmSync(ENV_PATH, { force: true });
    rmSync(CONFIG_PATH, { force: true });
  }
});

test("loadConfig (boot) keeps an env var already set by the shell/systemd", async () => {
  const key = "TEST_HOTRELOAD_BOOT";
  writeFileSync(CONFIG_PATH, MIN_CONFIG);
  writeFileSync(ENV_PATH, `${key}=from-file\n`);
  try {
    process.env[key] = "from-shell";
    await loadConfig();
    assert.equal(process.env[key], "from-shell", "boot must not let .env override the live env");
  } finally {
    delete process.env[key];
    rmSync(ENV_PATH, { force: true });
    rmSync(CONFIG_PATH, { force: true });
  }
});

// --- Agent scoping (docs/agent-scoping.md) ---

const withAgents = (agents: MyClawConfig["agents"]): MyClawConfig => ({ ...createConfig(), agents });

test("scope: no config at all leaves every agent unrestricted", () => {
  // Installing the feature must change nothing until the owner asks for it.
  const config = createConfig();
  for (const type of ["main", "general", "research", "cron"] as const) {
    assert.equal(resolveAgentSkills(config, type), "all");
  }
  assert.equal(resolveAgentMcp(config, "main"), "all");
  assert.equal(resolveAgentMcp(config, "general"), "all");
  assert.equal(resolveAgentMcp(config, "cron"), "all");
});

test("scope: an absent field inherits the orchestrator", () => {
  const config = withAgents({ orchestrator: { skills: ["a", "b"], mcp: ["srv"] }, general: {} });
  assert.deepEqual(resolveAgentSkills(config, "general"), ["a", "b"]);
  assert.deepEqual(resolveAgentMcp(config, "general"), ["srv"]);
});

test("scope: an own field wins over the orchestrator", () => {
  const config = withAgents({ orchestrator: { skills: ["a"] }, general: { skills: ["b"] } });
  assert.deepEqual(resolveAgentSkills(config, "general"), ["b"]);
});

test("scope: an empty array means none and is never read as absent", () => {
  // Branching on length would treat [] as unset and grant everything to an agent meant to have
  // nothing, which is the exact opposite of the request.
  const config = withAgents({ orchestrator: { skills: ["a"], mcp: ["srv"] }, general: { skills: [], mcp: [] } });
  assert.deepEqual(resolveAgentSkills(config, "general"), []);
  assert.deepEqual(resolveAgentMcp(config, "general"), []);
  assert.equal(scopeAllows(resolveAgentSkills(config, "general"), "a"), false);
});

test("scope: the wildcard entry means all", () => {
  const config = withAgents({ orchestrator: { skills: ["*"] }, general: { mcp: ["srv", "*"] } });
  assert.equal(resolveAgentSkills(config, "main"), "all");
  assert.equal(resolveAgentMcp(config, "general"), "all");
});

test("scope: the orchestrator restricts itself, not only its children", () => {
  const config = withAgents({ orchestrator: { skills: ["a"] } });
  assert.deepEqual(resolveAgentSkills(config, "main"), ["a"]);
  assert.equal(scopeAllows(resolveAgentSkills(config, "main"), "b"), false);
});

test("scope: research.mcp absent is none, not inherited", () => {
  // The single override of the inheritance rule: research had zero MCP before this existed, so
  // inheriting ["*"] would widen it on upgrade with nobody asking.
  const config = withAgents({ orchestrator: { mcp: ["*"] }, research: {} });
  assert.deepEqual(resolveAgentMcp(config, "research"), []);
  // Skills are not affected by the override: research saw the full catalog before.
  assert.equal(resolveAgentSkills(config, "research"), "all");
});

test("scope: research.mcp explicitly set is honoured", () => {
  const config = withAgents({ research: { mcp: ["srv"] } });
  assert.deepEqual(resolveAgentMcp(config, "research"), ["srv"]);
  const all = withAgents({ research: { mcp: ["*"] } });
  assert.equal(resolveAgentMcp(all, "research"), "all");
});

test("scope: cron maps to the orchestrator on both axes", () => {
  const config = withAgents({ orchestrator: { skills: ["a"], mcp: ["srv"] } });
  assert.deepEqual(resolveAgentSkills(config, "cron"), ["a"]);
  assert.deepEqual(resolveAgentMcp(config, "cron"), ["srv"]);
});

test("scopeAllows: all admits anything, a list admits only its members", () => {
  assert.equal(scopeAllows("all", "whatever"), true);
  assert.equal(scopeAllows(["a"], "a"), true);
  assert.equal(scopeAllows(["a"], "b"), false);
  assert.equal(scopeAllows([], "a"), false);
});

test("scope validation: reports names matching nothing, per config path", () => {
  const config = withAgents({
    orchestrator: { skills: ["real"] },
    general: { skills: ["real", "typo"], mcp: ["srv", "ghost"] },
  });
  const found = findUnknownScopeEntries(config, { skills: ["real"], mcpServers: ["srv"] });
  assert.deepEqual(found, [
    { path: "agents.general.skills", name: "typo", kind: "skill" },
    { path: "agents.general.mcp", name: "ghost", kind: "mcp" },
  ]);
});

test("scope validation: a valid config and a wildcard produce nothing", () => {
  const clean = withAgents({ general: { skills: ["real"], mcp: ["srv"] } });
  assert.deepEqual(findUnknownScopeEntries(clean, { skills: ["real"], mcpServers: ["srv"] }), []);
  // The wildcard is not a name to look up.
  const wild = withAgents({ general: { skills: ["*"], mcp: ["*"] } });
  assert.deepEqual(findUnknownScopeEntries(wild, { skills: [], mcpServers: [] }), []);
  assert.deepEqual(findUnknownScopeEntries(createConfig(), { skills: [], mcpServers: [] }), []);
});

test("scope validation: an empty list has nothing to report", () => {
  const config = withAgents({ research: { skills: [], mcp: [] } });
  assert.deepEqual(findUnknownScopeEntries(config, { skills: ["real"], mcpServers: ["srv"] }), []);
});

test("the retry schedule is on by default, off only when it was turned off", () => {
  assert.deepEqual(providerRetryDelays(undefined), [30_000, 60_000, 120_000]);
  assert.deepEqual(providerRetryDelays({}), [30_000, 60_000, 120_000]);
  assert.deepEqual(providerRetryDelays({ providerRetry: { enabled: false } }), []);
  // `enabled: false` wins over a declared schedule: the switch is the decision, the list is a
  // detail of it.
  assert.deepEqual(providerRetryDelays({ providerRetry: { enabled: false, delaysMs: [1] } }), []);
});

test("a declared schedule is used as given, and junk is dropped rather than waited on", () => {
  assert.deepEqual(providerRetryDelays({ providerRetry: { delaysMs: [1000, 2000] } }), [1000, 2000]);
  assert.deepEqual(providerRetryDelays({ providerRetry: { delaysMs: [1000, 0, -5, Number.NaN] } }), [1000]);
  assert.deepEqual(providerRetryDelays({ providerRetry: { delaysMs: [] } }), []);
});
