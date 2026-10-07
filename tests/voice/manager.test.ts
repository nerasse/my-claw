import { describe, test, expect } from "bun:test";
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

describe("VoiceManager", () => {
  describe("resolveMode", () => {
    test("returns cloud when global mode is cloud", () => {
      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      expect(manager.resolveMode("stt")).toBe("cloud");
      expect(manager.resolveMode("tts")).toBe("cloud");
    });

    test("returns local when global mode is local", () => {
      const config = createConfig({ voice: { mode: "local" } });
      const manager = new VoiceManager(config);
      expect(manager.resolveMode("stt")).toBe("local");
      expect(manager.resolveMode("tts")).toBe("local");
    });

    test("feature mode overrides global mode", () => {
      const config = createConfig({
        voice: { mode: "cloud", stt: { mode: "local" } },
      });
      const manager = new VoiceManager(config);
      expect(manager.resolveMode("stt")).toBe("local");
      expect(manager.resolveMode("tts")).toBe("cloud");
    });

    test("per-call forceCloud overrides everything", () => {
      const config = createConfig({ voice: { mode: "local" } });
      const manager = new VoiceManager(config);
      expect(manager.resolveMode("stt", { forceCloud: true })).toBe("cloud");
    });

    test("per-call forceLocal overrides everything", () => {
      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      expect(manager.resolveMode("tts", { forceLocal: true })).toBe("local");
    });

    test("auto mode with GROQ_API_KEY returns cloud for stt", () => {
      const originalKey = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "test-key";
      try {
        const config = createConfig({ voice: { mode: "auto" } });
        const manager = new VoiceManager(config);
        expect(manager.resolveMode("stt")).toBe("cloud");
      } finally {
        if (originalKey) {
          process.env.GROQ_API_KEY = originalKey;
        } else {
          delete process.env.GROQ_API_KEY;
        }
      }
    });

    test("auto mode without GROQ_API_KEY returns local for stt", () => {
      const originalKey = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      try {
        const config = createConfig({ voice: { mode: "auto" } });
        const manager = new VoiceManager(config);
        expect(manager.resolveMode("stt")).toBe("local");
      } finally {
        if (originalKey) {
          process.env.GROQ_API_KEY = originalKey;
        }
      }
    });

    test("auto mode always returns cloud for tts (no credentials needed)", () => {
      const config = createConfig({ voice: { mode: "auto" } });
      const manager = new VoiceManager(config);
      expect(manager.resolveMode("tts")).toBe("cloud");
    });
  });

  describe("getEchoConfig", () => {
    test("echo enabled by default", () => {
      const config = createConfig();
      const manager = new VoiceManager(config);
      expect(manager.getEchoConfig().enabled).toBe(true);
    });

    test("echo disabled when explicitly set to false", () => {
      const config = createConfig({ voice: { stt: { echoTranscript: false } } });
      const manager = new VoiceManager(config);
      expect(manager.getEchoConfig().enabled).toBe(false);
    });

    test("default format includes transcript placeholder", () => {
      const config = createConfig();
      const manager = new VoiceManager(config);
      expect(manager.getEchoConfig().format).toContain("{transcript}");
    });
  });

  describe("formatEcho", () => {
    test("replaces transcript placeholder", () => {
      const config = createConfig();
      const manager = new VoiceManager(config);
      expect(manager.formatEcho("hello")).toBe('📝 "hello"');
    });

    test("uses custom format", () => {
      const config = createConfig({
        voice: { stt: { echoFormat: "[Voice]: {transcript}" } },
      });
      const manager = new VoiceManager(config);
      expect(manager.formatEcho("hello")).toBe("[Voice]: hello");
    });

    test("keeps dollar sequences of the transcript as spoken", () => {
      const manager = new VoiceManager(createConfig({ voice: { stt: { echoFormat: "[Voice]: {transcript}" } } }));
      expect(manager.formatEcho("it costs 5$' or $& and $$")).toBe("[Voice]: it costs 5$' or $& and $$");
    });
  });

  describe("runtime mutation", () => {
    test("setGlobalMode changes mode immediately", () => {
      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      manager.setGlobalMode("local");
      expect(manager.resolveMode("stt")).toBe("local");
      expect(manager.resolveMode("tts")).toBe("local");
    });

    test("setFeatureMode changes only that feature", () => {
      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      manager.setFeatureMode("stt", "local");
      expect(manager.resolveMode("stt")).toBe("local");
      expect(manager.resolveMode("tts")).toBe("cloud");
    });
  });
});
