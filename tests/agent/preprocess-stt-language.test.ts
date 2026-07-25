import { describe, test, expect } from "bun:test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagePreprocessor } from "../../src/agent/preprocess.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { SttPipeline } from "../../src/voice/stt.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

function createConfig(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test" },
    voice: { mode: "cloud", stt: { language: "fr", echoTranscript: false } },
  } as unknown as MyClawConfig;
}

async function audioFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pp-stt-"));
  const filePath = join(dir, "clip.ogg");
  await writeFile(filePath, Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00]));
  return filePath;
}

function message(overrides: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    platform: "matrix",
    userId: "user1",
    chatId: "chat1",
    chatType: "dm",
    text: "",
    attachments: [],
    isForwarded: false,
    raw: {},
    ...overrides,
  } as UnifiedMessage;
}

/** Runs the real preprocessor and reports the language it put on the wire. */
async function languageSentFor(audioAsVoice: boolean | undefined): Promise<string | null> {
  const path = await audioFixture();
  const config = createConfig();
  const voiceManager = new VoiceManager(config);
  const pipeline = new SttPipeline(voiceManager);
  const preprocessor = new MessagePreprocessor(voiceManager, pipeline);

  let sent: string | null = null;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("groq.com")) {
      sent = (init?.body as FormData).get("language") as string | null;
      return new Response(JSON.stringify({ text: "bonjour" }), { status: 200 });
    }
    return original(url as string, init);
  }) as unknown as typeof fetch;

  try {
    process.env.GROQ_API_KEY = "test-key";
    await preprocessor.preprocessMessage(
      message({ attachments: [{ type: "audio", path, mimeType: "audio/ogg", audioAsVoice }] }),
    );
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

describe("STT language policy in preprocessing", () => {
  test("a voice note uses the configured language", async () => {
    expect(await languageSentFor(true)).toBe("fr");
  });

  test("any other audio file is auto-detected, never forced", async () => {
    // The whole point: a forwarded recording can be in any language, and a forced mismatch
    // makes Whisper return confident nonsense instead of an error.
    expect(await languageSentFor(undefined)).toBeNull();
    expect(await languageSentFor(false)).toBeNull();
  });
});
