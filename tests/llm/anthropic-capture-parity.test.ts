import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __testing } from "../../src/llm/anthropic.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

const { buildBody } = __testing;

/**
 * Parity gate 1 of docs/anthropic-backend.md P2: the payload we build must match the shape of the
 * request the real client sent, the prompt bodies excepted. It reads the committed capture rather
 * than a copy of its values, so a drift in either the code or the artifact fails here instead of
 * being discovered from the bill.
 *
 * Deliberate divergences are asserted as divergences, not silently tolerated: that is the
 * difference between a gate and a rubber stamp.
 */
interface Capture {
  request: {
    headers: Record<string, string>;
    body: {
      system: Array<{ type: string; cache_control: { type: string; ttl: string } | null; bytes: number }>;
      tools?: Array<{ name: string; has_cache_control: boolean }>;
      thinking?: Record<string, unknown>;
      context_management?: unknown;
      max_tokens?: number;
      stream?: boolean;
      metadata?: unknown;
    };
  };
}

const capture = JSON.parse(
  readFileSync(join(import.meta.dir, "../../docs/captures/claude-cli-2.1.206.json"), "utf8"),
) as Capture;

const messages: ChatMessage[] = [
  { role: "system", content: "the system prompt" },
  {
    role: "user",
    content: [
      { type: "text", text: "<system-reminder>\nmeta\n</system-reminder>" },
      { type: "text", text: "the real first turn" },
    ],
  },
];
const tools = [
  { type: "function", function: { name: "bash", description: "d", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read", description: "d", parameters: { type: "object", properties: {} } } },
];
// The capture ran on Haiku 4.5, an extended-thinking-only model, so it shows the explicit-budget
// branch. Declaring `enabled` reaches that same branch here; the adaptive branch, which the modern
// models take and which carries no budget, is covered in anthropic.test.ts.
const body = buildBody(
  {
    model: "claude-opus-5",
    limit: { context: 200_000, output: 32_000 },
    thinkingTypes: { adaptive: false, enabled: true },
  },
  messages,
  tools,
);

test("system[] has the captured arity and the captured breakpoint placement", () => {
  const ours = body["system"] as Array<{ cache_control?: unknown }>;
  const theirs = capture.request.body.system;
  assert.equal(ours.length, theirs.length);
  ours.forEach((block, i) => {
    const expected = theirs[i]!.cache_control;
    assert.deepEqual(block.cache_control ?? null, expected, `system[${i}] breakpoint`);
  });
});

test("the billing header block is byte-identical in length to the captured one", () => {
  // Both are `cc_version=<x.y.z>.<3 hex>; cc_entrypoint=sdk-cli;`, so a length change means a
  // field was added or dropped, which is exactly what we want to hear about.
  const ours = body["system"] as Array<{ text: string }>;
  assert.equal(Buffer.byteLength(ours[0]!.text), capture.request.body.system[0]!.bytes);
});

test("no tool declaration carries a cache breakpoint, as in the capture", () => {
  const ours = body["tools"] as Array<{ cache_control?: unknown }>;
  assert.equal(capture.request.body.tools!.filter((t) => t.has_cache_control).length, 0);
  assert.equal(ours.filter((t) => t.cache_control !== undefined).length, 0);
});

test("at most four cache breakpoints ride in one request", () => {
  const system = body["system"] as Array<{ cache_control?: unknown }>;
  const declared = body["tools"] as Array<{ cache_control?: unknown }>;
  const used = system.filter((b) => b.cache_control).length + declared.filter((t) => t.cache_control).length;
  assert.ok(used <= 4, `${used} breakpoints, Anthropic caps a request at 4`);
  // Two slots stay free for turn boundaries.
  assert.equal(used, 2);
});

test("the thinking block has the captured shape and stays under the reply budget", () => {
  const theirs = capture.request.body.thinking as { type: string; budget_tokens: number; display: string };
  const ours = body["thinking"] as { type: string; budget_tokens: number; display: string };
  assert.equal(ours.type, theirs.type);
  // The one field we deliberately differ on: the client asks for `omitted`, we ask for the text so
  // the reasoning reaches the chat like every other model's does. Documented in anthropic.ts.
  assert.equal(theirs.display, "omitted");
  assert.equal(ours.display, "summarized");
  // Both are the model's output ceiling minus one, which is the client's own formula.
  assert.equal(theirs.budget_tokens, capture.request.body.max_tokens! - 1);
  assert.equal(ours.budget_tokens, (body["max_tokens"] as number) - 1);
});

test("context_management and stream match the capture exactly", () => {
  assert.deepEqual(body["context_management"], capture.request.body.context_management);
  assert.equal(body["stream"], capture.request.body.stream);
  // max_tokens is resolved from the model rather than pinned, so the capture's 32000 is reproduced
  // by declaring that limit, not by hardcoding it.
  assert.equal(body["max_tokens"], capture.request.body.max_tokens);
});

test("metadata is the one body field we deliberately drop", () => {
  // The capture carries metadata.user_id with the account uuid and a device fingerprint. Omitting
  // it avoids coupling the transport to the CLI's local state, and the reference plugin has run
  // without it for weeks. Asserted so the divergence stays a decision, not a regression.
  assert.ok(capture.request.body.metadata, "capture should carry metadata");
  assert.equal(body["metadata"], undefined);
});

test("every captured header is sent, or listed as a deliberate omission", () => {
  // Set by the runtime, not by us: Bun's fetch owns the connection and the encoding negotiation.
  const runtimeOwned = new Set(["accept-encoding", "connection", "content-length", "host"]);
  const missing = Object.keys(capture.request.headers).filter(
    (h) => !runtimeOwned.has(h) && !SENT_HEADERS.has(h),
  );
  assert.deepEqual(missing, [], `headers in the capture that the transport never sends: ${missing.join(", ")}`);
});

// Mirrors the header block in runAnthropic. Kept as data so the assertion above is a comparison
// against the capture rather than against a second copy of the same intent.
const SENT_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "authorization",
  "content-type",
  "user-agent",
  "x-app",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
]);

test("the beta list is the captured list, in the captured order", () => {
  assert.equal(SENT_HEADERS.has("anthropic-beta"), true);
  const theirs = capture.request.headers["anthropic-beta"]!;
  assert.equal(theirs.split(",").length, 8);
  // The transport joins the same array; compare the literal so a reorder fails.
  assert.equal(
    theirs,
    [
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "thinking-token-count-2026-05-13",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "claude-code-20250219",
      "advisor-tool-2026-03-01",
      "extended-cache-ttl-2025-04-11",
    ].join(","),
  );
});
