import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VoiceManager } from "./manager.ts";
import type { TTSResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export class TtsPipeline {
  constructor(private voiceManager: VoiceManager) {}

  async generate(
    text: string,
    overrides?: { forceCloud?: boolean; forceLocal?: boolean; voice?: string },
  ): Promise<TTSResult> {
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
      await execFileAsync("edge-tts", [
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
      await new Promise<void>((resolve, reject) => {
        const child = spawn("piper", [
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
  }
}
