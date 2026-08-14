/**
 * Reading a compaction summary back out of the SDK transcript. Verified against a real
 * transcript (16 kB summary, preamble and trailing instructions stripped) before being frozen
 * into these fixtures.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCompactSummary, readCompactSummary } from "../../src/agent/claude-sdk/transcript.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

const BOUNDARY = JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  compactMetadata: { trigger: "manual", preTokens: 250869 },
});

function continuation(summary: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        "This session is being continued from a previous conversation that ran out of context. " +
        "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
        summary +
        "\n\nIf you need specific details from before compaction (like exact code snippets), " +
        "read the full transcript at: /tmp/whatever.jsonl\nContinue the conversation.",
    },
  });
}

test("the summary is taken from the continuation message, without the wrapper the CLI adds", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "before the compaction" } }),
    BOUNDARY,
    continuation("1. What the owner asked\n2. What was built"),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after" }] } }),
  ];
  assert.equal(extractCompactSummary(lines), "1. What the owner asked\n2. What was built");
});

test("only the last compaction is quoted: an older summary is not the current context", () => {
  const lines = [BOUNDARY, continuation("the old one"), BOUNDARY, continuation("the current one")];
  assert.equal(extractCompactSummary(lines), "the current one");
});

test("a transcript with no compaction yields nothing", () => {
  const lines = [JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })];
  assert.equal(extractCompactSummary(lines), undefined);
});

test("a boundary followed by an ordinary message yields nothing rather than quoting it", () => {
  const lines = [BOUNDARY, JSON.stringify({ type: "user", message: { role: "user", content: "carry on" } })];
  assert.equal(extractCompactSummary(lines), undefined);
});

test("a truncated line is skipped instead of throwing on the whole transcript", () => {
  const lines = [BOUNDARY, '{"type":"user","message":{"role":"user","conte', continuation("survived")];
  assert.equal(extractCompactSummary(lines), "survived");
});

test("the transcript is found by session id, whichever project directory holds it", async () => {
  const dir = join(MY_CLAW_DIR, "claude-sdk", "projects", "-home-someone-elsewhere");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sess-42.jsonl"), [BOUNDARY, continuation("found by id")].join("\n"));

  assert.equal(await readCompactSummary("sess-42"), "found by id");
  assert.equal(await readCompactSummary("no-such-session"), undefined);
});
