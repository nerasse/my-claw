import { describe, test, expect } from "bun:test";

// Matrix normalization helpers
import {
  summarizeEventContent,
  resolveNormalizedInboundText,
  isMediaMsgType,
} from "../../src/channels/matrix/context.ts";
import { stripMatrixReplyFallback, messageBody, normalizeMatrixUserId } from "../../src/channels/matrix/helpers.ts";
import { parseMatrixCommand } from "../../src/channels/matrix/commands.ts";
import { extractMatrixMentions, stripMatrixMentionPrefix } from "../../src/channels/matrix/format.ts";

// Matrix send helpers
import {
  msgTypeFromMime,
  mimeFromExt,
  extFromMime,
  textChunkLimit,
  chunkMode,
  replyTargetForChunk,
} from "../../src/channels/matrix/send.ts";
import type { MatrixChannelConfig } from "../../src/core/config.ts";

// Telegram helpers
import { chunkMatrixText } from "../../src/channels/matrix/text.ts";

describe("Matrix message normalization", () => {
  test("summarizeEventContent extracts body from text message", () => {
    const result = summarizeEventContent({ msgtype: "m.text", body: "hello world" });
    expect(result).toBe("hello world");
  });

  test("summarizeEventContent returns undefined for empty content", () => {
    expect(summarizeEventContent({})).toBeUndefined();
  });

  test("resolveNormalizedInboundText returns text for simple message", () => {
    const content = { msgtype: "m.text", body: "test message" };
    const result = resolveNormalizedInboundText(content, "test message", []);
    expect(result).toBe("test message");
  });

  test("resolveNormalizedInboundText uses caption for media with text", () => {
    const content = { msgtype: "m.image", body: "photo.jpg", filename: "photo.jpg" };
    const result = resolveNormalizedInboundText(content, "look at this photo", [{ type: "image", path: "/tmp/photo.jpg" }]);
    expect(result).toBe("look at this photo");
  });

  test("isMediaMsgType recognizes image/video/audio/file", () => {
    expect(isMediaMsgType("m.image")).toBe(true);
    expect(isMediaMsgType("m.video")).toBe(true);
    expect(isMediaMsgType("m.audio")).toBe(true);
    expect(isMediaMsgType("m.file")).toBe(true);
    expect(isMediaMsgType("m.text")).toBe(false);
    expect(isMediaMsgType("m.notice")).toBe(false);
    expect(isMediaMsgType(undefined)).toBe(false);
  });

  test("stripMatrixReplyFallback removes > prefix lines when hasReplyTo", () => {
    const text = "> reply fallback\n> second line\n\nactual message";
    const result = stripMatrixReplyFallback(text, true);
    expect(result).toBe("actual message");
  });

  test("stripMatrixReplyFallback preserves text when no reply", () => {
    const text = "> this is a quote\nnot a reply";
    const result = stripMatrixReplyFallback(text, false);
    expect(result).toBe("> this is a quote\nnot a reply");
  });

  test("messageBody extracts body field", () => {
    expect(messageBody({ body: "test" })).toBe("test");
    expect(messageBody({})).toBe("");
  });

  test("normalizeMatrixUserId preserves valid user IDs", () => {
    expect(normalizeMatrixUserId("@user:example.org")).toBe("@user:example.org");
    expect(normalizeMatrixUserId("user:example.org")).toBe("user:example.org");
    expect(normalizeMatrixUserId("")).toBe("");
    expect(normalizeMatrixUserId(undefined)).toBe("");
  });

  test("parseMatrixCommand parses /new", () => {
    const result = parseMatrixCommand("/new");
    expect(result.command).toBe("new");
    expect(result.args).toBe("");
  });

  test("parseMatrixCommand parses /model with args", () => {
    const result = parseMatrixCommand("/model gpt-4");
    expect(result.command).toBe("model");
    expect(result.args).toBe("gpt-4");
  });

  test("parseMatrixCommand returns null for non-command text", () => {
    const result = parseMatrixCommand("hello world");
    expect(result).toBeNull();
  });

  test("extractMatrixMentions finds @user:server mentions", () => {
    const result = extractMatrixMentions("hello @alice:example.org how are you");
    expect(result.user_ids.length).toBeGreaterThanOrEqual(1);
    expect(result.user_ids).toContain("@alice:example.org");
  });

  test("stripMatrixMentionPrefix strips display name prefix", () => {
    const result = stripMatrixMentionPrefix({
      text: "Bot: hello world",
      displayName: "Bot",
    });
    expect(result).toBe("hello world");
  });

  test("stripMatrixMentionPrefix preserves text without prefix", () => {
    const result = stripMatrixMentionPrefix({
      text: "hello world",
      displayName: "Bot",
    });
    expect(result).toBe("hello world");
  });
});

describe("Matrix send helpers", () => {
  test("msgTypeFromMime maps common types", () => {
    expect(msgTypeFromMime("image/png")).toBe("m.image");
    expect(msgTypeFromMime("image/jpeg")).toBe("m.image");
    expect(msgTypeFromMime("video/mp4")).toBe("m.video");
    expect(msgTypeFromMime("audio/ogg")).toBe("m.audio");
    expect(msgTypeFromMime("application/pdf")).toBe("m.file");
  });

  test("mimeFromExt maps common extensions", () => {
    expect(mimeFromExt(".jpg")).toBe("image/jpeg");
    expect(mimeFromExt(".png")).toBe("image/png");
    expect(mimeFromExt(".mp4")).toBe("video/mp4");
    expect(mimeFromExt(".mp3")).toBe("audio/mpeg");
    expect(mimeFromExt(".ogg")).toBe("audio/ogg");
    expect(mimeFromExt(".xyz")).toBe("application/octet-stream");
  });

  test("extFromMime maps common mimes", () => {
    expect(extFromMime("image/jpeg")).toBe(".jpg");
    expect(extFromMime("image/png")).toBe(".png");
    expect(extFromMime("video/mp4")).toBe(".mp4");
    expect(extFromMime("audio/mpeg")).toBe(".mp3");
    expect(extFromMime("text/plain")).toBe("");
  });

  test("textChunkLimit returns config value or default 4000", () => {
    expect(textChunkLimit({ textChunkLimit: 2000 } as MatrixChannelConfig)).toBe(2000);
    expect(textChunkLimit({} as MatrixChannelConfig)).toBe(4000);
    expect(textChunkLimit({ textChunkLimit: -1 } as MatrixChannelConfig)).toBe(4000);
    expect(textChunkLimit({ textChunkLimit: 0 } as MatrixChannelConfig)).toBe(4000);
  });

  test("chunkMode returns line or plain", () => {
    expect(chunkMode({} as MatrixChannelConfig)).toBe("line");
    expect(chunkMode({ chunkMode: "newline" } as MatrixChannelConfig)).toBe("line");
    expect(chunkMode({ chunkMode: "length" } as MatrixChannelConfig)).toBe("plain");
  });

  test("replyTargetForChunk respects mode settings", () => {
    const base = { replyToId: "reply1" } as Parameters<typeof replyTargetForChunk>[1];

    expect(replyTargetForChunk({ replyToMode: "off" } as MatrixChannelConfig, base, 0, { chunkCount: 1, hasMedia: false }))
      .toBeUndefined();

    expect(replyTargetForChunk({ replyToMode: "first" } as MatrixChannelConfig, base, 0, { chunkCount: 2, hasMedia: false }))
      .toBe("reply1");

    expect(replyTargetForChunk({ replyToMode: "first" } as MatrixChannelConfig, base, 1, { chunkCount: 2, hasMedia: false }))
      .toBeUndefined();
  });
});

describe("Matrix text chunking", () => {
  test("short text is not chunked", () => {
    const result = chunkMatrixText("hello", 100, "line");
    expect(result).toEqual(["hello"]);
  });

  test("long text is split into chunks", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const result = chunkMatrixText(text, 15, "line");
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("\n")).toContain("line1");
    expect(result.join("\n")).toContain("line5");
  });

  test("empty text returns empty array", () => {
    const result = chunkMatrixText("", 100, "line");
    expect(result).toEqual([]);
  });
});
