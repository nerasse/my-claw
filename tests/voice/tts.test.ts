import { describe, expect, test } from "bun:test";
import type { ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TtsPipeline, EDGE_TTS_STALL_MS, type TtsPipelineOptions } from "../../src/voice/tts.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

type Callback = (error: Error | null, stdout: string) => void;
interface ProcessCall {
  file: string;
  args: readonly string[];
  options: { timeout: number; killSignal: string };
  complete: Callback;
}

function fakeExec(onCall?: (call: ProcessCall) => void) {
  const calls: ProcessCall[] = [];
  const kills: string[] = [];
  let started!: (call: ProcessCall) => void;
  const firstCall = new Promise<ProcessCall>((resolve) => { started = resolve; });
  const execute = ((file: string, args: readonly string[], options: ProcessCall["options"], complete: Callback) => {
    const call = { file, args, options, complete };
    calls.push(call);
    const outputIndex = args.indexOf("--write-media");
    if (outputIndex >= 0) writeFileSync(args[outputIndex + 1]!, "partial audio");
    started(call);
    onCall?.(call);
    return {
      kill(signal: string) {
        kills.push(signal);
        complete(new Error(`Command failed: ${file} ${args.join(" ")}`), "");
        return true;
      },
    } as ChildProcess;
  }) as unknown as typeof execFile;
  return { execute, calls, kills, firstCall };
}

function pipeline(options: TtsPipelineOptions = {}, voice: Record<string, unknown> = { mode: "cloud" }) {
  const config = {
    whitelist: [], blacklist: [], channels: {}, agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test" }, voice,
  } as MyClawConfig;
  return new TtsPipeline(new VoiceManager(config), { resolveBinary: async () => "edge-tts", ...options });
}

function outputPath(call: ProcessCall): string {
  return call.args[call.args.indexOf("--write-media") + 1]!;
}

function expectCleaned(call: ProcessCall): void {
  expect(existsSync(outputPath(call))).toBe(false);
  expect(existsSync(dirname(outputPath(call)))).toBe(false);
}

describe("Edge TTS deadlines and cancellation", () => {
  test("success keeps the audio, and the process has no total deadline, only a stall watch", async () => {
    const fake = fakeExec((call) => queueMicrotask(() => call.complete(null, "")));
    const result = await pipeline({ execFile: fake.execute }).generate("hello");
    expect(EDGE_TTS_STALL_MS).toBe(20_000);
    expect(fake.calls[0]!.options).toMatchObject({ timeout: 0, killSignal: "SIGKILL" });
    expect(result).toEqual({ path: outputPath(fake.calls[0]!), mimeType: "audio/mpeg" });
    expect(existsSync(result.path)).toBe(true);
    expect(fake.kills).toEqual([]);
  });

  test("a stalled process is killed, partial audio is removed, text is not leaked", async () => {
    const fake = fakeExec();
    await expect(pipeline({ execFile: fake.execute, edgeStallMs: 20 }).generate("private spoken text"))
      .rejects.toMatchObject({ message: "TTS cloud stalled: no audio for 0.02s." });
    expect(fake.kills).toEqual(["SIGKILL"]);
    expect(fake.calls).toHaveLength(1);
    expectCleaned(fake.calls[0]!);
  });

  test("the process is signalled once, however many watch ticks were in flight", async () => {
    // The stall watch polls, and a tick already running when the stall is seen lands after the
    // kill: the same child was signalled twice. The exit is delayed here so those ticks really do
    // land; on a loaded runner that overlap is what made the test above flake (CI run 2526).
    const kills: string[] = [];
    let started = 0;
    const execute = ((file: string, args: readonly string[], _options: ProcessCall["options"], complete: Callback) => {
      started += 1;
      const outputIndex = args.indexOf("--write-media");
      if (outputIndex >= 0) writeFileSync(args[outputIndex + 1]!, "partial audio");
      return {
        kill(signal: string) {
          kills.push(signal);
          setTimeout(() => complete(new Error(`Command failed: ${file}`), ""), 60);
          return true;
        },
      } as ChildProcess;
    }) as unknown as typeof execFile;
    await expect(pipeline({ execFile: execute, edgeStallMs: 20 }).generate("private spoken text")).rejects.toMatchObject({
      message: "TTS cloud stalled: no audio for 0.02s.",
    });
    expect(kills).toEqual(["SIGKILL"]);
    expect(started).toBe(1);
  });

  test("a long reading whose audio keeps growing outlives the stall window", async () => {
    // 83.6 s for 4 950 characters on 2026-10-04: a total deadline would have to be guessed.
    const fake = fakeExec((call) => {
      const path = outputPath(call);
      let ticks = 0;
      const timer = setInterval(() => {
        appendFileSync(path, "more audio");
        if (++ticks === 20) {
          clearInterval(timer);
          call.complete(null, "");
        }
      }, 10);
    });
    const result = await pipeline({ execFile: fake.execute, edgeStallMs: 60 }).generate("a long reading");
    expect(fake.kills).toEqual([]);
    expect(existsSync(result.path)).toBe(true);
  });

  test("run stop kills the active process and remains an abort, not an audio error", async () => {
    const fake = fakeExec();
    const controller = new AbortController();
    const result = pipeline({ execFile: fake.execute }).generate("hello", undefined, controller.signal);
    const call = await fake.firstCall;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AbortedError);
    expect(fake.kills).toEqual(["SIGKILL"]);
    expectCleaned(call);
  });

  test("a stopped run never starts a process", async () => {
    const fake = fakeExec();
    const controller = new AbortController();
    controller.abort();
    await expect(pipeline({ execFile: fake.execute }).generate("hello", undefined, controller.signal))
      .rejects.toBeInstanceOf(AbortedError);
    expect(fake.calls).toHaveLength(0);
  });

  test("stop during binary lookup does not start synthesis", async () => {
    const fake = fakeExec();
    const controller = new AbortController();
    const tts = pipeline({ execFile: fake.execute, resolveBinary: async () => {
      controller.abort();
      return "edge-tts";
    } });
    await expect(tts.generate("hello", undefined, controller.signal)).rejects.toBeInstanceOf(AbortedError);
    expect(fake.calls).toHaveLength(0);
  });

  test("process failures remove partial files without exposing command arguments", async () => {
    const fake = fakeExec((call) => queueMicrotask(() => call.complete(new Error("--text private spoken text"), "")));
    await expect(pipeline({ execFile: fake.execute }).generate("private spoken text"))
      .rejects.toMatchObject({ message: "TTS cloud failed: edge-tts did not produce audio." });
    expectCleaned(fake.calls[0]!);
    expect(fake.calls).toHaveLength(1);
  });

  test("stalled discovery probes are individually bounded", async () => {
    const fake = fakeExec();
    const tts = pipeline({ execFile: fake.execute, resolveBinary: undefined, probeTimeoutMs: 5 });
    await expect(tts.generate("hello")).rejects.toThrow("TTS cloud failed");
    expect(fake.calls).toHaveLength(4);
    expect(fake.kills).toEqual(["SIGKILL", "SIGKILL", "SIGKILL", "SIGKILL"]);
    expect(fake.calls.every((call) => call.options.timeout === 5)).toBe(true);
  });

  test("stopping a discovery probe prevents fallback probes", async () => {
    const fake = fakeExec();
    const controller = new AbortController();
    const result = pipeline({ execFile: fake.execute, resolveBinary: undefined })
      .generate("hello", undefined, controller.signal);
    await fake.firstCall;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AbortedError);
    expect(fake.calls).toHaveLength(1);
    expect(fake.kills).toEqual(["SIGKILL"]);
  });
});

function fakeSpawn(onWrite?: (child: EventEmitter, stdin: EventEmitter) => void) {
  const kills: string[] = [];
  let output = "";
  let started!: () => void;
  const firstCall = new Promise<void>((resolve) => { started = resolve; });
  const execute = ((_file: string, args: readonly string[]) => {
    output = args[args.indexOf("--output_file") + 1]!;
    writeFileSync(output, "partial audio");
    const child = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), {
      write() { onWrite?.(child, stdin); },
      end() {},
    });
    started();
    return Object.assign(child, {
      stdin,
      kill(signal: string) {
        kills.push(signal);
        child.emit("close", null);
        return true;
      },
    }) as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { execute, kills, firstCall, output: () => output };
}

describe("Piper CLI deadlines and cancellation", () => {
  const local = { mode: "local" };

  test("success keeps its audio and removes the abort listener", async () => {
    const fake = fakeSpawn((child) => queueMicrotask(() => child.emit("close", 0)));
    const controller = new AbortController();
    const result = await pipeline({ spawn: fake.execute }, local).generate("hello", undefined, controller.signal);
    expect(result).toEqual({ path: fake.output(), mimeType: "audio/wav" });
    expect(existsSync(result.path)).toBe(true);
    controller.abort();
    expect(fake.kills).toEqual([]);
  });

  test("a stalled process is killed and cleaned on its deadline", async () => {
    const fake = fakeSpawn();
    await expect(pipeline({ spawn: fake.execute, piperTimeoutMs: 10 }, local).generate("hello"))
      .rejects.toMatchObject({ message: "TTS local timed out after 0.01s." });
    expect(fake.kills).toEqual(["SIGKILL"]);
    expect(existsSync(dirname(fake.output()))).toBe(false);
  });

  test("a stop kills the child and removes the partial file", async () => {
    const fake = fakeSpawn();
    const controller = new AbortController();
    const result = pipeline({ spawn: fake.execute }, local).generate("hello", undefined, controller.signal);
    await fake.firstCall;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AbortedError);
    expect(fake.kills).toEqual(["SIGKILL"]);
    expect(existsSync(dirname(fake.output()))).toBe(false);
  });

  test("stdin EPIPE is handled without leaking text or leaving the child alive", async () => {
    const fake = fakeSpawn((_child, stdin) => queueMicrotask(() => stdin.emit("error", new Error("EPIPE private spoken text"))));
    await expect(pipeline({ spawn: fake.execute }, local).generate("private spoken text"))
      .rejects.toMatchObject({ message: "TTS local failed: Piper did not produce audio." });
    expect(fake.kills).toEqual(["SIGKILL"]);
    expect(existsSync(dirname(fake.output()))).toBe(false);
  });

  test("a missing model is a failure, not a successful audio attachment", async () => {
    const fake = fakeSpawn((child) => queueMicrotask(() => child.emit("close", 1)));
    await expect(pipeline({ spawn: fake.execute }, local).generate("hello"))
      .rejects.toMatchObject({ message: "TTS local failed: Piper did not produce audio." });
    expect(existsSync(dirname(fake.output()))).toBe(false);
  });
});

test("Piper HTTP deadline is not mistaken for a user stop", async () => {
  const fetchMock = mockFetch(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }));
  try {
    await expect(pipeline({ piperTimeoutMs: 10 }, { mode: "local", tts: { url: "http://piper.test" } }).generate("hello"))
      .rejects.toMatchObject({ message: "TTS local timed out after 0.01s." });
  } finally {
    fetchMock.restore();
  }
});

test("Piper HTTP errors do not expose endpoint credentials or response text", async () => {
  const fetchMock = mockFetch(async () => new Response("private spoken text", { status: 500 }));
  try {
    await expect(pipeline({}, { mode: "local", tts: { url: "http://piper.test?secret=credential" } }).generate("private spoken text"))
      .rejects.toMatchObject({ message: "TTS local failed: Piper did not produce audio." });
  } finally {
    fetchMock.restore();
  }
});

test("Piper HTTP observes run cancellation", async () => {
  const controller = new AbortController();
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const fetchMock = mockFetch(async (_url, init) => {
    requestStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  try {
    const result = pipeline({}, { mode: "local", tts: { url: "http://piper.test" } })
      .generate("hello", undefined, controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AbortedError);
  } finally {
    fetchMock.restore();
  }
});
