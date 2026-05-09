import test from "node:test";
import assert from "node:assert/strict";
import { alignPlainTextChunks, splitHtmlChunks, splitPlainText } from "../src/channels/telegram/split.ts";

test("splitPlainText splits long content", () => {
  const chunks = splitPlainText("a".repeat(5000), 4000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 4000);
  assert.equal(chunks[1]?.length, 1000);
});

test("splitHtmlChunks keeps tags balanced across chunks", () => {
  const chunks = splitHtmlChunks(`<b>${"a".repeat(4500)}</b>`, 4000);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0] ?? "", /^<b>/);
  assert.match(chunks[0] ?? "", /<\/b>$/);
  assert.match(chunks[1] ?? "", /^<b>/);
  assert.match(chunks[1] ?? "", /<\/b>$/);
});

test("splitHtmlChunks avoids splitting entities", () => {
  const chunks = splitHtmlChunks(`${"a".repeat(3998)}&amp;tail`, 4000);
  assert.equal(chunks.length, 2);
  assert.equal((chunks[0] ?? "").endsWith("&"), false);
});

test("alignPlainTextChunks returns aligned chunk count", () => {
  const chunks = alignPlainTextChunks("hello world again", 3, 8);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join("").replace(/\s+/g, ""), "helloworldagain");
});
