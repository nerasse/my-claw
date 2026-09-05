import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { BrowserSubagent, isBrowserInfraError } from "../../src/agent/subagents/browser.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { Tool } from "../../src/tools/types.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Loose fetch shape for the test mock: the code under test only ever calls the
// usual (input, init) signature and awaits a Response.
type FetchImpl = (input?: string | URL | Request, init?: RequestInit) => Promise<Response>;

// The subagent now talks to the browser sidecar (session/tabs/cleanup) around the
// LLM loop. Route those calls to sidecar-shaped responses so the LLM mock (and its
// call counters) only ever sees actual LLM requests.
function mockLlm(impl: FetchImpl): { restore(): void } {
  return mockFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("127.0.0.1:9222")) {
      if (url.endsWith("/session")) return new Response(JSON.stringify({ sessionId: "test-session" }), { status: 200 });
      if (url.endsWith("/tabs")) return new Response(JSON.stringify({ tabs: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return impl(input as never, init as never);
  }) as FetchImpl);
}

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test" },
    ...overrides,
  };
}

describe("BrowserSubagent", () => {
  let subagent: BrowserSubagent;

  beforeEach(() => {
    subagent = new BrowserSubagent(makeConfig() as any, "http://127.0.0.1:9222");
  });

  test("run sends tools in OpenAI format", async () => {
    let requestBody: Record<string, unknown> | null = null;

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      requestBody = body;

      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Task complete."}' } }],
            },
          }],
        }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("test task", "https://example.com");
      assert.ok(result.success);

      assert.ok(requestBody, "Request body should have been captured");
      const tools = (requestBody as Record<string, unknown>).tools as Array<Record<string, unknown>> | undefined;
      assert.ok(tools, "Tools should be present in request body");
      assert.equal(tools.length, 23, "Should have 23 browser tools (22 + browser_done)");
      const names = tools.map((t) => (t.function as Record<string, unknown>).name);
      for (const expected of [
        "browser_find",
        "browser_network",
        "browser_response",
        "browser_select_option",
        "browser_upload_file",
        "browser_press_key",
        "browser_scroll",
        "browser_hover",
        "browser_drag",
        "browser_click_at",
        "browser_wait_for",
        "browser_handle_dialog",
        "browser_download",
        "browser_pdf",
      ]) {
        assert.ok(names.includes(expected), `${expected} must be exposed to the subagent`);
      }
      // Off by default: an advertised but disabled tool costs a wasted step.
      assert.ok(!names.includes("browser_eval"), "browser_eval must stay hidden unless allowed");
      assert.ok(!names.includes("browser_cdp"), "browser_cdp must stay hidden unless allowed");

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

  test("a tools.disabled tool cannot be run by naming it", async () => {
    // The lookup used to hit the whole private registry, so a hallucinated name executed a tool the
    // denylist had already removed from the set the model was offered.
    const gated = new BrowserSubagent(
      makeConfig({ tools: { disabled: ["browser_navigate"] } }) as never,
      "http://127.0.0.1:9222",
    );
    let offered: string[] = [];
    let toolResult = "";
    let call = 0;
    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as {
        tools?: Array<{ function: { name: string } }>;
        messages?: Array<{ role: string; content?: unknown }>;
      };
      if (call === 0) offered = (body.tools ?? []).map((t) => t.function.name);
      // The refusal (or the navigation output) comes back as the tool message of the next turn.
      // Asserting on the turn count alone would pass either way, since the loop continues regardless.
      if (call === 1) {
        const last = (body.messages ?? []).filter((m) => m.role === "tool").at(-1);
        toolResult = typeof last?.content === "string" ? last.content : "";
      }
      call++;
      const tc = call === 1
        ? { id: "tc1", function: { name: "browser_navigate", arguments: '{"url":"https://example.com"}' } }
        : { id: "tc2", function: { name: "browser_done", arguments: '{"summary":"done"}' } };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [tc] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await gated.run("test task", "https://example.com");
      assert.ok(!offered.includes("browser_navigate"), "the denylisted tool must not be offered");
      assert.match(toolResult, /not found/, "the denylisted tool must be refused, not executed");
      assert.ok(result.summary.length > 0);
    } finally {
      fetchMock.restore();
    }
  });

  test("allowEval and allowCdp register the low-level tools and document them", async () => {
    const gated = new BrowserSubagent(
      makeConfig({ browser: { allowEval: true, allowCdp: true } }) as never,
      "http://127.0.0.1:9222",
    );
    let requestBody: Record<string, unknown> | null = null;
    const fetchMock = mockLlm(async (_input, init) => {
      requestBody = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"done"}' } }],
            },
          }],
        }),
        { status: 200 },
      ) as never;
    });

    try {
      await gated.run("test task", "https://example.com");
      const body = requestBody as unknown as Record<string, unknown>;
      const tools = body.tools as Array<Record<string, unknown>>;
      const names = tools.map((t) => (t.function as Record<string, unknown>).name);
      assert.ok(names.includes("browser_eval"), "browser_eval must appear when allowed");
      assert.ok(names.includes("browser_cdp"), "browser_cdp must appear when allowed");
      assert.equal(tools.length, 25, "the two gated tools add to the default set");

      const messages = body.messages as Array<{ role: string; content: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      assert.ok(system.includes("browser_eval(js)"), "the prompt must document the gated tools");
    } finally {
      fetchMock.restore();
      await gated.cleanup().catch(() => undefined);
    }
  });

  test("run handles LLM error gracefully", async () => {
    const fetchMock = mockLlm(async () => {
      return new Response(
        JSON.stringify({ error: "bad request" }),
        { status: 400 },
      ) as never;
    });

    try {
      const result = await subagent.run("test task");
      assert.equal(result.success, false);
      assert.equal(result.needs_human, false, "Technical LLM failure is not a human handoff");
      assert.ok(result.summary.includes("LLM call failed"), "Should explain the failure in summary");
    } finally {
      fetchMock.restore();
    }
  });

  test("accumulates attachments from tool results", async () => {
    const mockAttachment = { type: "image" as const, path: "/tmp/test-screenshot.png", mimeType: "image/png" };
    const testTool: Tool = {
      name: "test_screenshot",
      description: "mock screenshot",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Screenshot captured.", attachments: [mockAttachment] };
      },
    };
    subagent["toolRegistry"].register(testTool);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;
      const hasTestTool = tools?.some((t) => t.function.name === "test_screenshot");

      if (hasTestTool) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [
                  { id: "tc1", function: { name: "test_screenshot", arguments: "{}" } },
                  { id: "tc2", function: { name: "browser_done", arguments: '{"summary":"Done."}' } },
                ],
              },
            }],
          }),
          { status: 200 },
        ) as never;
      }

      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc_done", function: { name: "browser_done", arguments: '{"summary":"Fallback done."}' } }],
            },
          }],
        }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("screenshot test", "https://example.com");
      assert.ok(result.success);
      assert.ok(result.attachments, "Result should have attachments");
      assert.equal(result.attachments.length, 1, "Should have 1 attachment");
      assert.equal(result.attachments[0]!.type, "image");
      assert.equal(result.attachments[0]!.path, "/tmp/test-screenshot.png");
    } finally {
      fetchMock.restore();
    }
  });

  test("returns empty attachments when no tools produce them", async () => {
    const fetchMock = mockLlm(async () => {
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }],
            },
          }],
        }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("test task");
      assert.ok(result.success);
      assert.deepEqual(result.attachments, []);
    } finally {
      fetchMock.restore();
    }
  });

  test("system prompt includes all 9 tool names", async () => {
    let systemMessage = "";

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const messages = body.messages as Array<{ role: string; content: string }>;
      const sys = messages.find((m) => m.role === "system");
      if (sys) systemMessage = sys.content;

      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }],
            },
          }],
        }),
        { status: 200 },
      ) as never;
    });

    try {
      await subagent.run("test task");

      const expectedTools = [
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_screenshot",
        "browser_list_tabs",
        "browser_focus_tab",
        "browser_close_tab",
        "browser_done",
      ];
      for (const name of expectedTools) {
        assert.ok(systemMessage.includes(name), `Prompt should include tool: ${name}`);
      }
    } finally {
      fetchMock.restore();
    }
  });

  test("system prompt includes CORE_PROMPT directives", async () => {
    let systemMessage = "";

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const messages = body.messages as Array<{ role: string; content: string }>;
      const sys = messages.find((m) => m.role === "system");
      if (sys) systemMessage = sys.content;

      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }],
            },
          }],
        }),
        { status: 200 },
      ) as never;
    });

    try {
      await subagent.run("test task");

      assert.ok(systemMessage.includes("Core Directives"), "Prompt should include Core Directives header");
      assert.ok(systemMessage.includes("no independent goals"), "Prompt should include safety directive");
      assert.ok(systemMessage.includes("Prioritize safety over completion"), "Prompt include safety priority");
    } finally {
      fetchMock.restore();
    }
  });

  test("system prompt includes SOUL.md and USER.md from workspace", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "myclaw-test-"));
    const origEnv = process.env["MY_CLAW_WORKSPACE"];
    process.env["MY_CLAW_WORKSPACE"] = tmpDir;

    try {
      await writeFile(join(tmpDir, "SOUL.md"), "# Test Soul\nYou are a test soul.", "utf-8");
      await writeFile(join(tmpDir, "USER.md"), "# Test User\nName: TestUser", "utf-8");

      const freshSubagent = new BrowserSubagent(makeConfig() as any, "http://127.0.0.1:9222");
      let systemMessage = "";

      const fetchMock = mockLlm(async (_input, init) => {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const sys = messages.find((m) => m.role === "system");
        if (sys) systemMessage = sys.content;

        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }],
              },
            }],
          }),
          { status: 200 },
        ) as never;
      });

      try {
        await freshSubagent.run("test task");

        assert.ok(systemMessage.includes("Test Soul"), "Prompt should include SOUL.md content");
        assert.ok(systemMessage.includes("Test User"), "Prompt should include USER.md content");
      } finally {
        fetchMock.restore();
        await freshSubagent.cleanup().catch(() => undefined);
      }
    } finally {
      if (origEnv !== undefined) {
        process.env["MY_CLAW_WORKSPACE"] = origEnv;
      } else {
        delete process.env["MY_CLAW_WORKSPACE"];
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("system prompt does NOT include AGENTS.md", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "myclaw-test-"));
    const origEnv = process.env["MY_CLAW_WORKSPACE"];
    process.env["MY_CLAW_WORKSPACE"] = tmpDir;

    try {
      await writeFile(join(tmpDir, "AGENTS.md"), "# Agent Rules\nAlways use trash over rm.", "utf-8");

      const freshSubagent = new BrowserSubagent(makeConfig() as any, "http://127.0.0.1:9222");
      let systemMessage = "";

      const fetchMock = mockLlm(async (_input, init) => {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const sys = messages.find((m) => m.role === "system");
        if (sys) systemMessage = sys.content;

        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }],
              },
            }],
          }),
          { status: 200 },
        ) as never;
      });

      try {
        await freshSubagent.run("test task");

        assert.ok(!systemMessage.includes("trash over rm"), "Prompt should NOT include AGENTS.md content");
      } finally {
        fetchMock.restore();
        await freshSubagent.cleanup().catch(() => undefined);
      }
    } finally {
      if (origEnv !== undefined) {
        process.env["MY_CLAW_WORKSPACE"] = origEnv;
      } else {
        delete process.env["MY_CLAW_WORKSPACE"];
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("SOUL.md is normalised before the sub-agent prompt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "myclaw-test-"));
    const origEnv = process.env["MY_CLAW_WORKSPACE"];
    process.env["MY_CLAW_WORKSPACE"] = tmpDir;

    try {
      await writeFile(join(tmpDir, "SOUL.md"), "Be me\u200bthodical.", "utf-8");

      const freshSubagent = new BrowserSubagent(makeConfig() as any, "http://127.0.0.1:9222");
      let systemMessage = "";

      const fetchMock = mockLlm(async (_input, init) => {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const sys = messages.find((m) => m.role === "system");
        if (sys) systemMessage = sys.content;

        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }],
              },
            }],
          }),
          { status: 200 },
        ) as never;
      });

      try {
        await freshSubagent.run("test task");

        assert.ok(systemMessage.includes("Be methodical."), "workspace file reaches the sub-agent prompt");
        assert.ok(!systemMessage.includes("\u200b"), "invisible character stripped");
        assert.ok(!systemMessage.includes("Ignore previous instructions"), "Injection text should be replaced");
      } finally {
        fetchMock.restore();
        await freshSubagent.cleanup().catch(() => undefined);
      }
    } finally {
      if (origEnv !== undefined) {
        process.env["MY_CLAW_WORKSPACE"] = origEnv;
      } else {
        delete process.env["MY_CLAW_WORKSPACE"];
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("accumulates multiple attachments from a single step", async () => {
    const att1 = { type: "image" as const, path: "/tmp/shot1.png", mimeType: "image/png" };
    const att2 = { type: "image" as const, path: "/tmp/shot2.png", mimeType: "image/png" };
    const multiTool: Tool = {
      name: "multi_shot",
      description: "returns 2 attachments",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "two screenshots", attachments: [att1, att2] };
      },
    };
    subagent["toolRegistry"].register(multiTool);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;
      if (tools?.some((t) => t.function.name === "multi_shot")) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [
                  { id: "tc1", function: { name: "multi_shot", arguments: "{}" } },
                  { id: "tc2", function: { name: "browser_done", arguments: '{"summary":"Done."}' } },
                ],
              },
            }],
          }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc_d", function: { name: "browser_done", arguments: '{"summary":"fallback"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("multi test");
      assert.ok(result.success);
      assert.equal(result.attachments?.length, 2, "Should accumulate 2 attachments from one step");
    } finally {
      fetchMock.restore();
    }
  });

  test("accumulates attachments across multiple LLM steps", async () => {
    let step = 0;
    const stepTool: Tool = {
      name: "step_screenshot",
      description: "returns one attachment per call",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: `step ${step}`, attachments: [{ type: "image" as const, path: `/tmp/step-${step}.png`, mimeType: "image/png" }] };
      },
    };
    subagent["toolRegistry"].register(stepTool);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;
      step++;
      if (tools?.some((t) => t.function.name === "step_screenshot")) {
        if (step < 3) {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `tc${step}`, function: { name: "step_screenshot", arguments: "{}" } }] } }] }),
            { status: 200 },
          ) as never;
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `tc${step}`, function: { name: "step_screenshot", arguments: "{}" } }, { id: `tc${step}d`, function: { name: "browser_done", arguments: '{"summary":"3 steps"}' } }] } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc_d", function: { name: "browser_done", arguments: '{"summary":"fallback"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("multi step test");
      assert.ok(result.success);
      assert.equal(result.attachments?.length, 3, "Should accumulate 3 attachments across 3 steps");
    } finally {
      fetchMock.restore();
    }
  });

  test("LLM error includes attachments collected before the failure", async () => {
    let call = 0;
    const earlyTool: Tool = {
      name: "early_shot",
      description: "returns attachment",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "early", attachments: [{ type: "image" as const, path: "/tmp/before-error.png", mimeType: "image/png" }] };
      },
    };
    subagent["toolRegistry"].register(earlyTool);

    const fetchMock = mockLlm(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "early_shot", arguments: "{}" } }] } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }) as never;
    });

    try {
      const result = await subagent.run("error after screenshot");
      assert.equal(result.success, false);
      assert.ok(result.attachments, "Should have attachments even on error");
      assert.equal(result.attachments.length, 1, "Should have the 1 attachment from before the error");
      assert.equal(result.attachments[0]!.path, "/tmp/before-error.png");
    } finally {
      fetchMock.restore();
    }
  });

  test("browser_done with needs_human=true returns a handoff result", async () => {
    const fetchMock = mockLlm(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Cloudflare bot-check is blocking me","needs_human":true}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("blocked task");
      assert.equal(result.success, false);
      assert.equal(result.needs_human, true);
      assert.ok(result.summary.includes("Cloudflare"), "Summary should describe the blocker");
    } finally {
      fetchMock.restore();
    }
  });

  test("browser_done without needs_human is a normal success", async () => {
    const fetchMock = mockLlm(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"All done"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("normal task");
      assert.equal(result.success, true);
      assert.equal(result.needs_human, false);
      assert.equal(result.summary, "All done");
    } finally {
      fetchMock.restore();
    }
  });

  test("a login form alone does NOT trigger a handoff (no keyword false-positive)", async () => {
    let call = 0;
    const fetchMock = mockLlm(async () => {
      call++;
      if (call === 1) {
        // Page text mentions login/password/sign in — must NOT auto-stop
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "The page has a login form with a password field and a sign in button." } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Logged in and read the dashboard"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("login and read dashboard");
      assert.equal(result.success, true, "Login form must not auto-block");
      assert.equal(result.needs_human, false);
      assert.ok(call >= 2, "Subagent should keep going past the login page");
    } finally {
      fetchMock.restore();
    }
  });

  test("handoff path includes attachments collected before the handoff", async () => {
    const shotTool: Tool = {
      name: "pre_blocker_shot",
      description: "returns attachment",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "shot", attachments: [{ type: "image" as const, path: "/tmp/before-blocker.png", mimeType: "image/png" }] };
      },
    };
    subagent["toolRegistry"].register(shotTool);

    let call = 0;
    const fetchMock = mockLlm(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "pre_blocker_shot", arguments: "{}" } }] } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc2", function: { name: "browser_done", arguments: '{"summary":"captcha blocking","needs_human":true}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("handoff test");
      assert.equal(result.success, false);
      assert.equal(result.needs_human, true);
      assert.ok(result.attachments, "Should have attachments even on handoff");
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0]!.path, "/tmp/before-blocker.png");
    } finally {
      fetchMock.restore();
    }
  });

  test("max steps path includes attachments", async () => {
    const endlessTool: Tool = {
      name: "endless_shot",
      description: "returns attachment every time",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "shot", attachments: [{ type: "image" as const, path: "/tmp/endless.png", mimeType: "image/png" }] };
      },
    };
    subagent["toolRegistry"].register(endlessTool);

    const fetchMock = mockLlm(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "endless_shot", arguments: "{}" } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("endless test");
      assert.equal(result.success, false);
      assert.equal(result.needs_human, false, "Max steps is a failure, not a human handoff");
      assert.ok(result.summary.includes("maximum"), "Should mention max steps");
      assert.ok(result.attachments, "Should have attachments on max steps");
      assert.ok(result.attachments.length > 0, "Should have at least one attachment");
    } finally {
      fetchMock.restore();
    }
  });

  test("max steps salvages findings with a final tool-free summary call", async () => {
    const shortSubagent = new BrowserSubagent(
      makeConfig({ browser: { maxSteps: 2 } }) as any,
      "http://127.0.0.1:9222",
    );
    const busyTool: Tool = {
      name: "busy_tool",
      description: "keeps the loop busy",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Event X announced for July 12 at Club Y." };
      },
    };
    shortSubagent["toolRegistry"].register(busyTool);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      if (!body.tools) {
        // Tool-free call = the post-budget summarization pass.
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Found Event X on July 12 at Club Y; login wall blocked the rest." } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "busy_tool", arguments: "{}" } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await shortSubagent.run("find events");
      assert.equal(result.success, false);
      assert.ok(result.summary.includes("maximum"), "still flags the step budget");
      assert.ok(result.summary.includes("Findings so far"), "should carry the salvage prefix");
      assert.ok(result.summary.includes("Club Y"), "should include the salvaged findings");
    } finally {
      fetchMock.restore();
      await shortSubagent.cleanup().catch(() => undefined);
    }
  });

  test("max steps summary degrades cleanly when the final LLM call fails", async () => {
    const shortSubagent = new BrowserSubagent(
      makeConfig({ browser: { maxSteps: 1 } }) as any,
      "http://127.0.0.1:9222",
    );
    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      if (!body.tools) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "thinking..." } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await shortSubagent.run("find events");
      assert.equal(result.success, false);
      assert.ok(result.summary.includes("maximum"), "falls back to the plain max-steps message");
      assert.ok(!result.summary.includes("Findings so far"), "no salvage prefix without findings");
    } finally {
      fetchMock.restore();
      await shortSubagent.cleanup().catch(() => undefined);
    }
  });

  test("mixed tools: some with attachments, some without", async () => {
    const withAtt: Tool = {
      name: "with_att",
      description: "returns attachment",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "shot", attachments: [{ type: "image" as const, path: "/tmp/mixed.png", mimeType: "image/png" }] };
      },
    };
    const noAtt: Tool = {
      name: "no_att",
      description: "no attachment",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "text only" };
      },
    };
    subagent["toolRegistry"].register(withAtt);
    subagent["toolRegistry"].register(noAtt);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;
      if (tools?.some((t) => t.function.name === "with_att")) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [
                  { id: "tc1", function: { name: "with_att", arguments: "{}" } },
                  { id: "tc2", function: { name: "no_att", arguments: "{}" } },
                  { id: "tc3", function: { name: "browser_done", arguments: '{"summary":"mixed"}' } },
                ],
              },
            }],
          }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc_d", function: { name: "browser_done", arguments: '{"summary":"fallback"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("mixed test");
      assert.ok(result.success);
      assert.equal(result.attachments?.length, 1, "Should have only 1 attachment (from with_att, not no_att)");
    } finally {
      fetchMock.restore();
    }
  });

  test("empty workspace files produce a valid prompt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "myclaw-test-"));
    const origEnv = process.env["MY_CLAW_WORKSPACE"];
    process.env["MY_CLAW_WORKSPACE"] = tmpDir;

    try {
      await writeFile(join(tmpDir, "SOUL.md"), "", "utf-8");
      await writeFile(join(tmpDir, "USER.md"), "", "utf-8");

      const freshSubagent = new BrowserSubagent(makeConfig() as any, "http://127.0.0.1:9222");
      let systemMessage = "";

      const fetchMock = mockLlm(async (_input, init) => {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const sys = messages.find((m) => m.role === "system");
        if (sys) systemMessage = sys.content;

        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }] } }] }),
          { status: 200 },
        ) as never;
      });

      try {
        await freshSubagent.run("test task");
        assert.ok(systemMessage.includes("Core Directives"), "Prompt should still have CORE_PROMPT");
        assert.ok(systemMessage.includes("browser_navigate"), "Prompt should still have browser tools");
      } finally {
        fetchMock.restore();
        await freshSubagent.cleanup().catch(() => undefined);
      }
    } finally {
      if (origEnv !== undefined) {
        process.env["MY_CLAW_WORKSPACE"] = origEnv;
      } else {
        delete process.env["MY_CLAW_WORKSPACE"];
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("missing workspace files produce a valid prompt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "myclaw-test-"));
    const origEnv = process.env["MY_CLAW_WORKSPACE"];
    process.env["MY_CLAW_WORKSPACE"] = tmpDir;

    try {
      const freshSubagent = new BrowserSubagent(makeConfig() as any, "http://127.0.0.1:9222");
      let systemMessage = "";

      const fetchMock = mockLlm(async (_input, init) => {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const sys = messages.find((m) => m.role === "system");
        if (sys) systemMessage = sys.content;

        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }] } }] }),
          { status: 200 },
        ) as never;
      });

      try {
        await freshSubagent.run("test task");
        assert.ok(systemMessage.includes("Core Directives"), "Prompt should still have CORE_PROMPT");
        assert.ok(systemMessage.includes("browser_navigate"), "Prompt should still have browser tools");
      } finally {
        fetchMock.restore();
        await freshSubagent.cleanup().catch(() => undefined);
      }
    } finally {
      if (origEnv !== undefined) {
        process.env["MY_CLAW_WORKSPACE"] = origEnv;
      } else {
        delete process.env["MY_CLAW_WORKSPACE"];
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("delegate_browser_task description mentions screenshots", async () => {
    const { createDelegateBrowserTool } = await import("../../src/tools/browser/index.ts");
    const tool = createDelegateBrowserTool(makeConfig() as any);
    assert.ok(tool.description.toLowerCase().includes("screenshot"), "Description should mention screenshots");
    assert.ok(tool.description.toLowerCase().includes("attached"), "Description should mention attachments");
  });

  test("delegate_browser_task description tells the agent not to re-fetch screenshots", async () => {
    const { createDelegateBrowserTool } = await import("../../src/tools/browser/index.ts");
    const tool = createDelegateBrowserTool(makeConfig() as any);
    const desc = tool.description.toLowerCase();
    assert.ok(desc.includes("do not") || desc.includes("don't"), "Description should warn against manual handling");
    assert.ok(desc.includes("media:"), "Description should tell the agent not to use MEDIA: for auto-attached screenshots");
  });

  test("prompt mentions screenshot delivery to user", async () => {
    let systemMessage = "";

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const messages = body.messages as Array<{ role: string; content: string }>;
      const sys = messages.find((m) => m.role === "system");
      if (sys) systemMessage = sys.content;

      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "browser_done", arguments: '{"summary":"Done."}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      await subagent.run("test task");
      assert.ok(systemMessage.includes("delivered to the user"), "Prompt should mention screenshots are delivered to user");
    } finally {
      fetchMock.restore();
    }
  });

  test("open tabs are injected into the subagent system prompt with a reuse instruction", async () => {
    let systemMessage = "";
    const handle = mockFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("127.0.0.1:9222")) {
        if (url.endsWith("/session")) return new Response(JSON.stringify({ sessionId: "s" }), { status: 200 });
        if (url.endsWith("/tabs")) {
          return new Response(JSON.stringify({ tabs: [{ id: "0", url: "https://mail.google.com", title: "Inbox" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
      const sys = body.messages.find((m) => m.role === "system");
      if (sys) systemMessage = sys.content;
      return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "d", function: { name: "browser_done", arguments: '{"summary":"done"}' } }] } }] }), { status: 200 });
    }) as FetchImpl);

    try {
      await subagent.run("reuse tabs test");
      assert.ok(systemMessage.includes("Open browser tabs"), "prompt should list open tabs");
      assert.ok(systemMessage.includes("mail.google.com"), "prompt should include the open tab URL");
      assert.ok(systemMessage.toLowerCase().includes("reuse"), "prompt should instruct the agent to reuse tabs");
    } finally {
      handle.restore();
    }
  });

  test("isBrowserInfraError detects CDP failures but not page timeouts", () => {
    assert.ok(isBrowserInfraError("connect ECONNREFUSED 127.0.0.1:9222"));
    assert.ok(isBrowserInfraError("browserType.connectOverCDP: WebSocket error: connect ECONNREFUSED"));
    assert.ok(isBrowserInfraError("Target page, context or browser has been closed"));
    assert.ok(!isBrowserInfraError("Unknown pageId: abc123"), "a pruned/closed tab is a normal failure, not a sidecar outage");
    assert.ok(!isBrowserInfraError("Timeout 30000ms exceeded navigating to https://slow.example.com"), "a slow page is not an infra outage");
    assert.ok(!isBrowserInfraError("net::ERR_NAME_NOT_RESOLVED"), "a DNS failure of the target site is not a CDP outage");
    assert.ok(!isBrowserInfraError(undefined));
  });

  test("CDP connection failure returns a technical failure, not a human handoff", async () => {
    const infraTool: Tool = {
      name: "flaky_nav",
      description: "fails with a CDP connection error",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: false, output: "", error: "connect ECONNREFUSED 127.0.0.1:9222" };
      },
    };
    subagent["toolRegistry"].register(infraTool);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;
      if (tools?.some((t) => t.function.name === "flaky_nav")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "flaky_nav", arguments: "{}" } }] } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "d", function: { name: "browser_done", arguments: '{"summary":"x"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("infra test");
      assert.equal(result.success, false);
      assert.equal(result.needs_human, false, "infra failure must NOT be a human handoff");
      assert.ok(result.summary.toLowerCase().includes("infrastructure"), "summary should flag infra");
    } finally {
      fetchMock.restore();
    }
  });

  test("cleanup does NOT delete returned screenshot files (post-send owns them)", async () => {
    const tmpFile = join(tmpdir(), `myclaw-shot-${Date.now()}.png`);
    await writeFile(tmpFile, "fakepng", "utf-8");

    const shotTool: Tool = {
      name: "fake_shot",
      description: "returns a real temp file as attachment",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "shot", attachments: [{ type: "image" as const, path: tmpFile, mimeType: "image/png" }] };
      },
    };
    subagent["toolRegistry"].register(shotTool);

    const fetchMock = mockLlm(async (_input, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;
      if (tools?.some((t) => t.function.name === "fake_shot")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "fake_shot", arguments: "{}" } }, { id: "tc2", function: { name: "browser_done", arguments: '{"summary":"done"}' } }] } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "d", function: { name: "browser_done", arguments: '{"summary":"x"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("shot test");
      await subagent.cleanup();
      const { access } = await import("node:fs/promises");
      let exists = true;
      try { await access(tmpFile); } catch { exists = false; }
      assert.ok(exists, "screenshot must survive cleanup (deleted post-send, not in the subagent)");
      assert.equal(result.attachments?.[0]?.path, tmpFile);
    } finally {
      fetchMock.restore();
      await rm(tmpFile, { force: true });
    }
  });

  test("run stops immediately when the signal is already aborted", async () => {
    let llmCalls = 0;
    const fetchMock = mockLlm(async () => {
      llmCalls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "d", function: { name: "browser_done", arguments: '{"summary":"x"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const controller = new AbortController();
      controller.abort();
      const result = await subagent.run("test task", undefined, controller.signal);
      assert.equal(result.success, false);
      assert.equal(result.needs_human, false);
      assert.equal(result.summary, "Stopped by user.");
      assert.equal(llmCalls, 0, "No LLM call should happen after abort");
    } finally {
      fetchMock.restore();
    }
  });

  test("abort mid-run stops before executing the next tool call", async () => {
    const controller = new AbortController();
    let toolExecutions = 0;
    const trackedTool: Tool = {
      name: "tracked_tool",
      description: "counts executions",
      parameters: { type: "object", properties: {} },
      async execute() {
        toolExecutions++;
        return { success: true, output: "ok" };
      },
    };
    subagent["toolRegistry"].register(trackedTool);

    const fetchMock = mockLlm(async () => {
      // Abort while the LLM "responds" with tool calls: the tool loop must bail out.
      controller.abort();
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "t1", function: { name: "tracked_tool", arguments: "{}" } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await subagent.run("test task", undefined, controller.signal);
      assert.equal(result.summary, "Stopped by user.");
      assert.equal(toolExecutions, 0, "Tool must not execute after abort");
    } finally {
      fetchMock.restore();
    }
  });

  test("trims oversized history before calling the LLM", async () => {
    // Tight context budget: a huge assistant turn from step 1 must not be
    // replayed verbatim to the LLM at step 2.
    const tightConfig = makeConfig({
      llm: { provider: "test", baseUrl: "http://test", model: "test", limit: { context: 2000 } },
    });
    const tightSubagent = new BrowserSubagent(tightConfig as any, "http://127.0.0.1:9222");

    const hugeText = "x".repeat(400_000);
    let step = 0;
    let lastRequestSize = 0;

    // Step 1: small turn (fills the protected head). Step 2: huge turn (lands in
    // the droppable middle). Step 3: measure the request — the huge turn must be
    // trimmed out before it reaches the LLM. Then finish.
    const fetchMock = mockLlm(async (_input, init) => {
      step++;
      lastRequestSize = String((init as { body?: string }).body ?? "").length;
      if (step === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "small step" } }] }),
          { status: 200 },
        ) as never;
      }
      if (step === 2) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: hugeText } }] }),
          { status: 200 },
        ) as never;
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "d", function: { name: "browser_done", arguments: '{"summary":"done"}' } }] } }] }),
        { status: 200 },
      ) as never;
    });

    try {
      const result = await tightSubagent.run("test task");
      assert.ok(result.success);
      assert.equal(step, 3, "Should have reached the third LLM call");
      assert.ok(
        lastRequestSize < hugeText.length,
        `Trimmed request (${lastRequestSize} chars) must be far smaller than the untrimmed huge turn (${hugeText.length} chars)`,
      );
    } finally {
      fetchMock.restore();
      await tightSubagent.cleanup().catch(() => undefined);
    }
  });

  afterEach(async () => {
    await subagent.cleanup().catch(() => undefined);
  });
});
