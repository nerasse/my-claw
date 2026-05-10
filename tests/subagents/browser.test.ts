import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert";
import { BrowserSubagent, detectHumanBlocker } from "../../src/agent/subagents/browser.ts";

describe("BrowserSubagent", () => {
  let subagent: BrowserSubagent;

  beforeEach(() => {
    const config = {
      whitelist: [],
      blacklist: [],
      channels: {},
      llm: { provider: "test", baseUrl: "http://test", model: "test" },
    };
    subagent = new BrowserSubagent(config as any, "http://127.0.0.1:9222");
  });

  test("detects human blocker keywords", () => {
    assert.ok(detectHumanBlocker("Please complete the captcha"));
    assert.ok(detectHumanBlocker("Enter your password to login"));
    assert.ok(detectHumanBlocker("2FA code required"));
    assert.ok(!detectHumanBlocker("Here is the search result"));
  });
});
