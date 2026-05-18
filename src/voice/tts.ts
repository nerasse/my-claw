import { execFile, spawn } from "node:child_process";
import { mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname as pathDirname } from "node:path";
import { promisify } from "node:util";
import type { VoiceManager } from "./manager.ts";
import type { TTSResult } from "./types.ts";

const execFileAsync = promisify(execFile);

const binaryCache = new Map<string, string>();

/** Resolve absolute path to a binary via shell PATH, with known fallback paths. */
async function resolveBinary(name: string): Promise<string> {
  const cached = binaryCache.get(name);
  if (cached) return cached;
  try {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0 && stdout.trim()) return cacheAndReturn(name, stdout.trim());
  } catch {
    // which failed, fall through
  }

  const home = process.env.HOME ?? "/home";
  const candidates = [
    join(home, ".local", "bin", name),
    "/usr/local/bin/" + name,
    "/usr/bin/" + name,
  ];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return cacheAndReturn(name, candidate);
    } catch {
      continue;
    }
  }

  throw new Error(`${name} not found in PATH or fallback locations`);
}

function cacheAndReturn(name: string, path: string): string {
  binaryCache.set(name, path);
  return path;
}

export class TtsPipeline {
  constructor(private voiceManager: VoiceManager) {}

  async generate(
    text: string,
    overrides?: { forceCloud?: boolean; forceLocal?: boolean; voice?: string },
  ): Promise<TTSResult> {
    if (text.length > 5000) {
      throw new Error(`TTS text too long (${text.length} chars, max 5000). Shorten the text.`);
    }
    const mode = this.voiceManager.resolveMode("tts", overrides);
    try {
      return mode === "cloud"
        ? await this.generateEdgeTTS(text, overrides?.voice)
        : await this.generatePiper(text, overrides?.voice);
    } catch (err) {
      throw new Error(`TTS ${mode} failed: ${err}`);
    }
  }

  private async generateEdgeTTS(text: string, voice?: string): Promise<TTSResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), "tts-"));
    const outputPath = join(tmpDir, "output.mp3");

    const voiceId = voice ?? this.voiceManager.getVoiceConfig()?.tts?.voice ?? "fr-FR-RemyMultilingualNeural";

    try {
      const bin = await resolveBinary("edge-tts");
      await execFileAsync(bin, [
        "--text", text,
        "--voice", voiceId,
        "--write-media", outputPath,
      ]);

      return {
        path: outputPath,
        mimeType: "audio/mpeg",
      };
    } catch (err) {
      await this.cleanup(outputPath);
      throw err;
    }
  }

  private async generatePiper(text: string, model?: string): Promise<TTSResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), "tts-"));
    const outputPath = join(tmpDir, "output.wav");

    const modelPath = model ?? this.voiceManager.getVoiceConfig()?.tts?.voice ?? "fr_FR-siwis-medium";

    try {
      const bin = await resolveBinary("piper");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, [
          "--model", `${modelPath}.onnx`,
          "--output_file", outputPath,
        ]);

        child.stdin?.write(text);
        child.stdin?.end();

        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Piper exited with code ${code}`));
          }
        });
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

  private async cleanup(path: string): Promise<void> {
    await unlink(path).catch(() => {});
    await rmdir(pathDirname(path)).catch(() => {});
  }
}
