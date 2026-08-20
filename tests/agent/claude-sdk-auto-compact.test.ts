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
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function session(id: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
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

/**
 * Our gate only runs between turns, and one run can add hundreds of thousands of tokens: the
 * engine's own compaction is the only one that can fire mid-run, and it measures against the
 * model's full window unless it is told about our cap.
 */
test("the run hands the SDK our window, so its own compaction respects the cap", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const config = baseConfig();
  config.llm.models = [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic", limit: { context: 1_000_000 } }];
  config.context = { cap: 512_000 };
  const backend = new ClaudeSdkBackend(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, 0, undefined, undefined, undefined, undefined, scripted(captured));

  await backend.handleMessage(msg("m1", "salut"), session("s-window"));

  assert.deepEqual(captured[0]!.options["settings"], { autoCompactWindow: 512_000 });
});

// The CLI validates the number against [100k, 1M] and silently drops anything outside, so a cap
// below the floor has to be clamped: dropped, it would leave the model's whole window in force.
test("a cap under the SDK's own floor is clamped instead of being dropped", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = makeBackend(scripted(captured));

  await backend.handleMessage(msg("m1", "salut"), session("s-clamp"));

  assert.deepEqual(captured[0]!.options["settings"], { autoCompactWindow: 100_000 });
});

/**
 * The engine compacting on its own says the same thing as our /compact: everything mirrored so far
 * is summarised inside the SDK. Without picking the boundary up, the mirror kept counting turns the
 * model no longer holds and the header read 98 percent on a prompt that had dropped back to 15.
 */
test("a mid-run compaction rebases the mirror and drops the stale measurement", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const queryFn: SdkQueryFn = ({ prompt, options }) => {
    captured.push({ options, prompt: "" });
    return (async function* () {
      await prompt.next();
      yield { type: "system", subtype: "compact_boundary" } as never;
      yield { type: "result", subtype: "success", result: "answer" } as never;
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
  };
  const backend = makeBackend(queryFn);
  const sess = session("s-midrun");
  sess.sdkSessionId = "sdk-mid";
  sess.lastPrompt = { tokens: 700, messageCount: 0 };

  await backend.handleMessage(msg("m1", "salut"), sess);

  // The inbound turn is mirrored before the query runs, so the boundary lands after it.
  assert.equal(sess.sdkTranscriptBase, 1);
  assert.equal(sess.lastPrompt, undefined);
});

// A sub-agent summarising its own transcript says nothing about this conversation's.
test("a nested boundary is ignored", async () => {
  runRegistry.clear();
  const queryFn: SdkQueryFn = ({ prompt }) =>
    (async function* () {
      await prompt.next();
      yield { type: "system", subtype: "compact_boundary", parent_tool_use_id: "tool-1" } as never;
      yield { type: "result", subtype: "success", result: "answer" } as never;
      void prompt.next().catch(() => {});
    })() as AsyncIterable<never>;
  const backend = makeBackend(queryFn);
  const sess = session("s-nested");
  sess.sdkSessionId = "sdk-nested";
  sess.lastPrompt = { tokens: 700, messageCount: 0 };

  await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(sess.sdkTranscriptBase, undefined);
  assert.deepEqual(sess.lastPrompt, { tokens: 700, messageCount: 0 });
});

// The gate used to be the orchestrator's alone, which left a sub-agent resuming its own SDK session
// to grow until the engine's own threshold on the model's window.
test("a sub-agent session over the threshold is compacted too", async () => {
  runRegistry.clear();
  const captured: Call[] = [];
  const backend = new ClaudeSdkBackend(
    baseConfig(), new ToolRegistry(), new SkillRegistry(), undefined, undefined, 1, undefined, "general", undefined, undefined, scripted(captured),
  );

  const sess = session("subagent/general-1");
  sess.meta = { displayName: "worker", type: "general", parentSessionId: "telegram/dm/u1", visibility: "private", createdAt: new Date().toISOString() };
  sess.sdkSessionId = "sdk-sub";
  sess.lastPrompt = { tokens: 900, messageCount: 0 };

  await backend.handleMessage(msg("m1", "salut"), sess);

  assert.equal(captured[0]!.prompt, "/compact");
  assert.equal(sess.lastPrompt, undefined);
});
