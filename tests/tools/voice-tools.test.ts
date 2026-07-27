import { describe, test, expect } from "bun:test";
import { createTtsTool } from "../../src/tools/tts.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
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

describe("tts tool", () => {
  test("returns error when text is empty", async () => {
    const config = createConfig();
    const manager = new VoiceManager(config);
    const pipeline = new TtsPipeline(manager);
    const tool = createTtsTool(pipeline);

    const result = await tool.execute({ text: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("text is required");
  });

  // Previously this ran the real edge-tts binary, so it called Microsoft over the network and
  // timed out under load. It also asserted a tautology ("success or error"), which every
  // ToolResult satisfies. A stub pipeline asserts what the tool actually owns: forwarding the
  // arguments, and mapping a generated file to output + an audio attachment.
  test("forwards the arguments and returns the generated file as an audio attachment", async () => {
    const calls: Array<{ text: string; voice?: string; forceCloud?: boolean }> = [];
    const pipeline = {
      generate: async (text: string, opts?: { voice?: string; forceCloud?: boolean }) => {
        calls.push({ text, voice: opts?.voice, forceCloud: opts?.forceCloud });
        return { path: "/tmp/generated.mp3", mimeType: "audio/mpeg" };
      },
    } as unknown as TtsPipeline;

    const result = await createTtsTool(pipeline).execute({ text: "hello world", voice: "fr-FR-RemyMultilingualNeural", forceCloud: true });

    expect(calls).toEqual([{ text: "hello world", voice: "fr-FR-RemyMultilingualNeural", forceCloud: true }]);
    expect(result.success).toBe(true);
    expect(result.output).toBe("/tmp/generated.mp3");
    expect(result.attachments).toEqual([{ type: "audio", path: "/tmp/generated.mp3", mimeType: "audio/mpeg" }]);
  });

  test("a pipeline failure becomes a tool error, not a throw", async () => {
    const pipeline = { generate: async () => { throw new Error("TTS cloud failed: edge-tts missing"); } } as unknown as TtsPipeline;

    const result = await createTtsTool(pipeline).execute({ text: "hello" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("TTS cloud failed");
  });
});

describe("voice_mode tool", () => {
  test("rejects invalid mode", async () => {
    const config = createConfig();
    const manager = new VoiceManager(config);
    const { createVoiceModeTool } = await import("../../src/tools/voice-mode.ts");
    const tool = createVoiceModeTool(manager);

    const result = await tool.execute({ mode: "invalid" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid mode");
  });

  test("sets global mode", async () => {
    const config = createConfig({ voice: { mode: "cloud" } });
    const manager = new VoiceManager(config);
    const { createVoiceModeTool } = await import("../../src/tools/voice-mode.ts");
    const tool = createVoiceModeTool(manager);

    const result = await tool.execute({ mode: "local", feature: "all" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Global voice mode set to local");
    expect(manager.resolveMode("stt")).toBe("local");
  });

  test("sets feature mode", async () => {
    const config = createConfig({ voice: { mode: "cloud" } });
    const manager = new VoiceManager(config);
    const { createVoiceModeTool } = await import("../../src/tools/voice-mode.ts");
    const tool = createVoiceModeTool(manager);

    const result = await tool.execute({ mode: "local", feature: "stt" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Voice stt mode set to local");
    expect(manager.resolveMode("stt")).toBe("local");
    expect(manager.resolveMode("tts")).toBe("cloud");
  });
});
