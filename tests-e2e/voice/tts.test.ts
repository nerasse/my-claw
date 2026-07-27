// E2E TTS tests: spawns the real edge-tts / piper binaries, and edge-tts calls Microsoft's
// servers. Gated because that made every `bun test` do network I/O, which timed out under load.
// Run with: VOICE_E2E=1 bun test tests-e2e/voice/*.test.ts
//
// The tool-level contract (argument forwarding, attachment mapping, error mapping) is covered
// deterministically with a stub pipeline in tests/tools/voice-tools.test.ts.

import { describe, test, expect } from "bun:test";
import { TtsPipeline } from "../../src/voice/tts.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const E2E_ENABLED = process.env.VOICE_E2E === "1";

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

describe.skipIf(!E2E_ENABLED)("TtsPipeline (real binaries)", () => {
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
    }, 30_000);

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
    }, 30_000);
  });
});
