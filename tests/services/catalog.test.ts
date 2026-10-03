/**
 * Each optional service: cloud by default, an engine this install runs, or the owner's URL --
 * docs/services.md. The server reads a URL and never learns how it is hosted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import type { MyClawConfig } from "../../src/core/config.ts";
import { piperEndpoint, probeService, serviceStates, whisperEndpoint, type ServiceId } from "../../src/services/catalog.ts";
import { reconcileUnits, type Systemctl } from "../../src/services/on-demand.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { SttPipeline } from "../../src/voice/stt.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const NATIVE = { MY_CLAW_INSTALL: "native" };
const COMPOSE = { MY_CLAW_INSTALL: "compose" };

function config(over: Partial<MyClawConfig> = {}): MyClawConfig {
  return { voice: { stt: { mode: "cloud" }, tts: { mode: "cloud" } }, ...over } as MyClawConfig;
}

function state(c: MyClawConfig, env: Record<string, string>, id: ServiceId) {
  return serviceStates(c, env).find((s) => s.id === id)!;
}

const savedGroq = process.env.GROQ_API_KEY;
const savedInstall = process.env.MY_CLAW_INSTALL;
beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.MY_CLAW_INSTALL;
});
afterEach(() => {
  for (const [k, v] of [["GROQ_API_KEY", savedGroq], ["MY_CLAW_INSTALL", savedInstall]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the defaults", () => {
  test("a fresh install: voice in the cloud, embeddings and search off, the browser its own", () => {
    const states = serviceStates(config(), { ...NATIVE, GROQ_API_KEY: "gsk" });
    expect(Object.fromEntries(states.map((s) => [s.id, s.source]))).toEqual({
      stt: "cloud",
      tts: "cloud",
      embeddings: "off",
      search: "off",
      browser: "self-hosted",
    });
    expect(states.every((s) => s.missing.length === 0)).toBe(true);
  });

  test("what a cloud source still needs is named", () => {
    expect(state(config(), NATIVE, "stt").missing).toEqual(["GROQ_API_KEY"]);
    const embedding = { model: "text-embedding-3-small", backend: "http" as const, baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" };
    const cloud = state(config({ memory: { embedding } } as Partial<MyClawConfig>), NATIVE, "embeddings");
    expect(cloud).toMatchObject({ source: "cloud", endpoint: "https://api.openai.com/v1", missing: ["OPENAI_API_KEY"] });
  });
});

describe("a self-hosted engine is where the install runs it, an owner's URL wins", () => {
  test("Whisper: on this machine, in the compose network, or at the owner's URL", () => {
    const local = { stt: { mode: "local" as const } };
    expect(whisperEndpoint(local, NATIVE)).toBe("http://127.0.0.1:8000");
    expect(whisperEndpoint(local, COMPOSE)).toBe("http://whisper:8000");
    expect(whisperEndpoint({ stt: { mode: "local", url: "https://stt.example.net/" } }, NATIVE)).toBe("https://stt.example.net");
    expect(state(config({ voice: local }), COMPOSE, "stt")).toMatchObject({ source: "self-hosted", endpoint: "http://whisper:8000" });
    expect(state(config({ voice: { stt: { mode: "local", url: "https://stt.example.net" } } }), NATIVE, "stt").source).toBe("url");
  });

  test("Piper: the binary on bare metal, a server in compose or at a URL", () => {
    expect(piperEndpoint({}, NATIVE)).toBeUndefined();
    expect(piperEndpoint({}, COMPOSE)).toBe("http://piper:5000");
    expect(piperEndpoint({ tts: { url: "http://10.0.0.5:5000" } }, NATIVE)).toBe("http://10.0.0.5:5000");
  });

  test("the bare-metal unit is not started for a Whisper that lives elsewhere", async () => {
    process.env.MY_CLAW_INSTALL = "native";
    const actions: string[][] = [];
    const systemctl: Systemctl = async (args) => {
      if (args[0] === "is-enabled") return { code: 1, stdout: "disabled" };
      if (args[0] === "is-active") return { code: 3, stdout: "inactive" };
      actions.push(args);
      return { code: 0, stdout: "" };
    };
    await reconcileUnits(config({ voice: { stt: { mode: "local", url: "https://stt.example.net" } } }), systemctl);
    expect(actions).toEqual([]);
    await reconcileUnits(config({ voice: { stt: { mode: "local" } } }), systemctl);
    expect(actions).toEqual([["enable", "--now", "my-claw-whisper.service"]]);
  });
});

describe("the engines are called at the URL the catalogue gives", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  test("speech-to-text posts the note to the owner's Whisper", async () => {
    const seen: string[] = [];
    restore = mockFetch(async (input) => {
      seen.push(String(input));
      return Response.json({ text: "bonjour" });
    }).restore;
    const dir = await mkdtemp(join(tmpdir(), "stt-"));
    const file = join(dir, "note.ogg");
    await writeFile(file, new Uint8Array([1, 2, 3]));
    const stt = new SttPipeline(new VoiceManager(config({ voice: { stt: { mode: "local", url: "http://stt.lan:9000" } } })));
    expect((await stt.transcribe(file)).text).toBe("bonjour");
    expect(seen).toEqual(["http://stt.lan:9000/transcribe"]);
  });

  test("text-to-speech asks a Piper server and keeps its WAV", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    restore = mockFetch(async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "Content-Type": "audio/wav" } });
    }).restore;
    const tts = new TtsPipeline(new VoiceManager(config({ voice: { tts: { mode: "local", url: "http://tts.lan:5000" } } })));
    const out = await tts.generate("salut");
    expect(seen).toEqual([{ url: "http://tts.lan:5000/synthesize", body: { text: "salut" } }]);
    expect(out.mimeType).toBe("audio/wav");
    expect([...new Uint8Array(await readFile(out.path))]).toEqual([82, 73, 70, 70]);
  });

  test("a probe: any answer is up, a refused connection is down", async () => {
    restore = mockFetch(async () => new Response("not found", { status: 404 })).restore;
    expect(await probeService({ id: "search", source: "url", endpoint: "http://search.lan", missing: [] })).toBe("up");
    restore();
    restore = mockFetch(async () => {
      throw new TypeError("fetch failed");
    }).restore;
    expect(await probeService({ id: "search", source: "url", endpoint: "http://search.lan", missing: [] })).toBe("down");
    expect(await probeService({ id: "search", source: "off", missing: [] })).toBe("no-endpoint");
  });
});
