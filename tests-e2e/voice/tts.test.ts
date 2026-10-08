// E2E TTS tests: spawns the real edge-tts / piper binaries, and edge-tts calls Microsoft's
// servers. Gated because that made every `bun test` do network I/O, which timed out under load.
// Run with: VOICE_E2E=1 bun test tests-e2e/voice/*.test.ts
//
// The tool-level contract (argument forwarding, attachment mapping, error mapping) is covered
// deterministically with a stub pipeline in tests/tools/voice-tools.test.ts.

import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { TtsPipeline } from "../../src/voice/tts.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const E2E_ENABLED = process.env.VOICE_E2E === "1";
// tests/setup.ts drops GEMINI_API_KEY from every run, so the real key comes under its own name.
const GEMINI_KEY = process.env.GEMINI_E2E_API_KEY;

function seconds(path: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).toString());
}

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

    test.skipIf(!GEMINI_KEY)("Gemini reads a text longer than one piece as one MP3, and a two-voice dialogue", async () => {
      process.env.GEMINI_API_KEY = GEMINI_KEY;
      try {
        const pipeline = new TtsPipeline(new VoiceManager(createConfig({ voice: { tts: { mode: "cloud", provider: "gemini" } } })));
        const paragraph = "Le chiffre d'affaires du trimestre progresse de trente-deux pour cent, et la marge reste stable. ";
        const narration = await pipeline.generate(Array.from({ length: 5 }, () => paragraph.repeat(9)).join("\n\n"));
        expect(narration.mimeType).toBe("audio/mpeg");
        expect(seconds(narration.path)).toBeGreaterThan(60);

        const dialogue = await pipeline.generate("Léa: Alors, ces chiffres ?\nMarc: Plutôt bons, franchement.", {
          speakers: [{ name: "Léa", voice: "fr-fr-podcaster-9" }, { name: "Marc", voice: "fr-fr-podcaster-2" }],
        });
        expect(seconds(dialogue.path)).toBeGreaterThan(1);
      } finally {
        delete process.env.GEMINI_API_KEY;
      }
    }, 300_000);

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
