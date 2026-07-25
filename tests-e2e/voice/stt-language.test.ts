// E2E STT tests: real speech synthesized with edge-tts, transcribed by the real Groq
// Whisper endpoint. Requires network, the edge-tts binary and GROQ_API_KEY.
// Run with: VOICE_E2E=1 bun test tests-e2e/voice/*.test.ts

import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SttPipeline } from "../../src/voice/stt.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const E2E_ENABLED = process.env.VOICE_E2E === "1" && Boolean(process.env.GROQ_API_KEY);

function cloudConfig(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test" },
    voice: { mode: "cloud", stt: { language: "fr" } },
  } as unknown as MyClawConfig;
}

/** Speaks a sentence to an mp3 so the transcriber gets real audio, not a synthetic tone
 *  (Whisper returns nothing useful on a sine wave, which would test nothing). */
async function speak(dir: string, text: string, voice: string, name: string): Promise<string> {
  const out = join(dir, name);
  const proc = Bun.spawn(["edge-tts", "--voice", voice, "--text", text, "--write-media", out], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`edge-tts failed: ${await new Response(proc.stderr).text()}`);
  const info = await stat(out);
  if (info.size === 0) throw new Error("edge-tts produced an empty file");
  return out;
}

describe.skipIf(!E2E_ENABLED)("Voice E2E: STT language handling", () => {
  let dir: string;
  let pipeline: SttPipeline;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "voice-e2e-"));
    pipeline = new SttPipeline(new VoiceManager(cloudConfig()));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a French voice note transcribes correctly with the language pinned", async () => {
    const path = await speak(
      dir,
      "Bonjour, ceci est un test de transcription automatique.",
      "fr-FR-RemyMultilingualNeural",
      "fr.mp3",
    );
    const result = await pipeline.transcribe(path, "fr");
    assert.match(result.text.toLowerCase(), /transcription/, `got: ${result.text}`);
  }, 60000);

  test("English audio is transcribed correctly when the language is auto-detected", async () => {
    // This is what the policy protects: arbitrary audio must NOT inherit the owner's
    // configured language, and auto-detection has to actually work for it.
    const path = await speak(
      dir,
      "The quick brown fox jumps over the lazy dog.",
      "en-US-AriaNeural",
      "en.mp3",
    );
    const result = await pipeline.transcribe(path);
    assert.match(result.text.toLowerCase(), /fox/, `got: ${result.text}`);
  }, 60000);
});
