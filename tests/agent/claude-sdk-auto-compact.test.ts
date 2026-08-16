import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClaudeSdkBackend, type SdkQueryFn } from "../../src/agent/claude-sdk/backend.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

/** A window of 1000 tokens, so the 0.8 default threshold sits at a number a test can state. */
function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: {
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic", limit: { context: 1000 } }],
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

interface Call {
  options: Record<string, unknown>;
  prompt: string;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return String(content ?? "");
}

/**
 * One fake for both calls a triggered gate makes: the compaction is told apart by its prompt,
 * which is the SDK's own `/compact` slash command. The run answers without usage on purpose, so
 * a test can see whether the gate dropped the stale measurement instead of a new call rewriting it.
 */
function scripted(captured: Call[], compacts = true): SdkQueryFn {
  return ({ prompt, options }) => {
    const call: Call = { options, prompt: "" };
    captured.push(call);
    return (async function* () {
      const first = await prompt.next();
      if (!first.done) call.prompt = contentToText(first.value.message.content);
      if (call.prompt === "/compact") {
        if (compacts) yield { type: "system", subtype: "compact_boundary" } as never;
        yield { type: "result", subtype: "success", result: "compacted" } as never;
      } else {
        yield { type: "result", subtype: "success", result: "answer" } as never;
      }
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
  };
}

function makeBackend(queryFn: SdkQueryFn): ClaudeSdkBackend {
  return new ClaudeSdkBackend(baseConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, queryFn);
}

// The SDK never hears about our cap, so the ceiling was decorative on this backend: a session
// measured at 110 percent of it kept running until the SDK compacted on its own window.
test("a session past the threshold is compacted before the run starts", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = makeBackend(scripted(captured));

  const sess = session("s-over");
  sess.sdkSessionId = "sdk-1";
  sess.lastPrompt = { tokens: 900, messageCount: 0 };

  const out = await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(captured.length, 2);
  assert.equal(captured[0]!.prompt, "/compact");
  assert.equal(captured[0]!.options["resume"], "sdk-1");
  assert.equal(captured[1]!.prompt.includes("salut"), true);
  assert.equal(out, "answer");
  // The measurement described a transcript that no longer exists.
  assert.equal(sess.lastPrompt, undefined);
});

// A compaction is a minute or two with nothing on the wire, on a message the owner just sent:
// without the mark the bubble looks dropped, which is the whole reason the mark exists.
test("the bubble is marked while the compaction runs", async () => {
  runRegistry.clear();
  const queued: Array<{ sessionId: string; reason: string }> = [];
  const onQueued = ({ sessionId, reason }: { sessionId: string; reason: string }): void => {
    queued.push({ sessionId, reason });
  };
  hooks.on("message:queued", onQueued);
  try {
    const captured: Call[] = [];
    const backend = makeBackend(scripted(captured));
    const sess = session("s-marked");
    sess.sdkSessionId = "sdk-mark";
    sess.lastPrompt = { tokens: 900, messageCount: 0 };

    await backend.handleMessage(msg("m1", "salut"), sess);

    assert.deepEqual(queued, [{ sessionId: "s-marked", reason: "compaction" }]);
  } finally {
    hooks.off("message:queued", onQueued);
  }
});

test("a run that compacts nothing marks nothing", async () => {
  runRegistry.clear();
  const queued: string[] = [];
  const onQueued = ({ sessionId }: { sessionId: string }): void => {
    queued.push(sessionId);
  };
  hooks.on("message:queued", onQueued);
  try {
    const captured: Call[] = [];
    const backend = makeBackend(scripted(captured));
    const sess = session("s-quiet");
    sess.sdkSessionId = "sdk-quiet";
    sess.lastPrompt = { tokens: 700, messageCount: 0 };

    await backend.handleMessage(msg("m1", "salut"), sess);

    assert.deepEqual(queued, []);
  } finally {
    hooks.off("message:queued", onQueued);
  }
});

test("a session below the threshold runs straight away", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = makeBackend(scripted(captured));

  const sess = session("s-under");
  sess.sdkSessionId = "sdk-2";
  sess.lastPrompt = { tokens: 700, messageCount: 0 };

  await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.prompt.includes("salut"), true);
  assert.deepEqual(sess.lastPrompt, { tokens: 700, messageCount: 0 });
});

test("a conversation with no SDK session yet has nothing to compact", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = makeBackend(scripted(captured));

  const sess = session("s-new");
  sess.lastPrompt = { tokens: 900, messageCount: 0 };

  await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(captured.length, 1);
  assert.notEqual(captured[0]!.prompt, "/compact");
});

// Nothing shrinks the mirror on this backend, so a measurement kept after a compaction would put
// the gate over the line at the start of every single run.
test("the gate does not fire twice in a row on the same conversation", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = makeBackend(scripted(captured));

  const sess = session("s-twice");
  sess.sdkSessionId = "sdk-3";
  sess.lastPrompt = { tokens: 900, messageCount: 0 };

  await backend.handleMessage(msg("m1", "un"), sess);
  await backend.handleMessage(msg("m2", "deux"), sess);

  assert.equal(captured.filter((c) => c.prompt === "/compact").length, 1);
  assert.equal(captured.length, 3);
});

test("a compaction that does not run never blocks the run", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = makeBackend(scripted(captured, false));

  const sess = session("s-failed");
  sess.sdkSessionId = "sdk-4";
  sess.lastPrompt = { tokens: 900, messageCount: 0 };

  const out = await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(captured.length, 2);
  assert.equal(out, "answer");
  // Nothing was rewritten, so the measurement still describes the live transcript.
  assert.deepEqual(sess.lastPrompt, { tokens: 900, messageCount: 0 });
});

test("auto-compaction switched off in config leaves the run alone", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const config = baseConfig();
  config.context = { autoCompact: { enabled: false } };
  const backend = new ClaudeSdkBackend(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, scripted(captured));

  const sess = session("s-off");
  sess.sdkSessionId = "sdk-5";
  sess.lastPrompt = { tokens: 900, messageCount: 0 };

  await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(captured.length, 1);
});
