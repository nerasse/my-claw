import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMatrixFormattedText,
  extractMatrixMentions,
  markdownToMatrixHtml,
  resolveInboundMatrixMentions,
  stripMatrixHtml,
  stripMatrixMentionPrefix,
} from "../src/channels/matrix-format.ts";

test("matrix formatter renders markdown to html", () => {
  const html = markdownToMatrixHtml("**bold**\n\n`code`");
  assert.match(html, /<strong>bold<\/strong>|<b>bold<\/b>/);
  assert.match(html, /<code>code<\/code>/);
});

test("matrix formatter extracts mentions and keeps formatted body", () => {
  const formatted = buildMatrixFormattedText("Hello @user:example.org and @room");
  assert.equal(formatted.body, "Hello @user:example.org and @room");
  assert.equal(formatted.mentions?.room, true);
  assert.deepEqual(formatted.mentions?.user_ids, ["@user:example.org"]);
});

test("matrix formatter strips mention prefix", () => {
  assert.equal(
    stripMatrixMentionPrefix({
      text: "@bot:example.org /status",
      userId: "@bot:example.org",
    }),
    "/status",
  );
  assert.equal(
    stripMatrixMentionPrefix({
      text: "OpenClaw, /model",
      displayName: "OpenClaw",
    }),
    "/model",
  );
  assert.equal(
    stripMatrixMentionPrefix({
      text: "@bot /clear",
      userId: "@bot:example.org",
    }),
    "/clear",
  );
});

test("matrix formatter strips html to plain text", () => {
  assert.equal(stripMatrixHtml("<p>Hello <strong>world</strong></p>"), "Hello world");
  assert.deepEqual(extractMatrixMentions("Ping @alice:example.org"), {
    room: undefined,
    user_ids: ["@alice:example.org"],
  });
});

test("matrix formatter ignores metadata-only inbound mentions", () => {
  const resolved = resolveInboundMatrixMentions({
    text: "hello there",
    userId: "@bot:example.org",
    content: {
      body: "hello there",
      "m.mentions": { user_ids: ["@bot:example.org"] },
    },
  });

  assert.equal(resolved.mentionedBot, false);
  assert.equal(resolved.hasExplicitMention, false);
});

test("matrix formatter accepts visible matrix.to mentions", () => {
  const resolved = resolveInboundMatrixMentions({
    text: "hello there",
    userId: "@bot:example.org",
    content: {
      body: "hello there",
      formatted_body:
        '<a href="https://matrix.to/#/%40bot%3Aexample.org">@bot</a> hello there',
      "m.mentions": { user_ids: ["@bot:example.org"] },
    },
  });

  assert.equal(resolved.mentionedBot, true);
  assert.equal(resolved.hasExplicitMention, true);
});

test("matrix formatter accepts display-name matrix.to mentions", () => {
  const resolved = resolveInboundMatrixMentions({
    text: "hello there",
    userId: "@bot:example.org",
    displayName: "Bot User",
    content: {
      body: "hello there",
      formatted_body:
        '<a href="https://matrix.to/#/%40bot%3Aexample.org">Bot User</a>: hello there',
      "m.mentions": { user_ids: ["@bot:example.org"] },
    },
  });

  assert.equal(resolved.mentionedBot, true);
  assert.equal(resolved.hasExplicitMention, true);
});
