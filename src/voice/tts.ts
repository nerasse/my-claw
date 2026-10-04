import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname as pathDirname } from "node:path";
import type { VoiceManager } from "./manager.ts";
import type { TTSResult } from "./types.ts";
import { piperEndpoint } from "../services/catalog.ts";
import { AbortedError, isAbort, rethrowIfAborted } from "../core/aborted.ts";

export const EDGE_TTS_TIMEOUT_MS = 90_000;
const BINARY_PROBE_TIMEOUT_MS = 5_000;
const PIPER_TIMEOUT_MS = 30_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

type ExecFile = typeof execFile;

export interface TtsPipelineOptions {
  resolveBinary?: (name: string, signal?: AbortSignal) => Promise<string>;
  execFile?: ExecFile;
  spawn?: typeof spawn;
  edgeTimeoutMs?: number;
  piperTimeoutMs?: number;
  probeTimeoutMs?: number;
}

class BinaryNotFoundError extends Error {}

class ProcessDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super("process deadline exceeded");
    this.name = "ProcessDeadlineError";
  }
}

function timeoutLabel(timeoutMs: number): string {
  return `${Number((timeoutMs / 1000).toFixed(2))}s`;
}

function runExecFile(
  execute: ExecFile,
  file: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  rethrowIfAborted(undefined, signal);
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child?.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    const onAbort = (): void => {
      try { child?.kill("SIGKILL"); } catch {}
    };
    const finish = (error: unknown, stdout: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new AbortedError());
      } else if (timedOut) {
        reject(new ProcessDeadlineError(timeoutMs));
      } else if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = execute(
        file,
        args,
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_PROBE_OUTPUT_BYTES },
        (error, stdout) => finish(error, typeof stdout === "string" ? stdout : ""),
      );
      if (signal?.aborted) onAbort();
    } catch (error) {
      finish(error, "");
    }
  });
}

const binaryCache = new Map<string, string>();

/** Resolve absolute path to a binary via shell PATH, with known fallback paths. */
async function resolveBinary(
  name: string,
  execute: ExecFile = execFile,
  probeTimeoutMs = BINARY_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  const cached = binaryCache.get(name);
  if (cached) return cached;

  try {
    const stdout = await runExecFile(execute, "which", [name], probeTimeoutMs, signal);
    if (stdout.trim()) return cacheAndReturn(name, stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  const home = process.env.HOME ?? "/home";
  const candidates = [
    join(home, ".local", "bin", name),
    "/usr/local/bin/" + name,
    "/usr/bin/" + name,
  ];

  for (const candidate of candidates) {
    try {
      await runExecFile(execute, candidate, ["--version"], probeTimeoutMs, signal);
      return cacheAndReturn(name, candidate);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  throw new BinaryNotFoundError(`${name} not found in PATH or fallback locations`);
}

function cacheAndReturn(name: string, path: string): string {
  binaryCache.set(name, path);
  return path;
}

/** Drops the resolved-binary cache. Only needed by tests: a path cached from a previous test
 *  would otherwise defeat any attempt to simulate a missing binary. */
export function resetBinaryCache(): void {
  binaryCache.clear();
}

export class TtsPipeline {
  private readonly execFileImpl: ExecFile;
  private readonly resolveBinaryImpl: (name: string, signal?: AbortSignal) => Promise<string>;
  private readonly edgeTimeoutMs: number;
  private readonly piperTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;

  constructor(private voiceManager: VoiceManager, options: TtsPipelineOptions = {}) {
    this.execFileImpl = options.execFile ?? execFile;
    this.resolveBinaryImpl = options.resolveBinary ?? ((name, signal) => resolveBinary(
      name,
      this.execFileImpl,
      options.probeTimeoutMs ?? BINARY_PROBE_TIMEOUT_MS,
      signal,
    ));
    this.edgeTimeoutMs = options.edgeTimeoutMs ?? EDGE_TTS_TIMEOUT_MS;
    this.piperTimeoutMs = options.piperTimeoutMs ?? PIPER_TIMEOUT_MS;
    this.spawnImpl = options.spawn ?? spawn;
  }

  async generate(
    text: string,
    overrides?: { forceCloud?: boolean; forceLocal?: boolean; voice?: string },
    signal?: AbortSignal,
  ): Promise<TTSResult> {
    rethrowIfAborted(undefined, signal);
    if (text.length > 5000) {
      throw new Error(`TTS text too long (${text.length} chars, max 5000). Shorten the text.`);
    }
    const mode = this.voiceManager.resolveMode("tts", overrides);
    try {
      if (mode === "cloud") return await this.generateEdgeTTS(text, overrides?.voice, signal);
      const endpoint = piperEndpoint(this.voiceManager.getVoiceConfig());
      return endpoint
        ? await this.generatePiperHttp(endpoint, text, overrides?.voice, signal)
        : await this.generatePiper(text, overrides?.voice, signal);
    } catch (err) {
      if (isAbort(err, signal)) throw new AbortedError();
      if (err instanceof ProcessDeadlineError) {
        throw new Error(`TTS ${mode} timed out after ${timeoutLabel(err.timeoutMs)}.`);
      }
      if (err instanceof BinaryNotFoundError) {
        throw new Error(`TTS ${mode} failed: ${err.message}`);
      }
      if (mode === "cloud") throw new Error("TTS cloud failed: edge-tts did not produce audio.");
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`TTS local timed out after ${timeoutLabel(this.piperTimeoutMs)}.`);
      }
      throw new Error("TTS local failed: Piper did not produce audio.");
    }
  }

  private async generateEdgeTTS(text: string, voice: string | undefined, signal?: AbortSignal): Promise<TTSResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), "tts-"));
    const outputPath = join(tmpDir, "output.mp3");
    const voiceId = voice ?? this.voiceManager.getVoiceConfig()?.tts?.voice ?? "fr-FR-RemyMultilingualNeural";

    try {
      const bin = await this.resolveBinaryImpl("edge-tts", signal);
      await runExecFile(this.execFileImpl, bin, [
        "--text", text,
        "--voice", voiceId,
        "--write-media", outputPath,
      ], this.edgeTimeoutMs, signal);

      return {
        path: outputPath,
        mimeType: "audio/mpeg",
      };
    } catch (err) {
      await this.cleanup(outputPath);
      throw err;
    }
  }

  private async generatePiper(text: string, model: string | undefined, signal?: AbortSignal): Promise<TTSResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), "tts-"));
    const outputPath = join(tmpDir, "output.wav");
    const modelPath = model ?? this.voiceManager.getVoiceConfig()?.tts?.voice ?? "fr_FR-siwis-medium";

    try {
      const bin = await this.resolveBinaryImpl("piper", signal);
      await new Promise<void>((resolve, reject) => {
        const child = this.spawnImpl(bin, [
          "--model", `${modelPath}.onnx`,
          "--output_file", outputPath,
        ]);
        let finished = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGKILL"); } catch {}
        }, this.piperTimeoutMs);
        const onAbort = (): void => {
          try { child.kill("SIGKILL"); } catch {}
        };
        const finish = (error?: unknown): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new AbortedError());
          } else if (timedOut) {
            reject(new ProcessDeadlineError(this.piperTimeoutMs));
          } else if (error) {
            try { child.kill("SIGKILL"); } catch {}
            reject(error);
          } else {
            resolve();
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdin?.on("error", (err) => finish(err));
        child.on("error", (err) => finish(err));
        child.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error("piper exited unsuccessfully"));
        });
        try {
          child.stdin?.write(text);
          child.stdin?.end();
        } catch (error) {
          finish(error);
        }
        if (signal?.aborted) onAbort();
      });

      return {
        path: outputPath,
        mimeType: "audio/wav",
      };
    } catch (err) {
      await this.cleanup(outputPath);
      throw err;
    }
  }

  /** Piper's HTTP server (`python -m piper.http_server`, piper-tts 1.8): the compose service, or the owner's URL. */
  private async generatePiperHttp(endpoint: string, text: string, voice: string | undefined, signal?: AbortSignal): Promise<TTSResult> {
    const requestSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(this.piperTimeoutMs), signal])
      : AbortSignal.timeout(this.piperTimeoutMs);
    const response = await fetch(`${endpoint}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
      signal: requestSignal,
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") throw err;
      throw new Error("Piper is not answering");
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Piper error ${response.status}`);
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "tts-"));
    const outputPath = join(tmpDir, "output.wav");
    try {
      await writeFile(outputPath, new Uint8Array(await response.arrayBuffer()));
      return { path: outputPath, mimeType: "audio/wav" };
    } catch (err) {
      await this.cleanup(outputPath);
      throw err;
    }
  }

  private async cleanup(path: string): Promise<void> {
    await unlink(path).catch(() => {});
    await rmdir(pathDirname(path)).catch(() => {});
  }
}
