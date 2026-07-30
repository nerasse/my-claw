import { describe, test, expect } from "bun:test";
import { MessagePreprocessor } from "../../src/agent/preprocess.ts";
import type { UnifiedMessage, Attachment } from "../../src/channels/types.ts";

function createMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    platform: "telegram",
    userId: "user1",
    chatId: "chat1",
    chatType: "dm",
    text: "",
    attachments: [],
    isForwarded: false,
    raw: {},
    ...overrides,
  };
}

describe("MessagePreprocessor", () => {
  describe("buildUserContent", () => {
    const pp = new MessagePreprocessor();

    test("plain text message returns just the text", () => {
      const msg = createMessage({ text: "hello world" });
      expect(pp.buildUserContent(msg)).toBe("hello world");
    });

    test("message with reply context includes [Reply] prefix", () => {
      const msg = createMessage({
        text: "my reply",
        replyToText: "original message",
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("[Reply]");
      expect(result).toContain("original message");
      expect(result).toContain("my reply");
    });

    test("message with reply context from named sender includes [Reply from @sender]", () => {
      const msg = createMessage({
        text: "responding",
        replyToText: "what they said",
        replyToSender: "@alice",
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("[Reply from @alice]");
      expect(result).toContain("what they said");
    });

    test("message with thread root text includes [Thread Root]", () => {
      const msg = createMessage({
        text: "thread reply",
        threadRootText: "the original thread starter",
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("[Thread Root]");
      expect(result).toContain("the original thread starter");
      expect(result).toContain("thread reply");
    });

    test("message with roomContext includes room context", () => {
      const msg = createMessage({
        text: "hello",
        roomContext: "This is the #general channel for project updates.",
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("This is the #general channel for project updates.");
      expect(result).toContain("hello");
    });

    test("message with image attachment includes [Attachments] section", () => {
      const msg = createMessage({
        text: "look at this",
        attachments: [
          {
            type: "image",
            path: "/tmp/photo.jpg",
            mimeType: "image/jpeg",
            width: 800,
            height: 600,
          },
        ],
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("[Attachments]");
      expect(result).toContain("image");
      expect(result).toContain("/tmp/photo.jpg");
      expect(result).toContain("image/jpeg");
      expect(result).toContain("800x600");
    });

    test("audio attachment is filtered from visible attachments", () => {
      const msg = createMessage({
        text: "voice note",
        attachments: [
          { type: "audio", path: "/tmp/voice.ogg", mimeType: "audio/ogg" },
        ],
      });
      const result = pp.buildUserContent(msg);
      expect(result).not.toContain("[Attachments]");
      expect(result).not.toContain("audio");
      expect(result).toBe("voice note");
    });

    test("multiple attachment types (image + document) are both listed", () => {
      const msg = createMessage({
        text: "files",
        attachments: [
          { type: "image", path: "/tmp/pic.png", mimeType: "image/png" },
          { type: "file", path: "/tmp/doc.pdf", mimeType: "application/pdf", filename: "doc.pdf", sizeBytes: 1024 },
        ],
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("[Attachments]");
      expect(result).toContain("image: /tmp/pic.png");
      expect(result).toContain("file: /tmp/doc.pdf");
      expect(result).toContain("1024 bytes");
      expect(result).toContain("doc.pdf");
    });

    test("all context combined: reply + thread + room + attachments", () => {
      const msg = createMessage({
        text: "full context",
        replyToText: "quoted text",
        replyToSender: "@bob",
        threadRootText: "thread starter",
        roomContext: "Room: #dev",
        attachments: [
          { type: "image", path: "/tmp/img.jpg", mimeType: "image/jpeg" },
        ],
      });
      const result = pp.buildUserContent(msg);
      const replyIdx = result.indexOf("[Reply from @bob]");
      const threadIdx = result.indexOf("[Thread Root]");
      const roomIdx = result.indexOf("Room: #dev");
      const attachIdx = result.indexOf("[Attachments]");
      const textIdx = result.indexOf("full context");

      expect(replyIdx).toBeGreaterThanOrEqual(0);
      expect(threadIdx).toBeGreaterThan(replyIdx);
      expect(roomIdx).toBeGreaterThan(threadIdx);
      expect(textIdx).toBeGreaterThan(roomIdx);
      expect(attachIdx).toBeGreaterThan(textIdx);
    });

    test("empty text with attachments still includes attachment section", () => {
      const msg = createMessage({
        text: "",
        attachments: [
          { type: "file", path: "/tmp/data.csv", mimeType: "text/csv" },
        ],
      });
      const result = pp.buildUserContent(msg);
      expect(result).toContain("[Attachments]");
      expect(result).toContain("file: /tmp/data.csv");
    });

    // Regression: the owner pasted a message ending in five U+200B from LinkedIn and the whole
    // turn became a [BLOCKED] marker, question included. See docs/anti-injection.md.
    test("trailing zero-width spaces are cleaned, and the question survives", () => {
      const msg = createMessage({ text: "Relis ma fiche de poste\u200b\u200b\u200b\u200b\u200b" });
      const result = pp.buildUserContent(msg);
      expect(result).toBe("Relis ma fiche de poste");
      expect(result).not.toContain("BLOCKED");
    });






  });

  describe("consumeEchoMessages", () => {
    test("returns empty array initially", () => {
      const pp = new MessagePreprocessor();
      expect(pp.consumeEchoMessages("m0")).toEqual([]);
    });

    test("returns echoes and clears them on second call", async () => {
      const pp = new MessagePreprocessor(undefined, undefined);
      const msg = createMessage({
        text: "hello",
        attachments: [{ type: "audio", path: "/tmp/a.ogg" }],
      });
      await pp.preprocessMessage(msg);
      const first = pp.consumeEchoMessages(msg.id);
      const second = pp.consumeEchoMessages(msg.id);
      expect(Array.isArray(first)).toBe(true);
      expect(second).toEqual([]);
    });
  });

  describe("consumeResponseAttachments", () => {
    test("returns empty array initially", () => {
      const pp = new MessagePreprocessor();
      expect(pp.consumeResponseAttachments("m0")).toEqual([]);
    });

    test("after addResponseAttachment, returns the attachment and clears", () => {
      const pp = new MessagePreprocessor();
      const att: Attachment = { type: "image", path: "/tmp/result.png", mimeType: "image/png" };
      pp.addResponseAttachment("m1", att);

      const first = pp.consumeResponseAttachments("m1");
      expect(first).toHaveLength(1);
      expect(first![0]).toEqual(att);

      const second = pp.consumeResponseAttachments("m1");
      expect(second).toEqual([]);
    });

    test("attachments are isolated per message id (no cross-run leakage)", () => {
      const pp = new MessagePreprocessor();
      pp.addResponseAttachment("run-a", { type: "image", path: "/tmp/a.png", mimeType: "image/png" });
      pp.addResponseAttachment("run-b", { type: "image", path: "/tmp/b.png", mimeType: "image/png" });

      const a = pp.consumeResponseAttachments("run-a");
      expect(a).toHaveLength(1);
      expect(a![0]!.path).toBe("/tmp/a.png");
      // run-b's bucket is untouched by consuming run-a.
      const b = pp.consumeResponseAttachments("run-b");
      expect(b).toHaveLength(1);
      expect(b![0]!.path).toBe("/tmp/b.png");
    });
  });

  describe("preprocessMessage", () => {
    test("no audio attachments: inboundHadAudio is false, text unchanged", async () => {
      const pp = new MessagePreprocessor();
      const msg = createMessage({ text: "just text" });
      await pp.preprocessMessage(msg);
      expect(pp.inboundHadAudio(msg.id)).toBe(false);
      expect(msg.text).toBe("just text");
    });

    test("audio attachment but no voiceManager/sttPipeline appends not-configured notice", async () => {
      const pp = new MessagePreprocessor(undefined, undefined);
      const msg = createMessage({
        text: "check this",
        attachments: [{ type: "audio", path: "/tmp/voice.ogg", mimeType: "audio/ogg" }],
      });
      await pp.preprocessMessage(msg);
      expect(pp.inboundHadAudio(msg.id)).toBe(false);
      expect(msg.text).toContain("[Audio]: [voice/STT not configured]");
      expect(msg.text).toContain("check this");
    });

    test("audio attachment without path appends unavailable notice", async () => {
      const voiceManager = {
        getEchoConfig: () => ({ enabled: false }),
      } as never;
      const sttPipeline = {} as never;

      const pp = new MessagePreprocessor(voiceManager, sttPipeline);
      const msg = createMessage({
        text: "",
        attachments: [{ type: "audio", mimeType: "audio/ogg" }],
      });
      await pp.preprocessMessage(msg);
      expect(pp.inboundHadAudio(msg.id)).toBe(true);
      expect(msg.text).toContain("[Audio]: [unavailable");
    });

    test("deduplication: calling preprocessMessage twice with same id is a no-op", async () => {
      const pp = new MessagePreprocessor(undefined, undefined);
      const msg = createMessage({
        id: "dedup-test",
        text: "original",
        attachments: [{ type: "audio", path: "/tmp/a.ogg" }],
      });

      await pp.preprocessMessage(msg);
      const textAfterFirst = msg.text;

      msg.text = "modified externally";
      await pp.preprocessMessage(msg);
      expect(msg.text).toBe("modified externally");
    });
  });
});
