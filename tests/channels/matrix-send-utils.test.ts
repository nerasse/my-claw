import { describe, test, expect } from "bun:test";
import type { MatrixChannelConfig } from "../../src/core/config.ts";
import type { OutgoingMessage, UnifiedMessage } from "../../src/channels/types.ts";
import {
  msgTypeFromMime,
  mimeFromExt,
  extFromMime,
  outboundTxnId,
  toSdkContent,
  buildMediaContent,
  replyTargetForChunk,
  streamReplyTarget,
  textChunkLimit,
} from "../../src/channels/matrix/send.ts";

function createConfig(overrides?: Partial<MatrixChannelConfig>): MatrixChannelConfig {
  return {
    homeserver: "https://matrix.test",
    accessToken: "test",
    ...overrides,
  } as MatrixChannelConfig;
}

function createOutgoing(overrides?: Partial<OutgoingMessage>): OutgoingMessage {
  return { text: "hello", ...overrides };
}

function createUnified(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "$evt-1",
    platform: "matrix",
    userId: "@user:matrix.test",
    chatId: "!room:matrix.test",
    chatType: "group",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
    ...overrides,
  };
}

describe("msgTypeFromMime", () => {
  test("image/jpeg -> m.image", () => {
    expect(msgTypeFromMime("image/jpeg")).toBe("m.image");
  });

  test("video/mp4 -> m.video", () => {
    expect(msgTypeFromMime("video/mp4")).toBe("m.video");
  });

  test("audio/ogg -> m.audio", () => {
    expect(msgTypeFromMime("audio/ogg")).toBe("m.audio");
  });

  test("application/pdf -> m.file", () => {
    expect(msgTypeFromMime("application/pdf")).toBe("m.file");
  });
});

describe("mimeFromExt", () => {
  test(".jpg -> image/jpeg", () => {
    expect(mimeFromExt(".jpg")).toBe("image/jpeg");
  });

  test(".jpeg -> image/jpeg", () => {
    expect(mimeFromExt(".jpeg")).toBe("image/jpeg");
  });

  test(".png -> image/png", () => {
    expect(mimeFromExt(".png")).toBe("image/png");
  });

  test(".mp4 -> video/mp4", () => {
    expect(mimeFromExt(".mp4")).toBe("video/mp4");
  });

  test(".ogg -> audio/ogg", () => {
    expect(mimeFromExt(".ogg")).toBe("audio/ogg");
  });

  test(".unknown -> application/octet-stream", () => {
    expect(mimeFromExt(".unknown")).toBe("application/octet-stream");
  });
});

describe("extFromMime", () => {
  test("image/jpeg -> .jpg", () => {
    expect(extFromMime("image/jpeg")).toBe(".jpg");
  });

  test("audio/mpeg -> .mp3", () => {
    expect(extFromMime("audio/mpeg")).toBe(".mp3");
  });

  test("unknown/type -> empty string", () => {
    expect(extFromMime("unknown/type")).toBe("");
  });
});

describe("outboundTxnId", () => {
  test("starts with prefix and contains uuid-like segment", () => {
    const id = outboundTxnId("media-test");
    expect(id.startsWith("media-test-")).toBe(true);
    const afterPrefix = id.slice("media-test-".length);
    const parts = afterPrefix.split("-");
    expect(parts.length).toBeGreaterThanOrEqual(5);
  });
});

describe("toSdkContent", () => {
  test("passthrough cast returns same object", () => {
    const obj = { foo: "bar" };
    expect(toSdkContent<typeof obj>(obj)).toBe(obj);
  });
});

describe("buildMediaContent", () => {
  test("basic content with url and info.size", () => {
    const content = buildMediaContent({
      body: "test.jpg",
      msgtype: "m.image",
      url: "mxc://matrix.test/abc",
      size: 1024,
    });
    expect(content["msgtype"]).toBe("m.image");
    expect(content["body"]).toBe("test.jpg");
    expect(content["url"]).toBe("mxc://matrix.test/abc");
    const info = content["info"] as Record<string, unknown>;
    expect(info["size"]).toBe(1024);
  });

  test("encrypted file: no url, has file field", () => {
    const file = {
      url: "mxc://matrix.test/enc",
      key: { k: "key" },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };
    const content = buildMediaContent({
      body: "secret.pdf",
      msgtype: "m.file",
      url: "mxc://matrix.test/enc",
      file,
      size: 2048,
    });
    expect(content["file"]).toBe(file);
    expect(content["url"]).toBeUndefined();
  });

  test("replyToId without threadId produces m.relates_to", () => {
    const content = buildMediaContent({
      body: "reply.jpg",
      msgtype: "m.image",
      url: "mxc://matrix.test/r",
      size: 512,
      replyToId: "$reply-target",
    });
    const rel = content["m.relates_to"] as Record<string, unknown>;
    expect(rel).toBeDefined();
    const inReplyTo = rel["m.in_reply_to"] as Record<string, unknown>;
    expect(inReplyTo["event_id"]).toBe("$reply-target");
  });

  test("threadId uses thread relation", () => {
    const content = buildMediaContent({
      body: "thread.jpg",
      msgtype: "m.image",
      url: "mxc://matrix.test/t",
      size: 256,
      threadId: "$thread-root",
    });
    const rel = content["m.relates_to"] as Record<string, unknown>;
    expect(rel).toBeDefined();
    expect(rel["rel_type"]).toBe("m.thread");
    expect(rel["event_id"]).toBe("$thread-root");
  });
});

describe("replyTargetForChunk", () => {
  test("mode off -> undefined", () => {
    const cfg = createConfig({ replyToMode: "off" });
    const msg = createOutgoing({ replyToId: "$target" });
    expect(replyTargetForChunk(cfg, msg, 0, { chunkCount: 1, hasMedia: false })).toBeUndefined();
  });

  test("mode first, chunk 0 -> replyToId", () => {
    const cfg = createConfig({ replyToMode: "first" });
    const msg = createOutgoing({ replyToId: "$target" });
    expect(replyTargetForChunk(cfg, msg, 0, { chunkCount: 2, hasMedia: false })).toBe("$target");
  });

  test("mode first, chunk 1 -> undefined", () => {
    const cfg = createConfig({ replyToMode: "first" });
    const msg = createOutgoing({ replyToId: "$target" });
    expect(replyTargetForChunk(cfg, msg, 1, { chunkCount: 2, hasMedia: false })).toBeUndefined();
  });

  test("mode all -> always replyToId", () => {
    const cfg = createConfig({ replyToMode: "all" });
    const msg = createOutgoing({ replyToId: "$target" });
    expect(replyTargetForChunk(cfg, msg, 3, { chunkCount: 5, hasMedia: false })).toBe("$target");
  });

  test("threadId present -> undefined (thread takes priority)", () => {
    const cfg = createConfig({ replyToMode: "all" });
    const msg = createOutgoing({ replyToId: "$target", threadId: "$thread" });
    expect(replyTargetForChunk(cfg, msg, 0, { chunkCount: 1, hasMedia: false })).toBeUndefined();
  });
});

describe("streamReplyTarget", () => {
  test("mode off -> undefined", () => {
    const cfg = createConfig({ replyToMode: "off" });
    const msg = createUnified();
    expect(streamReplyTarget(cfg, msg)).toBeUndefined();
  });

  test("mode first -> message.id", () => {
    const cfg = createConfig({ replyToMode: "first" });
    const msg = createUnified({ id: "$stream-evt" });
    expect(streamReplyTarget(cfg, msg)).toBe("$stream-evt");
  });

  test("threadId present -> undefined", () => {
    const cfg = createConfig({ replyToMode: "all" });
    const msg = createUnified({ threadId: "$thread" });
    expect(streamReplyTarget(cfg, msg)).toBeUndefined();
  });
});

describe("textChunkLimit", () => {
  test("default -> 4000", () => {
    const cfg = createConfig();
    expect(textChunkLimit(cfg)).toBe(4000);
  });

  test("custom value -> that value", () => {
    const cfg = createConfig({ textChunkLimit: 8000 });
    expect(textChunkLimit(cfg)).toBe(8000);
  });

  test("zero -> 4000", () => {
    const cfg = createConfig({ textChunkLimit: 0 });
    expect(textChunkLimit(cfg)).toBe(4000);
  });

  test("negative -> 4000", () => {
    const cfg = createConfig({ textChunkLimit: -1 });
    expect(textChunkLimit(cfg)).toBe(4000);
  });

  test("non-number -> 4000", () => {
    const cfg = createConfig({ textChunkLimit: "abc" as unknown as number });
    expect(textChunkLimit(cfg)).toBe(4000);
  });
});
