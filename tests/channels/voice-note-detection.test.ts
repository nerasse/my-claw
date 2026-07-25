import { describe, test, expect } from "bun:test";
import { isMatrixVoiceMessage } from "../../src/channels/matrix/helpers.ts";

describe("voice note detection", () => {
  test("matrix: the MSC3245 marker identifies a voice message", () => {
    expect(isMatrixVoiceMessage({ msgtype: "m.audio", "org.matrix.msc3245.voice": {} })).toBe(true);
  });

  test("matrix: the older MSC2516 marker is honoured too", () => {
    expect(isMatrixVoiceMessage({ msgtype: "m.audio", "org.matrix.msc2516.voice": {} })).toBe(true);
  });

  test("matrix: a plain audio upload is not a voice note", () => {
    // This is the case that must keep auto-detection: a shared mp3 can be in any language.
    expect(isMatrixVoiceMessage({ msgtype: "m.audio", body: "podcast.mp3" })).toBe(false);
    expect(isMatrixVoiceMessage({ msgtype: "m.file" })).toBe(false);
    expect(isMatrixVoiceMessage({})).toBe(false);
  });
});
