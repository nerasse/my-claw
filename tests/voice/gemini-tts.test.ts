import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { ChildProcess, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { GEMINI_DEFAULT_MODELS, GeminiTts, GeminiTtsError, chunkTurns, parseDialogue } from "../../src/voice/gemini-tts.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

interface Sent {
  url: string;
  key: string | null;
  body: {
    model: string;
    input: { content: { type?: string; text: string; annotations?: { type?: string; speaker?: string; style?: string }[] }[] }[];
    response_format: { mime_type: string; sample_rate: number };
    generation_config: { speech_config: unknown };
  };
}

function audioReply(pcm: string): Response {
  const data = Buffer.from(pcm).toString("base64");
  return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data }] }] });
}

/** Answers each request with its own text as the "audio", so the joined PCM shows the order. */
function echoServer(sent: Sent[], reply?: (sent: Sent, index: number) => Response | undefined) {
  return mockFetch(async (input, init) => {
    const entry: Sent = {
      url: String(input),
      key: new Headers(init?.headers).get("x-goog-api-key"),
      body: JSON.parse(String(init?.body)),
    };
    sent.push(entry);
    const custom = reply?.(entry, sent.length - 1);
    if (custom) return custom;
    return audioReply(`[${entry.body.input[0]!.content.map((c) => c.text).join("|")}]`);
  });
}

const encoded: Array<{ pcm: string; mp3: string }> = [];
async function fakeEncode(pcmPath: string, mp3Path: string): Promise<void> {
  encoded.push({ pcm: readFileSync(pcmPath, "utf8"), mp3: mp3Path });
  await Bun.write(mp3Path, "mp3");
}

const workDirs = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith("tts-"));

const restores: Array<{ restore(): void }> = [];
beforeEach(() => {
  process.env["GEMINI_API_KEY"] = "test-key";
  encoded.length = 0;
});
afterEach(() => {
  delete process.env["GEMINI_API_KEY"];
  while (restores.length) restores.pop()!.restore();
});

describe("parseDialogue", () => {
  test("turns lines into speaker turns, case-insensitive, continuation lines joined", () => {
    const turns = parseDialogue("Léa: Bonjour.\nmarc : Salut !\nça continue.\n\nLéa: Fin.", [
      { name: "Léa", voice: "a" },
      { name: "Marc", voice: "b" },
    ]);
    expect(turns).toEqual([
      { speaker: "Léa", text: "Bonjour." },
      { speaker: "Marc", text: "Salut ! ça continue." },
      { speaker: "Léa", text: "Fin." },
    ]);
  });

  test("refuses a dialogue that does not start with a known speaker", () => {
    expect(() => parseDialogue("Bonjour à tous.\nLéa: Salut.", [{ name: "Léa", voice: "a" }])).toThrow(GeminiTtsError);
  });
});

describe("chunkTurns", () => {
  test("packs whole turns up to the limit and keeps the order", () => {
    const chunks = chunkTurns([{ text: "aaaa" }, { text: "bbbb" }, { text: "cccc" }], 9);
    expect(chunks).toEqual([[{ text: "aaaa" }, { text: "bbbb" }], [{ text: "cccc" }]]);
  });

  test("cuts an oversized turn at sentence ends, keeping its speaker", () => {
    const chunks = chunkTurns([{ speaker: "A", text: "Une phrase. Deux phrases. Trois phrases." }], 15);
    expect(chunks.flat().map((t) => t.text)).toEqual(["Une phrase.", "Deux phrases.", "Trois phrases."]);
    expect(chunks.flat().every((t) => t.speaker === "A")).toBe(true);
  });

  test("a sentence longer than the limit is cut at a space, never lost", () => {
    const text = "mot ".repeat(20).trim();
    const pieces = chunkTurns([{ text }], 18).flat().map((t) => t.text);
    expect(pieces.every((p) => p.length <= 18)).toBe(true);
    expect(pieces.join(" ")).toBe(text);
  });

  test("a piece holds at most two speakers: A B A C A B is three pieces, in order", () => {
    const turns = ["A", "B", "A", "C", "A", "B"].map((speaker, i) => ({ speaker, text: `t${i}` }));
    const chunks = chunkTurns(turns, 4_000);
    expect(chunks.map((c) => c.map((t) => t.speaker).join(""))).toEqual(["ABA", "CA", "B"]);
    expect(chunks.flat().map((t) => t.text)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
  });

  test("two speakers are cut by size alone, as before", () => {
    const turns = ["A", "B", "A", "B"].map((speaker) => ({ speaker, text: "xxxx" }));
    expect(chunkTurns(turns, 9).map((c) => c.length)).toEqual([2, 2]);
  });
});

describe("GeminiTts", () => {
  test("narration: raw PCM per piece, joined in order, encoded once to MP3", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent));
    const tts = new GeminiTts({ encode: fakeEncode, chunkChars: 12 });

    const result = await tts.generate({ text: "Premier.\n\nDeuxième.\n\nTroisième.", voice: "fr-fr-podcaster-2", models: [{ model: "m" }] });

    expect(sent).toHaveLength(3);
    expect(sent[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(sent[0]!.key).toBe("test-key");
    expect(sent[0]!.body.model).toBe("m");
    expect(sent[0]!.body.response_format).toMatchObject({ mime_type: "audio/l16", sample_rate: 24000 });
    expect(sent[0]!.body.generation_config.speech_config).toEqual([{ voice: "fr-fr-podcaster-2" }]);
    const gap = "\0".repeat(16_800);
    expect(encoded).toEqual([{ pcm: `[Premier.]${gap}[Deuxième.]${gap}[Troisième.]`, mp3: result.path }]);
    expect(result.mimeType).toBe("audio/mpeg");
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(result.path.replace(/output\.mp3$/, "speech.pcm"))).toBe(false);
  });

  test("dialogue: conversational mode, one annotated item per turn, style on each", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent));
    const tts = new GeminiTts({ encode: fakeEncode });

    await tts.generate({
      text: "Léa: Bonjour.\nMarc: Salut.",
      voice: "unused",
      models: [{ model: "m" }],
      speakers: [{ name: "Léa", voice: "v1" }, { name: "Marc", voice: "v2" }],
      style: "radio",
    });

    expect(sent).toHaveLength(1);
    // No `mode`: the API answers `Unknown parameter 'mode' at 'generation_config.speech_config'`.
    // An object with `speakers` is what makes a request a dialogue.
    expect(sent[0]!.body.generation_config.speech_config).toEqual({
      speakers: [{ speaker: "Léa", voice: "v1" }, { speaker: "Marc", voice: "v2" }],
    });
    const items: unknown[] = sent[0]!.body.input[0]!.content.map((c) => [c.text, c.annotations?.[0]]);
    expect(items).toEqual([
      ["Bonjour.", { type: "speech_metadata", speaker: "Léa", style: "radio" }],
      ["Salut.", { type: "speech_metadata", speaker: "Marc", style: "radio" }],
    ]);
  });

  test("four voices: each request carries only the pair that speaks in it, a lone speaker reads plainly", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent));
    const tts = new GeminiTts({ encode: fakeEncode });

    await tts.generate({
      text: "Léa: un\nMarc: deux\nLéa: trois\nInès: quatre\nLéa: cinq\nMarc: six\nTom: sept",
      voice: "unused",
      models: [{ model: "m" }],
      speakers: [
        { name: "Léa", voice: "v1" },
        { name: "Marc", voice: "v2", style: "amusé" },
        { name: "Inès", voice: "v3" },
        { name: "Tom", voice: "v4" },
      ],
      style: "radio",
    });

    expect(sent.map((r) => r.body.generation_config.speech_config)).toEqual([
      { speakers: [{ speaker: "Léa", voice: "v1" }, { speaker: "Marc", voice: "v2" }] },
      { speakers: [{ speaker: "Inès", voice: "v3" }, { speaker: "Léa", voice: "v1" }] },
      { speakers: [{ speaker: "Marc", voice: "v2" }, { speaker: "Tom", voice: "v4" }] },
    ]);
    // The speaker's own style wins over the reading's.
    expect(sent[0]!.body.input[0]!.content.map((c) => c.annotations?.[0]?.style)).toEqual(["radio", "amusé", "radio"]);
  });

  test("a speaker alone in a piece is read in their voice and style, without dialogue mode", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent));
    const tts = new GeminiTts({ encode: fakeEncode });

    await tts.generate({
      text: "Léa: un\nMarc: deux\nInès: trois",
      voice: "unused",
      models: [{ model: "m" }],
      speakers: [{ name: "Léa", voice: "v1" }, { name: "Marc", voice: "v2" }, { name: "Inès", voice: "v3", style: "vif" }],
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.generation_config.speech_config).toEqual([{ voice: "v3" }]);
    expect(sent[1]!.body.input[0]!.content).toEqual([
      { type: "text", text: "trois", annotations: [{ type: "speech_metadata", style: "vif" }] },
    ]);
  });

  test("a text needing more than the daily ten requests is refused before any request", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent));
    const tts = new GeminiTts({ encode: fakeEncode, chunkChars: 5 });

    const failure = await tts.generate({ text: Array.from({ length: 11 }, (_, i) => `para${i % 10}`).join("\n\n"), voice: "v", models: [{ model: "m" }] })
      .catch((e: Error) => e);

    expect(failure).toBeInstanceOf(GeminiTtsError);
    expect((failure as Error).message).toContain("needs 11 requests");
    expect(sent).toHaveLength(0);
  });

  test("a daily quota hands the piece to the next model, and benches the spent one until Google's reset", async () => {
    let now = 1_000_000;
    const sent: Sent[] = [];
    const daily = "Rate limit exceeded (limit: 10 requests per day on Free Tier). Please retry in 2h";
    restores.push(echoServer(sent, (r) => (r.body.model === "a" ? Response.json({ error: { message: daily } }, { status: 429 }) : undefined)));
    const tts = new GeminiTts({ encode: fakeEncode, now: () => now });
    const models = [{ model: "a" }, { model: "b" }];

    const first = await tts.generate({ text: "x", voice: "v", models });
    expect(sent.map((r) => r.body.model)).toEqual(["a", "b"]);
    expect(first.notice).toBe("a out of quota or failing, read with b");

    // Still benched: no request is spent on it again.
    await tts.generate({ text: "y", voice: "v", models });
    expect(sent.map((r) => r.body.model)).toEqual(["a", "b", "b"]);

    now += 2 * 3_600_000 + 1;
    await tts.generate({ text: "z", voice: "v", models });
    expect(sent.map((r) => r.body.model)).toEqual(["a", "b", "b", "a", "b"]);
  });

  test("a free quota of zero (no retry time) benches the model for a day", async () => {
    let now = 0;
    const sent: Sent[] = [];
    const zero = "Rate limit exceeded for model gemini-2.5-pro-tts (limit: 0 requests per day on Free Tier).";
    restores.push(echoServer(sent, (r) => (r.body.model === "pro" ? Response.json({ error: { message: zero } }, { status: 429 }) : undefined)));
    const waits: number[] = [];
    const tts = new GeminiTts({ encode: fakeEncode, now: () => now, sleep: async (ms) => { waits.push(ms); } });
    const models = [{ model: "pro" }, { model: "b" }];

    await tts.generate({ text: "x", voice: "v", models });
    now += 23 * 3_600_000;
    await tts.generate({ text: "y", voice: "v", models });
    expect(sent.map((r) => r.body.model)).toEqual(["pro", "b", "b"]);
    expect(waits).toEqual([]);
  });

  test("any other failure moves the piece on too, without benching the model", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent, (r, i) => (r.body.model === "a" && i === 0 ? Response.json({ error: { message: "boom" } }, { status: 500 }) : undefined)));
    const tts = new GeminiTts({ encode: fakeEncode });
    await tts.generate({ text: "x", voice: "v", models: [{ model: "a" }, { model: "b" }] });
    await tts.generate({ text: "y", voice: "v", models: [{ model: "a" }, { model: "b" }] });
    expect(sent.map((r) => r.body.model)).toEqual(["a", "b", "a"]);
  });

  test("every model benched: refused before any request, naming the first reset", async () => {
    const sent: Sent[] = [];
    const daily = (h: number) => `limit: 10 requests per day. Please retry in ${h}h`;
    restores.push(echoServer(sent, (r) => Response.json({ error: { message: daily(r.body.model === "a" ? 3 : 1) } }, { status: 429 })));
    const tts = new GeminiTts({ encode: fakeEncode, now: () => Date.UTC(2026, 9, 8, 22, 0) });
    const models = [{ model: "a" }, { model: "b" }];

    const failure = await tts.generate({ text: "x", voice: "v", models }).catch((e: Error) => e);
    expect((failure as Error).message).toContain("a: HTTP 429");
    expect((failure as Error).message).toContain("b: HTTP 429");
    expect(sent).toHaveLength(2);

    const again = await tts.generate({ text: "x", voice: "v", models }).catch((e: Error) => e);
    expect((again as Error).message).toBe("every Gemini TTS model is out of its daily quota, the first is back at 01:00");
    expect(sent).toHaveLength(2);
  });

  test("the request budget counts every model left, ten each", async () => {
    const sent: Sent[] = [];
    restores.push(echoServer(sent));
    const tts = new GeminiTts({ encode: fakeEncode, chunkChars: 5 });
    const text = Array.from({ length: 15 }, (_, i) => `para${i % 10}`).join("\n\n");
    await tts.generate({ text, voice: "v", models: [{ model: "a" }, { model: "b" }] });
    expect(sent).toHaveLength(15);
  });

  test("an older model: its own voice, no response_format, no annotations, the dialogue written out", async () => {
    const sent: Sent[] = [];
    restores.push(mockFetch(async (input, init) => {
      sent.push({ url: String(input), key: null, body: JSON.parse(String(init?.body)) });
      const data = Buffer.from("pcm").toString("base64");
      return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", data, mime_type: "audio/L16;codec=pcm;rate=24000" }] }] });
    }));
    const tts = new GeminiTts({ encode: fakeEncode });
    const old = [{ model: "old", voice: "Charon" }];

    await tts.generate({ text: "Un récit.", voice: "fr-fr-podcaster-2", models: old, style: "radio" });
    await tts.generate({
      text: "Léa: un\nMarc: deux\nInès: trois",
      voice: "unused",
      models: old,
      speakers: [{ name: "Léa", voice: "fr-1" }, { name: "Marc", voice: "fr-2", style: "vif" }, { name: "Inès", voice: "fr-3" }],
    });

    expect(sent[0]!.body).toEqual({
      model: "old",
      input: [{ type: "user_input", content: [{ type: "text", text: "Un récit." }] }],
      generation_config: { speech_config: [{ voice: "Charon" }] },
    } as unknown as Sent["body"]);
    expect(sent[1]!.body.input[0]!.content).toEqual([{ type: "text", text: "Léa: un\nMarc: deux" }]);
    expect(sent[1]!.body.generation_config.speech_config).toEqual({
      speakers: [{ speaker: "Léa", voice: "Charon" }, { speaker: "Marc", voice: "Kore" }],
    });
    expect(sent[2]!.body.generation_config.speech_config).toEqual([{ voice: "Puck" }]);
  });

  test("audio that is not 24 kHz PCM is refused, never joined as noise", async () => {
    restores.push(mockFetch(async () => Response.json({
      steps: [{ type: "model_output", content: [{ type: "audio", data: "UklGRg==", mime_type: "audio/wav" }] }],
    })));
    const failure = await new GeminiTts({ encode: fakeEncode }).generate({ text: "x", voice: "v", models: [{ model: "m" }] })
      .catch((e: Error) => e);
    expect((failure as Error).message).toBe("m: unexpected audio format audio/wav");
  });

  test("a 429 waits the delay the API gives, then retries the same piece", async () => {
    const sent: Sent[] = [];
    const waits: number[] = [];
    restores.push(echoServer(sent, (_s, i) => (i === 0
      ? new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429, headers: { "retry-after": "7" } })
      : undefined)));
    const tts = new GeminiTts({ encode: fakeEncode, sleep: async (ms) => { waits.push(ms); } });

    await tts.generate({ text: "Bonjour.", voice: "v", models: [{ model: "m" }] });

    expect(waits).toEqual([7000]);
    expect(sent).toHaveLength(2);
    expect(encoded[0]!.pcm).toBe("[Bonjour.]");
  });

  test("a per-minute limit in the body is waited out, a daily quota fails at once with Google's message", async () => {
    const waits: number[] = [];
    const quota = (detail: string) => new Response(JSON.stringify({ error: { message: detail } }), { status: 429 });
    const sent: Sent[] = [];
    restores.push(echoServer(sent, (_s, i) => (i === 0 ? quota("Rate limit. Please retry in 12.5s.") : undefined)));
    const tts = new GeminiTts({ encode: fakeEncode, sleep: async (ms) => { waits.push(ms); } });
    await tts.generate({ text: "x", voice: "v", models: [{ model: "m" }] });
    expect(waits).toEqual([12_500]);
    restores.pop()!.restore();

    const daily = "Rate limit exceeded (limit: 10 requests per day on Free Tier). Please retry in 4h6m13s";
    restores.push(mockFetch(async () => quota(daily)));
    const failure = await tts.generate({ text: "x", voice: "v", models: [{ model: "m" }] }).catch((e: Error) => e);
    expect((failure as Error).message).toBe(`m: HTTP 429: ${daily}`);
    expect(waits).toEqual([12_500]);
  });

  test("an API error names the status and the API message, never the text, and leaves no file", async () => {
    restores.push(mockFetch(async () => Response.json({ error: { message: "No matching speaker voice" } }, { status: 400 })));
    const tts = new GeminiTts({ encode: fakeEncode });
    const before = workDirs();

    const failure = await tts.generate({ text: "texte privé", voice: "nope", models: [{ model: "m" }] }).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(GeminiTtsError);
    expect((failure as Error).message).toBe("m: HTTP 400: No matching speaker voice");
    expect(encoded).toEqual([]);
    expect(workDirs()).toEqual(before);
  });

  test("no key is a clear setup error, before any request", async () => {
    delete process.env["GEMINI_API_KEY"];
    const sent: Sent[] = [];
    restores.push(echoServer(sent));

    await expect(new GeminiTts({ encode: fakeEncode }).generate({ text: "x", voice: "v", models: [{ model: "m" }] }))
      .rejects.toThrow("GEMINI_API_KEY not set");
    expect(sent).toEqual([]);
  });

  test("a stop during a request is an abort and removes the work directory", async () => {
    const controller = new AbortController();
    const before = workDirs();
    restores.push(mockFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      controller.abort();
    })));

    await expect(new GeminiTts({ encode: fakeEncode }).generate({ text: "x", voice: "v", models: [{ model: "m" }] }, controller.signal))
      .rejects.toBeInstanceOf(AbortedError);
    expect(encoded).toEqual([]);
    expect(workDirs()).toEqual(before);
  });
});

function pipelineManager(tts: Record<string, unknown>): VoiceManager {
  return new VoiceManager({
    whitelist: [], blacklist: [], channels: {}, agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test" },
    voice: { tts },
  } as MyClawConfig);
}

/** Edge, without the binary: records what it was asked to read, writes a file or fails. */
function fakeEdge(fail = false) {
  const reads: { text: string; voice: string }[] = [];
  const execute = ((_file: string, args: readonly string[], _options: unknown, done: (err: Error | null, out: string) => void) => {
    reads.push({ text: args[args.indexOf("--text") + 1]!, voice: args[args.indexOf("--voice") + 1]! });
    if (!fail) writeFileSync(args[args.indexOf("--write-media") + 1]!, "edge audio");
    queueMicrotask(() => done(fail ? new Error("edge down") : null, ""));
    return { kill: () => true } as unknown as ChildProcess;
  }) as unknown as typeof execFile;
  return { execute, reads };
}

function pipeline(tts: Record<string, unknown>, gemini?: GeminiTts, edge = fakeEdge()) {
  return new TtsPipeline(pipelineManager(tts), { resolveBinary: async () => "edge-tts", execFile: edge.execute, gemini });
}

describe("TtsPipeline with voice.tts.provider", () => {
  test("gemini in cloud mode takes the configured voice and model and a text past Edge's ceiling", async () => {
    const calls: unknown[] = [];
    const gemini = { generate: async (speech: unknown) => { calls.push(speech); return { path: "/x.mp3", mimeType: "audio/mpeg" }; } } as unknown as GeminiTts;
    const text = "a".repeat(12_000);

    const models = [{ model: "gm" }, { model: "old", voice: "Charon" }];
    const result = await pipeline({ mode: "cloud", provider: "gemini", voice: "fr-fr-podcaster-9", models }, gemini)
      .generate(text, { style: "calme" });

    expect(result.path).toBe("/x.mp3");
    expect(calls).toEqual([{ text, voice: "fr-fr-podcaster-9", models, speakers: undefined, style: "calme" }]);
  });

  test("without models in the config, the measured default chain is used", async () => {
    const calls: { models: unknown }[] = [];
    const gemini = { generate: async (speech: { models: unknown }) => { calls.push(speech); return { path: "/x.mp3", mimeType: "audio/mpeg" }; } } as unknown as GeminiTts;
    await pipeline({ mode: "cloud", provider: "gemini" }, gemini).generate("x");
    expect(calls[0]!.models).toBe(GEMINI_DEFAULT_MODELS);
  });

  test("gemini still has a ceiling", async () => {
    await expect(pipeline({ mode: "cloud", provider: "gemini" }).generate("a".repeat(40_001)))
      .rejects.toThrow("max 40000");
  });

  test("Edge keeps its 5000 ceiling and refuses a dialogue rather than reading the names aloud", async () => {
    await expect(pipeline({ mode: "cloud" }).generate("a".repeat(5_001))).rejects.toThrow("max 5000");
    await expect(pipeline({ mode: "cloud" }).generate("Léa: salut", { speakers: [{ name: "Léa", voice: "v" }] }))
      .rejects.toThrow("need the Gemini engine");
  });

  test("when Gemini fails, Edge reads it in its own voice, names dropped, and the result says so", async () => {
    const gemini = { generate: async () => { throw new GeminiTtsError("every model is out of quota"); } } as unknown as GeminiTts;
    const edge = fakeEdge();

    const result = await pipeline({ mode: "cloud", provider: "gemini", voice: "fr-fr-podcaster-2" }, gemini, edge)
      .generate("Léa: Bonjour.\nmarc : Salut.\nça continue.", { speakers: [{ name: "Léa", voice: "a" }, { name: "Marc", voice: "b" }] });

    expect(edge.reads).toEqual([{ text: "Bonjour.\nSalut.\nça continue.", voice: "fr-FR-RemyMultilingualNeural" }]);
    expect(existsSync(result.path)).toBe(true);
    expect(result.notice).toBe("Gemini failed (every model is out of quota): read with Edge instead");
  });

  test("Edge stands in for a key that is missing too, and for a failed MP3 encoding", async () => {
    const encodeFails = { generate: async () => { throw new Error("ffmpeg exited 1"); } } as unknown as GeminiTts;
    const result = await pipeline({ mode: "cloud", provider: "gemini" }, encodeFails).generate("x");
    expect(result.notice).toContain("the audio could not be encoded to MP3");

    delete process.env["GEMINI_API_KEY"];
    const noKey = await pipeline({ mode: "cloud", provider: "gemini" }).generate("x");
    expect(noKey.notice).toContain("GEMINI_API_KEY not set");
  });

  test("Gemini then Edge failing is one error naming both, never the text", async () => {
    const gemini = { generate: async () => { throw new GeminiTtsError("HTTP 400: bad voice"); } } as unknown as GeminiTts;
    const failure = await pipeline({ mode: "cloud", provider: "gemini" }, gemini, fakeEdge(true)).generate("texte privé")
      .catch((e: Error) => e);
    expect((failure as Error).message).toBe(
      "TTS cloud failed: Gemini (HTTP 400: bad voice), then the Edge fallback (TTS cloud failed: edge-tts did not produce audio.)",
    );
  });

  test("a stop is a stop: Edge is not tried", async () => {
    const controller = new AbortController();
    const gemini = { generate: async () => { controller.abort(); throw new AbortedError(); } } as unknown as GeminiTts;
    const edge = fakeEdge();
    await expect(pipeline({ mode: "cloud", provider: "gemini" }, gemini, edge).generate("x", undefined, controller.signal))
      .rejects.toBeInstanceOf(AbortedError);
    expect(edge.reads).toEqual([]);
  });

  test("auto mode reads the Gemini key as the cloud credential", () => {
    const manager = (tts: Record<string, unknown>) => pipelineManager(tts);
    expect(manager({ provider: "gemini" }).resolveMode("tts")).toBe("cloud");
    delete process.env["GEMINI_API_KEY"];
    expect(manager({ provider: "gemini" }).resolveMode("tts")).toBe("local");
    expect(manager({}).resolveMode("tts")).toBe("cloud");
  });
});
