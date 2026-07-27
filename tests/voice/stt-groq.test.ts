import { describe, test, expect } from "bun:test";
import { SttPipeline } from "../../src/voice/stt.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";

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

describe("SttPipeline Groq upload fixes", () => {
  describe("file extension normalization", () => {
    test("renames .oga to .ogg for Groq", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "stt-test-"));
      const filePath = join(tmpDir, "voice.oga");
      // Write a minimal valid Ogg header (OggS magic + some bytes)
      const oggHeader = Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00]);
      await writeFile(filePath, oggHeader);

      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      // Mock fetch to inspect FormData
      const fetchCalls: Array<{ formData: FormData }> = [];
      const realFetch = globalThis.fetch;
      const fetchMock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("groq.com")) {
          const fd = init?.body as FormData;
          fetchCalls.push({ formData: fd });
          return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
        }
        return realFetch(url as string, init);
      });

      try {
        process.env.GROQ_API_KEY = "test-key";
        await pipeline.transcribe(filePath);

        expect(fetchCalls.length).toBe(1);
        const fileEntry = fetchCalls[0]!.formData.get("file") as File;
        expect(fileEntry).toBeDefined();
        expect(fileEntry.name).toBe("voice.ogg"); // .oga -> .ogg
        expect(fileEntry.type).toBe("audio/ogg");  // forced MIME type
      } finally {
        fetchMock.restore();
        delete process.env.GROQ_API_KEY;
        await unlink(filePath).catch(() => {});
      }
    });

    test("keeps .ogg extension unchanged", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "stt-test-"));
      const filePath = join(tmpDir, "audio.ogg");
      const oggHeader = Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00]);
      await writeFile(filePath, oggHeader);

      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      const fetchCalls: Array<{ formData: FormData }> = [];
      const realFetch = globalThis.fetch;
      const fetchMock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("groq.com")) {
          fetchCalls.push({ formData: init?.body as FormData });
          return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
        }
        return realFetch(url as string, init);
      });

      try {
        process.env.GROQ_API_KEY = "test-key";
        await pipeline.transcribe(filePath);

        expect(fetchCalls.length).toBe(1);
        const fileEntry = fetchCalls[0]!.formData.get("file") as File;
        expect(fileEntry.name).toBe("audio.ogg");
        expect(fileEntry.type).toBe("audio/ogg");
      } finally {
        fetchMock.restore();
        delete process.env.GROQ_API_KEY;
        await unlink(filePath).catch(() => {});
      }
    });
  });

  describe("multi-format support", () => {
    test("accepts non-Ogg formats with correct MIME type", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "stt-test-"));
      const filePath = join(tmpDir, "audio.mp3");
      await writeFile(filePath, Buffer.from("fake mp3 content"));

      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      const fetchCalls: Array<{ formData: FormData }> = [];
      const realFetch = globalThis.fetch;
      const fetchMock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("groq.com")) {
          const fd = init?.body as FormData;
          fetchCalls.push({ formData: fd });
          return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
        }
        return realFetch(url as string, init);
      });

      try {
        process.env.GROQ_API_KEY = "test-key";
        const result = await pipeline.transcribe(filePath);
        expect(result.text).toBe("hello");
        expect(fetchCalls.length).toBe(1);
        const fileEntry = fetchCalls[0]!.formData.get("file") as File;
        expect(fileEntry.type).toBe("audio/mpeg");
      } finally {
        fetchMock.restore();
        delete process.env.GROQ_API_KEY;
        await unlink(filePath).catch(() => {});
      }
    });

    test("accepts valid Ogg files", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "stt-test-"));
      const filePath = join(tmpDir, "voice.ogg");
      const oggHeader = Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00]);
      await writeFile(filePath, oggHeader);

      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      const fetchMock = mockFetch(async () => {
        return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
      });

      try {
        process.env.GROQ_API_KEY = "test-key";
        const result = await pipeline.transcribe(filePath);
        expect(result.text).toBe("hello");
      } finally {
        fetchMock.restore();
        delete process.env.GROQ_API_KEY;
        await unlink(filePath).catch(() => {});
      }
    });
  });

  describe("empty file validation", () => {
    test("throws for empty audio files", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "stt-test-"));
      const filePath = join(tmpDir, "empty.ogg");
      await writeFile(filePath, Buffer.alloc(0));

      const config = createConfig({ voice: { mode: "cloud" } });
      const manager = new VoiceManager(config);
      const pipeline = new SttPipeline(manager);

      try {
        process.env.GROQ_API_KEY = "test-key";
        await expect(pipeline.transcribe(filePath)).rejects.toThrow("empty (0 bytes)");
      } finally {
        delete process.env.GROQ_API_KEY;
        await unlink(filePath).catch(() => {});
      }
    });
  });
});
