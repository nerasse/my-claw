import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClaudeSdkBackend, toSdkEffort, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
    },
    agents: {}, memory: { enabled: false },
  };
}

function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function session(id: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

interface CapturedCall {
  options: Record<string, unknown>;
  prompts: Array<{ content: string }>;
}

/** SDK message content is either a string or a block array. These tests assert on the text,
 *  so flatten it once at capture time instead of widening every assertion. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return String(content ?? "");
}

/** Fake query: consumes the initial prompt message, then replays a scripted stream. */
function fakeQuery(script: (prompts: Array<{ content: string }>) => AsyncGenerator<Record<string, unknown>>, captured: CapturedCall[]): SdkQueryFn {
  return ({ prompt, options }) => {
    const call: CapturedCall = { options, prompts: [] };
    captured.push(call);
    return (async function* () {
      const first = await prompt.next();
      if (!first.done) call.prompts.push({ content: contentToText(first.value.message.content) });
      yield* script(call.prompts) as AsyncGenerator<never>;
      // Drain the generator so the backend's `finished` flag can settle it.
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
  };
}

function makeBackend(queryFn: SdkQueryFn, config = baseConfig()): ClaudeSdkBackend {
  return new ClaudeSdkBackend(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);
}

const assistantMsg = (id: string, text: string, usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }], usage },
});

const resultMsg = (text: string) => ({ type: "result", subtype: "success", result: text });

test("basic run: returns text, stores sdkSessionId, mirrors messages, tracks usage", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield { type: "system", subtype: "init", session_id: "sdk-abc" };
    yield assistantMsg("m1", "hello from sonnet");
    yield resultMsg("hello from sonnet");
  }, captured));

  const sess = session("s1");
  const out = await backend.handleMessage(msg("m1", "hi"), sess);

  assert.equal(out, "hello from sonnet");
  assert.equal(sess.sdkSessionId, "sdk-abc");
  assert.equal(sess.messages[0]?.role, "user");
  assert.equal(sess.messages[1]?.role, "assistant");
  assert.equal(sess.messages.length, 2);
  assert.equal(sess.tokenUsage?.apiCalls, 1);
  assert.equal(sess.tokenUsage?.promptTokens, 150);
  assert.equal(sess.tokenUsage?.completionTokens, 10);
});

test("hermetic options: isolation, model, resume passthrough", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield resultMsg("ok");
  }, captured));

  const sess = session("s1");
  sess.sdkSessionId = "resume-me";
  await backend.handleMessage(msg("m1", "hi"), sess);

  const opts = captured[0]!.options;
  assert.equal(opts["model"], "claude-sonnet-5");
  assert.equal(opts["resume"], "resume-me");
  assert.deepEqual(opts["tools"], []);
  assert.deepEqual(opts["settingSources"], []);
  assert.deepEqual(opts["skills"], []);
  const env = opts["env"] as Record<string, string>;
  assert.equal(env["CLAUDE_CODE_ENABLE_TASKS"], "0");
  assert.equal(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
  assert.ok(env["CLAUDE_CONFIG_DIR"]?.endsWith("claude-sdk"));
  assert.ok(typeof opts["maxTurns"] === "number" && (opts["maxTurns"] as number) > 0);
  const sp = String(opts["systemPrompt"]);
  assert.ok(sp.includes("Mid-run steering"));
});

test("streaming deltas reach onToken", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } };
    yield assistantMsg("m1", "hello");
    yield resultMsg("hello");
  }, captured));

  const tokens: string[] = [];
  const out = await backend.handleMessageStreaming(msg("m1", "hi"), session("s1"), async (t) => { tokens.push(t); });
  assert.equal(out, "hello");
  assert.deepEqual(tokens, ["hel", "lo"]);
  assert.equal(captured[0]!.options["includePartialMessages"], true);
});

test("usage deduped by message id across parallel tool batches", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield assistantMsg("same-id", "");
    yield assistantMsg("same-id", "");
    yield assistantMsg("other-id", "done");
    yield resultMsg("done");
  }, captured));

  const sess = session("s1");
  await backend.handleMessage(msg("m1", "hi"), sess);
  assert.equal(sess.tokenUsage?.apiCalls, 2);
});

test("error subtype throws a mapped error", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield { type: "result", subtype: "error_during_execution" };
  }, captured));

  await assert.rejects(
    () => backend.handleMessage(msg("m1", "hi"), session("s1")),
    /error_during_execution/,
  );
});

test("error_max_turns falls back to the last assistant text", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield assistantMsg("m1", "partial progress");
    yield { type: "result", subtype: "error_max_turns" };
  }, captured));

  const out = await backend.handleMessage(msg("m1", "hi"), session("s1"));
  assert.equal(out, "partial progress");
});

test("auth failure text maps to an actionable error", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield resultMsg("Failed to authenticate: OAuth session expired and could not be refreshed");
  }, captured));

  await assert.rejects(
    () => backend.handleMessage(msg("m1", "hi"), session("s1")),
    /setup-token/,
  );
});

test("tool_use blocks and tool results are mirrored into session messages", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const backend = makeBackend(fakeQuery(async function* () {
    yield {
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "tu1", name: "mcp__myclaw__bash", input: { command: "ls" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }] },
    };
    yield assistantMsg("m2", "there is one file");
    yield resultMsg("there is one file");
  }, captured));

  const sess = session("s1");
  await backend.handleMessage(msg("m1", "what files?"), sess);

  const roles = sess.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
  const assistant = sess.messages[1]!;
  assert.ok(assistant.role === "assistant" && assistant.toolCalls?.[0]?.name === "mcp__myclaw__bash");
  const tool = sess.messages[2]!;
  assert.ok(tool.role === "tool" && tool.toolCallId === "tu1" && tool.content === "file.txt");
});

test("canUseTool allows by default and denies via approval policy", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];
  const config = baseConfig();
  config.blacklist = ["spawn"];
  const backend = makeBackend(fakeQuery(async function* () {
    yield resultMsg("ok");
  }, captured), config);
  // No approval handler wired: blacklisted tools must be denied, others allowed.
  const sess = session("s1");
  await backend.handleMessage(msg("m1", "hi"), sess);

  const canUseTool = captured[0]!.options["canUseTool"] as (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ behavior: string; message?: string }>;

  const allowed = await canUseTool("mcp__myclaw__read", { path: "x" });
  assert.equal(allowed.behavior, "allow");
  const denied = await canUseTool("mcp__myclaw__spawn", { task: "x" });
  assert.equal(denied.behavior, "deny");
});

test("mid-run injection is yielded to the generator and mirrored", async () => {
  runRegistry.clear();
  const captured: CapturedCall[] = [];

  const queryFn: SdkQueryFn = ({ prompt, options }) => {
    const call: CapturedCall = { options, prompts: [] };
    captured.push(call);
    return (async function* () {
      const first = await prompt.next();
      if (!first.done) call.prompts.push({ content: contentToText(first.value.message.content) });
      // Simulate a running turn while an injection arrives.
      const second = await prompt.next();
      if (!second.done) call.prompts.push({ content: contentToText(second.value.message.content) });
      yield { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "handled both" }], usage: { input_tokens: 1, output_tokens: 1 } } } as never;
      yield { type: "result", subtype: "success", result: "handled both" } as never;
    })() as AsyncIterable<never>;
  };

  const backend = makeBackend(queryFn);
  const sess = session("s-inject");
  const { signal, end } = runRegistry.startRoot(sess.id);

  const runPromise = backend.handleMessage(msg("m1", "start work"), sess, signal);
  // Give the run a beat to start, then inject.
  await new Promise((r) => setTimeout(r, 50));
  const injectionSettled = runRegistry.enqueueInjection(sess.id, msg("m2", "also do this"));
  assert.ok(injectionSettled !== null);

  const out = await runPromise;
  runRegistry.settleMailbox(sess.id, "resolve");
  await injectionSettled;
  end();

  assert.equal(out, "handled both");
  assert.equal(captured[0]!.prompts.length, 2);
  assert.ok(captured[0]!.prompts[1]!.content.includes("also do this"));
  const userTurns = sess.messages.filter((m) => m.role === "user");
  assert.equal(userTurns.length, 2);
});

test("toSdkEffort clamps the Codex-only ultra level instead of passing it to the SDK", () => {
  // The SDK rejects unknown levels, and a session effort chosen on a Codex model follows the
  // user to a Claude one, so the run must degrade to the highest level Claude does support.
  assert.equal(toSdkEffort("ultra"), "max");
  assert.equal(toSdkEffort("high"), "high");
  assert.equal(toSdkEffort(undefined), undefined);
});
