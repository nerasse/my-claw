import { test } from "bun:test";
import assert from "node:assert/strict";
import { __testing } from "../../src/llm/anthropic.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";
import type { EffortLevel } from "../../src/core/config.ts";

const {
  billingHeader,
  billingSuffix,
  billingSampleText,
  buildBody,
  buildRequest,
  buildSystem,
  maxTokensFor,
  thinkingFor,
  wireToolName,
  localToolName,
  normalizeUsage,
} = __testing;

// Ground truth from docs/captures/claude-cli-2.1.206.json: driving the real CLI with this exact
// prompt made it emit `cc_version=2.1.206.ca4`. This is the one assertion in the file that pins
// behaviour to an observed request rather than to our own reading of the CLI bundle.
const CAPTURED_PROMPT = "Read the file /tmp/capture/hello.txt and tell me what is in it";
const CAPTURED_VERSION = "2.1.206";
const CAPTURED_SUFFIX = "ca4";

test("billing suffix reproduces the captured request byte for byte", () => {
  assert.equal(billingSuffix(CAPTURED_PROMPT, CAPTURED_VERSION), CAPTURED_SUFFIX);
});

test("billing header has the captured shape and no cch", () => {
  const header = billingHeader(CAPTURED_PROMPT);
  assert.match(header, /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/);
  // The real cch is the literal 00000 and ships only on the first-party and vertex paths.
  assert.ok(!header.includes("cch="));
});

test("billing header never carries a cache breakpoint and is always emitted", () => {
  const blocks = buildSystem("prompt", "");
  assert.equal(blocks[0]!.cache_control, undefined);
  assert.match(blocks[0]!.text, /^x-anthropic-billing-header:/);
});

test("system layout is the captured three blocks with two 1h breakpoints", () => {
  const blocks = buildSystem("the rest of the prompt", CAPTURED_PROMPT);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1]!.text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.deepEqual(blocks[1]!.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(blocks[2]!.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(blocks[2]!.text, "the rest of the prompt");
});

test("sampling skips system-reminder blocks the way the CLI skips meta entries", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\nAvailable agent types\n</system-reminder>" },
        { type: "text", text: CAPTURED_PROMPT },
      ],
    },
  ];
  assert.equal(billingSampleText(messages), CAPTURED_PROMPT);
  // Sampling the reminder instead would give a different, wrong suffix.
  assert.notEqual(billingHeader(CAPTURED_PROMPT), billingHeader("<system-reminder>\nAvailable agent types\n</system-reminder>"));
});

test("sampling falls back to an empty string rather than throwing", () => {
  assert.equal(billingSampleText([{ role: "system", content: "sys" }]), "");
  assert.match(billingHeader(""), /cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3};/);
});

test("consecutive tool results merge into one user turn", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "working",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        { id: "c2", type: "function", function: { name: "read", arguments: '{"path":"/tmp/a"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "out1" },
    { role: "tool", tool_call_id: "c2", content: "out2" },
  ];
  const { system, turns } = buildRequest(messages);
  assert.equal(system, "sys");
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  // Anthropic requires the results answering one assistant turn in a single user message.
  assert.equal(turns[2]!.content.length, 2);
  assert.deepEqual(turns[2]!.content.map((b) => b.type), ["tool_result", "tool_result"]);
  assert.equal(turns[1]!.content.length, 3);
  assert.deepEqual(turns[1]!.content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
});

test("a later system message becomes a user turn, not a second system slot", () => {
  const { system, turns } = buildRequest([
    { role: "system", content: "first" },
    { role: "user", content: "hi" },
    { role: "system", content: "iteration limit reached" },
  ]);
  assert.equal(system, "first");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.role, "user");
  assert.deepEqual(
    turns[0]!.content.map((b) => (b.type === "text" ? b.text : b.type)),
    ["hi", "iteration limit reached"],
  );
});

test("data urls become base64 image sources and plain urls stay urls", () => {
  const { turns } = buildRequest([
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        { type: "image_url", image_url: { url: "https://example.invalid/a.png" } },
      ],
    },
  ]);
  const blocks = turns[0]!.content;
  assert.deepEqual(blocks[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
  assert.deepEqual(blocks[1], { type: "image", source: { type: "url", url: "https://example.invalid/a.png" } });
});

test("tool names are prefixed on the wire and stripped on the way back", () => {
  assert.equal(wireToolName("bash"), "mcp__myclaw__bash");
  assert.equal(localToolName("mcp__myclaw__bash"), "bash");
  // A real MCP server's tool already carries its own prefix and must not be double-wrapped.
  assert.equal(wireToolName("mcp__forgejo__list_repos"), "mcp__forgejo__list_repos");
  assert.equal(localToolName("mcp__forgejo__list_repos"), "mcp__forgejo__list_repos");
  assert.equal(localToolName(wireToolName("bash")), "bash");
});

test("usage folds the cache buckets into promptTokens", () => {
  const usage = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, 42);
  // input_tokens excludes the cache buckets on this API; LlmUsage.promptTokens includes them.
  assert.deepEqual(usage, {
    promptTokens: 1050,
    completionTokens: 42,
    totalTokens: 1092,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
  });
});

test("usage is undefined when nothing was reported", () => {
  assert.equal(normalizeUsage(undefined, 0), undefined);
  assert.equal(normalizeUsage({}, 0), undefined);
});

test("the thinking type comes from what the model declares, never from its name", () => {
  // Opus 5 reports enabled: false and adaptive: true. Sending it a budget is a 400.
  const adaptive = thinkingFor({ adaptive: true, enabled: false }, 128_000)!;
  assert.equal(adaptive.type, "adaptive");
  assert.equal(adaptive.budget_tokens, undefined, "adaptive carries no budget by design");
  assert.equal(adaptive.display, "omitted");

  // An extended-thinking-only model still needs a number: the ceiling minus one, as the client does.
  const explicit = thinkingFor({ adaptive: false, enabled: true }, 64_000)!;
  assert.equal(explicit.type, "enabled");
  assert.equal(explicit.budget_tokens, 63_999);

  // Adaptive wins when both are offered: no budget to guess, and the docs recommend it.
  assert.equal(thinkingFor({ adaptive: true, enabled: true }, 64_000)!.type, "adaptive");
});

test("a model that declares no thinking gets no thinking block, never a disabled one", () => {
  // `{type: "disabled"}` is a 400 on Opus 5 at xhigh and max effort. Omission says the same thing.
  assert.equal(thinkingFor({ adaptive: false, enabled: false }, 64_000), undefined);
  assert.equal(thinkingFor(undefined, 64_000), undefined);
});

test("effort rides in output_config, not in the thinking block", () => {
  // The documented mechanism: output_config.effort, no beta header, a behavioural signal that
  // shapes every token including tool calls rather than a token budget.
  const body = buildBody({ effort: "medium", thinkingTypes: { adaptive: true, enabled: false } });
  assert.deepEqual(body["output_config"], { effort: "medium" });
  assert.equal((body["thinking"] as { budget_tokens?: number }).budget_tokens, undefined);
});

test("an effort value the API does not define is clamped to the ladder, never dropped", () => {
  // The ladder is low, medium, high, xhigh, max. my-claw's global vocabulary is wider, and the
  // resolver only clamps against a ladder the model published. Dropping the field here would make
  // the server apply `high`, so a request asking for as little as possible would get nearly the
  // most: the two rungs outside the ladder collapse onto its ends instead.
  assert.deepEqual(buildBody({ effort: "none" })["output_config"], { effort: "low" });
  assert.deepEqual(buildBody({ effort: "minimal" })["output_config"], { effort: "low" });
  assert.deepEqual(buildBody({ effort: "ultra" })["output_config"], { effort: "max" });
  // No pin at all stays absent: that is the one case where the API default is what was asked for.
  assert.equal(buildBody({})["output_config"], undefined);
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.deepEqual(buildBody({ effort: level })["output_config"], { effort: level });
  }
});

test("effort clamps to the ladder the model itself published, not to the union", () => {
  // Measured on the wire: Sonnet 4.6 publishes four rungs and answers HTTP 400 "This model does not
  // support effort level 'xhigh'. Supported levels: high, low, max, medium." Opus 5 publishes five.
  const sonnet = { effortLevels: ["low", "medium", "high", "max"] as EffortLevel[] };
  assert.deepEqual(buildBody({ ...sonnet, effort: "xhigh" })["output_config"], { effort: "high" });
  assert.deepEqual(buildBody({ ...sonnet, effort: "ultra" })["output_config"], { effort: "max" });
  assert.deepEqual(buildBody({ ...sonnet, effort: "medium" })["output_config"], { effort: "medium" });
  // A model whose ladder was never read keeps the union as its fallback, which is all the evidence
  // there is: refusing to send anything would land on the API default instead.
  assert.deepEqual(buildBody({ effort: "xhigh" })["output_config"], { effort: "xhigh" });
});

test("the reply budget is resolved, never pinned", () => {
  assert.equal(maxTokensFor({ limit: { context: 1_000_000, output: 128_000 } }), 128_000);
  assert.equal(maxTokensFor({ limit: { context: 200_000, output: 8_192 } }), 8_192);
  // Nothing declared falls back to the client's own ceiling constant, not to its default.
  assert.equal(maxTokensFor({}), 128_000);
  assert.equal(maxTokensFor({ limit: { context: 200_000, output: 0 } }), 128_000);
});

test("server-side thinking pruning never ships without an enabled thinking block", () => {
  // Anthropic answers 400 `clear_thinking_20251015 strategy requires thinking to be enabled` when
  // the edit rides alone. The real client never hits it because it always thinks; a model with no
  // effort level does, and it cost a live request to find out.
  const withEffort = buildBody({ thinkingTypes: { adaptive: true, enabled: false } });
  assert.ok(withEffort["thinking"]);
  assert.ok(withEffort["context_management"]);
  const without = buildBody({});
  assert.equal(without["thinking"], undefined);
  assert.equal(without["context_management"], undefined);
});

const OFFERED_LADDER = ["none", "low", "medium", "high", "xhigh", "max"] as EffortLevel[];

test("effort none turns thinking off, with neither display nor thinking pruning beside it", () => {
  const body = buildBody({ effort: "none", model: "claude-opus-5", effortLevels: OFFERED_LADDER, thinkingTypes: { adaptive: true, enabled: false } });
  // `thinking.disabled.display: Extra inputs are not permitted`, measured on the wire.
  assert.deepEqual(body["thinking"], { type: "disabled" });
  // `clear_thinking_20251015` needs thinking enabled or adaptive, so it must not ride along.
  assert.equal(body["context_management"], undefined);
  // Opus 5: "output_config.effort 'max' is not supported when thinking is disabled on this model.
  // Use effort 'high' or below." The floor is what `none` means anyway.
  assert.deepEqual(body["output_config"], { effort: "low" });
});

test("a model that refused to stop thinking keeps thinking, without another round trip", () => {
  const config = { effort: "none" as const, model: "claude-fable-5", effortLevels: OFFERED_LADDER, thinkingTypes: { adaptive: true, enabled: false } };
  __testing.cannotDisableThinking.add("claude-fable-5");
  try {
    const body = buildBody(config);
    // Fable 5 answers `"thinking.type.disabled" is not supported for this model`, so the rung
    // degrades to the floor of the ladder with thinking left on rather than failing the turn.
    assert.deepEqual(body["thinking"], { type: "adaptive", display: "omitted" });
    assert.deepEqual(body["output_config"], { effort: "low" });
    assert.ok(body["context_management"]);
  } finally {
    __testing.cannotDisableThinking.delete("claude-fable-5");
  }
});

test("none is never sent as an effort value, whatever the offered ladder says", () => {
  // `output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'`, measured on
  // the wire. The rung lives in the thinking block; the effort beside it is the floor.
  for (const model of ["claude-opus-5", "claude-fable-5"]) {
    const body = buildBody({ effort: "none", model, effortLevels: OFFERED_LADDER, thinkingTypes: { adaptive: true, enabled: false } });
    assert.deepEqual(body["output_config"], { effort: "low" }, model);
  }
});
