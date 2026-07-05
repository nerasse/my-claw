import { describe, test, expect } from "bun:test";
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

describe("TtsPipeline", () => {
  describe("generate", () => {
    test("cloud mode returns a file path or throws", async () => {
      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      const pipeline = new TtsPipeline(manager);

      try {
        const result = await pipeline.generate("hello");
        expect(result.path).toBeDefined();
        expect(result.mimeType).toBe("audio/mpeg");
      } catch (err) {
        expect(String(err)).toContain("TTS cloud failed");
      }
    });

    test("local mode returns a file path or throws", async () => {
      const config = createConfig({ voice: { mode: "local" } });
      const manager = new VoiceManager(config);
      const pipeline = new TtsPipeline(manager);

      try {
        const result = await pipeline.generate("hello");
        expect(result.path).toBeDefined();
        expect(result.mimeType).toBe("audio/wav");
      } catch (err) {
        expect(String(err)).toContain("TTS local failed");
      }
    });
  });
});
