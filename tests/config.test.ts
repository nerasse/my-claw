import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  isMatrixChannelEnabled,
  isTelegramChannelEnabled,
  resolveMaxIterations,
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

test("channel helpers default to enabled when channel config exists", () => {
  const config = createConfig();
  config.channels.telegram = { token: "telegram-token" };
  config.channels.matrix = {
    homeserver: "https://matrix.example.com",
    accessToken: "matrix-token",
  };

  assert.equal(isTelegramChannelEnabled(config), true);
  assert.equal(isMatrixChannelEnabled(config), true);
});

test("channel helpers disable channels when enabled is false", () => {
  const config = createConfig();
  config.channels.telegram = { enabled: false, token: "telegram-token" };
  config.channels.matrix = {
    enabled: false,
    homeserver: "https://matrix.example.com",
    accessToken: "matrix-token",
  };

  assert.equal(isTelegramChannelEnabled(config), false);
  assert.equal(isMatrixChannelEnabled(config), false);
});

test("channel helpers disable missing channels", () => {
  const config = createConfig();

  assert.equal(isTelegramChannelEnabled(config), false);
  assert.equal(isMatrixChannelEnabled(config), false);
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
