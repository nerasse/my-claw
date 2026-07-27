import { describe, test, expect } from "bun:test";
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

/** Removes GROQ_API_KEY for one test and gives back a restore. Deleting it without restoring
 *  leaked out of this file and disabled any later test that needs the key. */
function takeGroqKey(): () => void {
  const saved = process.env["GROQ_API_KEY"];
  delete process.env["GROQ_API_KEY"];
  return () => {
    if (saved === undefined) delete process.env["GROQ_API_KEY"];
    else process.env["GROQ_API_KEY"] = saved;
  };
}

describe("SttPipeline", () => {
  describe("transcribe", () => {
    test("throws when cloud mode fails", async () => {
      const originalKey = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "invalid-key";
      try {
        const config = createConfig({ voice: { mode: "cloud" } });
        const manager = new VoiceManager(config);
        const pipeline = new SttPipeline(manager);

        await expect(pipeline.transcribe("/tmp/nonexistent.ogg")).rejects.toThrow("STT cloud failed");
      } finally {
        if (originalKey) {
          process.env.GROQ_API_KEY = originalKey;
        } else {
          delete process.env.GROQ_API_KEY;
        }
      }
    });

    test("throws when local mode fails (no server)", async () => {
      const restoreKey = takeGroqKey();
      const config = createConfig({ voice: { mode: "local" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      try {
        await expect(pipeline.transcribe("/tmp/nonexistent.ogg")).rejects.toThrow("STT local failed");
      } finally {
        restoreKey();
      }
    });
  });

  describe("transcribeWithFallback", () => {
    test("returns error object on failure instead of throwing", async () => {
      const restoreKey = takeGroqKey();
      const config = createConfig({ voice: { mode: "local" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      try {
        const result = await pipeline.transcribeWithFallback("/tmp/nonexistent.ogg");
        expect(result.error).toBeDefined();
        expect(result.text).toBe("");
      } finally {
        restoreKey();
      }
    });
  });
});
