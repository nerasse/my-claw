import test from "node:test";
import assert from "node:assert/strict";
import {
  isMatrixChannelEnabled,
  isTelegramChannelEnabled,
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
