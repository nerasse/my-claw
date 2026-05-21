import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  isMatrixChannelEnabled,
  isTelegramChannelEnabled,
  resolveMaxIterations,
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
