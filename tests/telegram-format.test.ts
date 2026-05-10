import { test } from "bun:test";
import assert from "node:assert/strict";
import { markdownToTelegramHtml, stripHtml } from "../src/channels/telegram/format.ts";

test("markdownToTelegramHtml renders core formatting", () => {
  const html = markdownToTelegramHtml("**bold** *italic* ~~gone~~ `code` [site](https://example.com)");

  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<i>italic<\/i>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com">site<\/a>/);
});

test("markdownToTelegramHtml handles headings blockquotes spoilers tables and file refs", () => {
  const html = markdownToTelegramHtml([
    "## Title",
    "> quoted",
    "- [x] done",
    "||secret||",
    "readme.md",
    "",
    "|a|b|",
    "|--|--|",
    "|1|2|",
  ].join("\n"));

  assert.match(html, /<b>Title<\/b>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /☑ done/);
  assert.match(html, /<tg-spoiler>secret<\/tg-spoiler>/);
  assert.match(html, /<code>readme\.md<\/code>/);
  assert.match(html, /<pre>/);
});

test("markdownToTelegramHtml escapes raw html", () => {
  const html = markdownToTelegramHtml("<script>alert(1)</script>");
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(stripHtml(html), "<script>alert(1)</script>");
});
