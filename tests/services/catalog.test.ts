/**
 * Each optional service: cloud by default, an engine this install runs, or the owner's URL --
 * docs/services.md. The server reads a URL and never learns how it is hosted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import type { MyClawConfig, MemoryConfig } from "../../src/core/config.ts";
import { embeddingActive, embeddingFor } from "../../src/core/config.ts";
import { CLOUD_EMBEDDING, LOCAL_EMBEDDING_MODEL, applyServiceChoice, piperEndpoint, probeService, serviceStates, whisperEndpoint, type ServiceId } from "../../src/services/catalog.ts";
import { onDemandUnits, reconcileUnits, type Systemctl } from "../../src/services/on-demand.ts";

/** Engines already there: a real runtime would download faster-whisper. */
const UNITS = onDemandUnits({ prepare: async () => true });
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
    const states = serviceStates(config(), { ...NATIVE, GROQ_API_KEY: "gsk", GEOAPIFY_API_KEY: "geo" });
    expect(Object.fromEntries(states.map((s) => [s.id, s.source]))).toEqual({
      stt: "cloud",
      tts: "cloud",
      location: "cloud",
      embeddings: "off",
      search: "off",
      browser: "self-hosted",
    });
    expect(states.every((s) => s.missing.length === 0)).toBe(true);
  });

  test("what a cloud source still needs is named", () => {
    expect(state(config(), NATIVE, "stt").missing).toEqual(["GROQ_API_KEY"]);
    // GPS positions become an address through Geoapify: the key is all location needs.
    expect(state(config(), NATIVE, "location")).toMatchObject({ source: "cloud", missing: ["GEOAPIFY_API_KEY"] });
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
    await reconcileUnits(config({ voice: { stt: { mode: "local", url: "https://stt.example.net" } } }), systemctl, UNITS);
    expect(actions).toEqual([]);
    await reconcileUnits(config({ voice: { stt: { mode: "local" } } }), systemctl, UNITS);
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

describe("a choice made in the app, written into config.json", () => {
  const apply = (raw: Record<string, unknown>, choice: Parameters<typeof applyServiceChoice>[1], kind: "native" | "compose" = "native") =>
    applyServiceChoice(raw, choice, kind);

  test("voice: cloud, this install's engine, or the owner's URL -- the URL goes when it is no longer used", () => {
    const raw: Record<string, unknown> = { voice: { stt: { mode: "cloud", language: "fr" } } };
    expect(apply(raw, { id: "stt", source: "url", url: "http://stt.lan:9000/" })).toEqual({ ok: true });
    expect(raw).toEqual({ voice: { stt: { mode: "local", language: "fr", url: "http://stt.lan:9000" } } });
    apply(raw, { id: "stt", source: "self-hosted" });
    expect(raw).toEqual({ voice: { stt: { mode: "local", language: "fr" } } });
    apply(raw, { id: "tts", source: "cloud" });
    expect((raw.voice as { tts: unknown }).tts).toEqual({ mode: "cloud" });
  });

  test("embeddings: off by default, the cloud with its key name, or in-process; each read back by the catalogue", () => {
    const raw: Record<string, unknown> = {};
    apply(raw, { id: "embeddings", source: "cloud" });
    const asConfig = () => raw as unknown as MyClawConfig;
    expect(state(asConfig(), NATIVE, "embeddings")).toMatchObject({ source: "cloud", endpoint: CLOUD_EMBEDDING.baseUrl, missing: [CLOUD_EMBEDDING.apiKeyEnv] });
    apply(raw, { id: "embeddings", source: "self-hosted" });
    expect(state(asConfig(), NATIVE, "embeddings")).toMatchObject({ source: "self-hosted" });
    expect((raw.memory as { embedding: { model: string } }).embedding.model).toBe(LOCAL_EMBEDDING_MODEL);
    apply(raw, { id: "embeddings", source: "off" });
    expect(state(asConfig(), NATIVE, "embeddings").source).toBe("off");
  });

  test("embeddings on a provider the install already has: named, never copied", () => {
    const raw: Record<string, unknown> = {
      llm: { providers: { gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY" } } },
    };
    expect(apply(raw, { id: "embeddings", source: "cloud", provider: "gemini", model: "gemini-embedding-001" })).toEqual({ ok: true });
    // The provider is the one place holding the URL and the key: memory carries the name only.
    expect((raw.memory as { embedding: unknown }).embedding).toEqual({
      backend: "http",
      from: "gemini",
      model: "gemini-embedding-001",
    });
    // And the catalogue reads it back through that provider, not through memory's own fields.
    expect(state(raw as unknown as MyClawConfig, { ...NATIVE, GEMINI_API_KEY: "g" }, "embeddings")).toMatchObject({
      source: "cloud",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      missing: [],
      // The model and the provider ride the state, so a page that reopens draws what runs
      // instead of guessing it from a URL two providers can share.
      model: "gemini-embedding-001",
      provider: "gemini",
    });
    // A provider nothing declares is a typo, refused before it can break the first recall.
    expect(apply(raw, { id: "embeddings", source: "cloud", provider: "nope" })).toEqual({ ok: false, error: "unknown provider: nope" });
    // Only embeddings have a provider, and only from the cloud source.
    expect(apply(raw, { id: "search", source: "url", url: "http://x.test", provider: "gemini" })).toEqual({
      ok: false,
      error: "only embeddings can come from a provider",
    });
  });

  test("one consumer takes its own model, gives it back, or is switched off -- the default untouched", () => {
    const raw: Record<string, unknown> = {
      llm: {
        providers: {
          gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY" },
          synthetic: { baseUrl: "https://api.synthetic.new/openai/v1", apiKeyEnv: "SYNTHETIC_API_KEY" },
        },
      },
    };
    apply(raw, { id: "embeddings", source: "cloud", provider: "gemini", model: "gemini-embedding-001" });
    const memory = (): Record<string, unknown> => raw.memory as Record<string, unknown>;

    // Its own model: the consumer gets an entry of its own, and the default keeps its own shape.
    apply(raw, { id: "embeddings", source: "cloud", provider: "synthetic", model: "hf:nomic-ai/nomic-embed-text-v1.5", consumer: "recall" });
    expect((memory().embeddings as Record<string, unknown>).recall).toEqual({
      backend: "http",
      from: "synthetic",
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
    });
    expect(memory().embedding).toEqual({ backend: "http", from: "gemini", model: "gemini-embedding-001" });

    // Switched off: the model stays, so switching it back on is one tap and no reconfiguration.
    apply(raw, { id: "embeddings", source: "cloud", consumer: "recall", enabled: false });
    expect((memory().embeddings as Record<string, { enabled?: boolean }>).recall).toMatchObject({ enabled: false });
    apply(raw, { id: "embeddings", source: "cloud", consumer: "recall", enabled: true });
    expect((memory().embeddings as Record<string, { enabled?: boolean }>).recall?.enabled).toBeUndefined();

    // Back on the default: the entry goes, and the section with it when it is the last one.
    apply(raw, { id: "embeddings", source: "cloud", consumer: "recall", inherit: true });
    expect(memory().embeddings).toBeUndefined();
    expect(memory().embedding).toEqual({ backend: "http", from: "gemini", model: "gemini-embedding-001" });

    // A consumer id nothing declares is a typo, refused before it reaches the config.
    expect(apply(raw, { id: "embeddings", source: "cloud", consumer: "nope" as never })).toEqual({
      ok: false,
      error: "unknown embedding consumer: nope",
    });
    // And only embeddings have consumers at all.
    expect(apply(raw, { id: "stt", source: "cloud", consumer: "recall" })).toEqual({
      ok: false,
      error: "only embeddings have consumers",
    });
  });

  test("a consumer that only follows the default can still be switched off, and comes back with no choice", () => {
    // The switch is a state, not a destination: off pins no model, so switching it back on has
    // nothing to undo but the switch itself.
    const raw: Record<string, unknown> = {
      llm: { providers: { gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY" } } },
    };
    apply(raw, { id: "embeddings", source: "cloud", provider: "gemini", model: "gemini-embedding-001" });
    const memory = (): Record<string, unknown> => raw.memory as Record<string, unknown>;

    apply(raw, { id: "embeddings", source: "cloud", consumer: "dedup", enabled: false });
    expect((memory().embeddings as Record<string, unknown>).dedup).toEqual({ enabled: false });
    // It follows the default rather than naming a destination of its own.
    expect(embeddingFor(memory() as MemoryConfig, "dedup")).toEqual({ enabled: false });
    expect(embeddingActive(memory() as MemoryConfig, "dedup")).toBe(false);

    apply(raw, { id: "embeddings", source: "cloud", consumer: "dedup", enabled: true });
    // Nothing left to say: the entry goes, and the section with it.
    expect(memory().embeddings).toBeUndefined();
    expect(embeddingActive(memory() as MemoryConfig, "dedup")).toBe(true);

    // The `off` source means the same thing for a consumer, so it writes the same entry.
    apply(raw, { id: "embeddings", source: "off", consumer: "skills" });
    expect((memory().embeddings as Record<string, unknown>).skills).toEqual({ enabled: false });
  });

  test("search: off empties the URL; self-hosting it is a compose profile, refused on bare metal", () => {
    const raw: Record<string, unknown> = { webSearch: { baseUrl: "https://search.example", language: "fr" } };
    expect(apply(raw, { id: "search", source: "self-hosted" })).toEqual({ ok: false, error: "search cannot be self-hosted on this install" });
    expect(apply(raw, { id: "search", source: "self-hosted" }, "compose")).toEqual({ ok: true });
    expect(raw.webSearch).toEqual({ baseUrl: "http://searxng:8080", language: "fr" });
    apply(raw, { id: "search", source: "off" });
    expect(raw.webSearch).toEqual({ baseUrl: "", language: "fr" });
  });

  test("a URL source without a usable URL is refused, and nothing is written", () => {
    const raw: Record<string, unknown> = {};
    expect(apply(raw, { id: "stt", source: "url" })).toEqual({ ok: false, error: "an http(s) URL is needed" });
    expect(apply(raw, { id: "stt", source: "url", url: "file:///etc/passwd" })).toEqual({ ok: false, error: "an http(s) URL is needed" });
    expect(raw).toEqual({});
  });
});

test("setService writes the choice to config.json and answers with the file as written", async () => {
  const { CONFIG_PATH } = await import("../../src/core/config.ts");
  const { setService } = await import("../../src/core/config-edit.ts");
  const { mkdir, rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ webSearch: { baseUrl: "", language: "fr" } }));
  try {
    const outcome = await setService({ id: "search", source: "url", url: "https://search.lan" });
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(await readFile(CONFIG_PATH, "utf8")).webSearch).toEqual({ baseUrl: "https://search.lan", language: "fr" });
    expect(await setService({ id: "search", source: "url" })).toEqual({ ok: false, error: "an http(s) URL is needed" });
    expect(JSON.parse(await readFile(CONFIG_PATH, "utf8")).webSearch.baseUrl).toBe("https://search.lan");
  } finally {
    await rm(CONFIG_PATH, { force: true });
  }
});

test("an engine switched off can be freed at once, before the watcher applies the switch", async () => {
  const { CONFIG_PATH } = await import("../../src/core/config.ts");
  const { engineInUse, setService } = await import("../../src/core/config-edit.ts");
  const { mkdir, rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ memory: { embedding: { backend: "local", model: LOCAL_EMBEDDING_MODEL } } }));
  try {
    expect(await engineInUse("embeddings")).toBe(true);
    await setService({ id: "embeddings", source: "off" });
    expect(await engineInUse("embeddings")).toBe(false);
  } finally {
    await rm(CONFIG_PATH, { force: true });
  }
});
