import { describe, test, expect, mock } from "bun:test";
import { SttPipeline } from "../../src/voice/stt.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSttTool } from "../../src/tools/stt.ts";

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

async function audioFixture(name = "voice.ogg"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stt-lang-"));
  const filePath = join(dir, name);
  await writeFile(filePath, Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00]));
  return filePath;
}

/** Captures the multipart body the pipeline actually puts on the wire. */
function captureUpload(host: string, body: unknown = { text: "bonjour" }) {
  const calls: FormData[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (String(url).includes(host)) {
      calls.push(init?.body as FormData);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return original(url as string, init);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("STT language selection", () => {
  test("cloud: a language is forwarded to Whisper when given", async () => {
    const filePath = await audioFixture();
    const pipeline = new SttPipeline(new VoiceManager(createConfig({ voice: { mode: "cloud" } })));
    const capture = captureUpload("groq.com");
    try {
      process.env.GROQ_API_KEY = "test-key";
      await pipeline.transcribe(filePath, "fr");
      expect(capture.calls[0]!.get("language")).toBe("fr");
    } finally {
      capture.restore();
    }
  });

  test("cloud: no language means auto-detect, so the field must be absent", async () => {
    const filePath = await audioFixture();
    // Config pins fr, but a caller that passes nothing must still get auto-detection:
    // the policy lives in the caller, not in the pipeline.
    const pipeline = new SttPipeline(
      new VoiceManager(createConfig({ voice: { mode: "cloud", stt: { language: "fr" } } })),
    );
    const capture = captureUpload("groq.com");
    try {
      process.env.GROQ_API_KEY = "test-key";
      await pipeline.transcribe(filePath);
      expect(capture.calls[0]!.get("language")).toBeNull();
    } finally {
      capture.restore();
    }
  });

  test("local: the language reaches the faster-whisper endpoint too", async () => {
    const filePath = await audioFixture();
    const pipeline = new SttPipeline(new VoiceManager(createConfig({ voice: { mode: "local" } })));
    const capture = captureUpload("127.0.0.1");
    try {
      await pipeline.transcribe(filePath, "es");
      expect(capture.calls[0]!.get("language")).toBe("es");
    } finally {
      capture.restore();
    }
  });

  test("local: omitting the language leaves the field out", async () => {
    const filePath = await audioFixture();
    const pipeline = new SttPipeline(new VoiceManager(createConfig({ voice: { mode: "local" } })));
    const capture = captureUpload("127.0.0.1");
    try {
      await pipeline.transcribe(filePath);
      expect(capture.calls[0]!.get("language")).toBeNull();
    } finally {
      capture.restore();
    }
  });

  test("voiceNoteLanguage exposes the configured language", () => {
    const configured = new SttPipeline(
      new VoiceManager(createConfig({ voice: { stt: { language: "fr" } } })),
    );
    const bare = new SttPipeline(new VoiceManager(createConfig()));
    expect(configured.voiceNoteLanguage()).toBe("fr");
    expect(bare.voiceNoteLanguage()).toBeUndefined();
  });

  test("the stt tool forwards an explicit language and defaults to auto", async () => {
    const filePath = await audioFixture();
    const pipeline = new SttPipeline(
      new VoiceManager(createConfig({ voice: { mode: "cloud", stt: { language: "fr" } } })),
    );
    const tool = createSttTool(pipeline);
    const capture = captureUpload("groq.com");
    try {
      process.env.GROQ_API_KEY = "test-key";
      await tool.execute({ filePath, language: "en" });
      expect(capture.calls[0]!.get("language")).toBe("en");

      await tool.execute({ filePath });
      expect(capture.calls[1]!.get("language")).toBeNull();
    } finally {
      capture.restore();
    }
  });
});
