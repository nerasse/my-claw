import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { BrowserSubagent, detectHumanBlocker } from "../../src/agent/subagents/browser.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

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

  test("run sends tools in OpenAI format", async () => {
    let requestBody: Record<string, unknown> | null = null;

    const fetchMock = mockFetch(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      requestBody = body;

      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Done. Task complete." } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("test task", "https://example.com");
      assert.ok(result.success);

      assert.ok(requestBody, "Request body should have been captured");
      const tools = requestBody.tools as Array<Record<string, unknown>> | undefined;
      assert.ok(tools, "Tools should be present in request body");
      assert.equal(tools.length, 8, "Should have 8 browser tools");

      for (const tool of tools) {
        assert.equal(tool.type, "function", "Each tool must have type 'function'");
        assert.ok(tool.function, "Each tool must have a 'function' object");
        const fn = tool.function as Record<string, unknown>;
        assert.ok(typeof fn.name === "string", "function.name must be a string");
        assert.ok(typeof fn.description === "string", "function.description must be a string");
        assert.ok(fn.parameters, "function.parameters must be present");
      }
    } finally {
      fetchMock.restore();
    }
  });

  test("run handles LLM error gracefully", async () => {
    const fetchMock = mockFetch(async () => {
      return new Response(
        JSON.stringify({ error: "bad request" }),
        { status: 400 },
      ) as never;
    });

    try {
      const result = await subagent.run("test task");
      assert.equal(result.success, false);
      assert.ok(result.hint, "Should provide a hint on failure");
    } finally {
      fetchMock.restore();
    }
  });

  afterEach(async () => {
    await subagent.cleanup().catch(() => undefined);
  });
});
