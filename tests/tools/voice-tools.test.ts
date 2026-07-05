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

  test("attempts generation with valid text", async () => {
    const config = createConfig({ voice: { mode: "cloud" } });
    const manager = new VoiceManager(config);
    const pipeline = new TtsPipeline(manager);
    const tool = createTtsTool(pipeline);

    const result = await tool.execute({ text: "hello world" });
    // May succeed or fail depending on whether edge-tts is installed.
    // We just verify it returns a result (either success or error).
    if (result.success) {
      expect(result.output).toBeDefined();
    } else {
      expect(result.error).toBeDefined();
    }
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
