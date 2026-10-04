/**
 * `audio`: transcribe, speak and the voice mode, as one tool -- docs/architecture.md (Voice).
 *
 * They were `stt`, `tts` and `voice_mode`, three definitions on every request of the orchestrator
 * for three rare calls (2026-10-04). What each action owns did not change: forwarding its
 * arguments, and mapping the pipeline's answer onto the tool result.
 */

import { describe, test, expect } from "bun:test";
import { createAudioTool } from "../../src/tools/audio.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
import { SttPipeline } from "../../src/voice/stt.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

function createConfig(overrides?: Record<string, unknown>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test" },
    ...overrides,
  } as MyClawConfig;
}

function tool(parts: { stt?: unknown; tts?: unknown; manager?: VoiceManager } = {}) {
  const manager = parts.manager ?? new VoiceManager(createConfig());
  return createAudioTool({
    stt: (parts.stt ?? new SttPipeline(manager)) as SttPipeline,
    tts: (parts.tts ?? new TtsPipeline(manager)) as TtsPipeline,
    manager,
  });
}

describe("audio: speak", () => {
  test("refuses an empty text", async () => {
    const result = await tool().execute({ action: "speak", text: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("speak needs text");
  });

  // A stub pipeline asserts what the tool owns: forwarding the arguments, and mapping a generated
  // file to output + an audio attachment. The real edge-tts binary would call Microsoft.
  test("forwards the arguments and returns the generated file as a draft the answer sends", async () => {
    const calls: Array<{ text: string; voice?: string; forceCloud?: boolean }> = [];
    const tts = {
      generate: async (text: string, opts?: { voice?: string; forceCloud?: boolean }) => {
        calls.push({ text, voice: opts?.voice, forceCloud: opts?.forceCloud });
        return { path: "/tmp/generated.mp3", mimeType: "audio/mpeg" };
      },
    };

    const result = await tool({ tts }).execute({ action: "speak", text: "hello world", voice: "fr-FR-RemyMultilingualNeural", forceCloud: true });

    expect(calls).toEqual([{ text: "hello world", voice: "fr-FR-RemyMultilingualNeural", forceCloud: true }]);
    expect(result.success).toBe(true);
    // The path, and how to send it: the reply carries only what the answer names (docs/tool-images.md).
    expect(result.output).toContain("/tmp/generated.mp3");
    expect(result.output).toContain("MEDIA:/tmp/generated.mp3");
    expect(result.attachments).toEqual([{ type: "audio", path: "/tmp/generated.mp3", mimeType: "audio/mpeg" }]);
    expect(result.keepFromReply).toBe(true);
  });

  test("a pipeline failure becomes a tool error, not a throw", async () => {
    const tts = { generate: async () => { throw new Error("TTS cloud failed: edge-tts missing"); } };
    const result = await tool({ tts }).execute({ action: "speak", text: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("TTS cloud failed");
  });
});

describe("audio: transcribe", () => {
  test("forwards the file and the language, and answers with the text", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const stt = {
      transcribe: async (path: string, language?: string) => {
        calls.push([path, language]);
        return { text: "bonjour" };
      },
    };
    const result = await tool({ stt }).execute({ action: "transcribe", filePath: "/tmp/a.ogg", language: "fr" });
    expect(result).toEqual({ success: true, output: "bonjour" });
    expect(calls).toEqual([["/tmp/a.ogg", "fr"]]);
  });

  test("leaves the language to the transcriber when none is given", async () => {
    const calls: Array<string | undefined> = [];
    const stt = { transcribe: async (_path: string, language?: string) => { calls.push(language); return { text: "x" }; } };
    await tool({ stt }).execute({ action: "transcribe", filePath: "/tmp/a.ogg" });
    expect(calls).toEqual([undefined]);
  });

  test("refuses a call without a file", async () => {
    const result = await tool().execute({ action: "transcribe" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("transcribe needs filePath");
  });
});

describe("audio: mode", () => {
  test("rejects an invalid mode", async () => {
    const result = await tool().execute({ action: "mode", mode: "invalid" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid mode");
  });

  test("sets the global mode", async () => {
    const manager = new VoiceManager(createConfig({ voice: { mode: "cloud" } }));
    const result = await tool({ manager }).execute({ action: "mode", mode: "local", feature: "all" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Global voice mode set to local");
    expect(manager.resolveMode("stt")).toBe("local");
  });

  test("sets one side's mode, and only that side", async () => {
    const manager = new VoiceManager(createConfig({ voice: { mode: "cloud" } }));
    const result = await tool({ manager }).execute({ action: "mode", mode: "local", feature: "stt" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Voice stt mode set to local");
    expect(manager.resolveMode("stt")).toBe("local");
    expect(manager.resolveMode("tts")).toBe("cloud");
  });

  test("refuses a side it does not know rather than setting the global mode", async () => {
    const manager = new VoiceManager(createConfig({ voice: { mode: "cloud" } }));
    const result = await tool({ manager }).execute({ action: "mode", mode: "local", feature: "video" });
    expect(result.success).toBe(false);
    expect(manager.resolveMode("stt")).toBe("cloud");
  });
});

test("an action it does not know is refused", async () => {
  const result = await tool().execute({ action: "sing", text: "hello" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("transcribe, speak or mode");
});
