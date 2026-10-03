import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";

/**
 * The local engines a bare-metal install downloads only once they are switched on, and can free
 * again (docs/services.md, "Local engines"). Nothing here runs at install: the default is the cloud.
 */

export const RUNTIME_DIR = join(MY_CLAW_DIR, "runtime");
/** faster-whisper and its native wheels, for my-claw-whisper.service (the unit prefers it to the system Python). */
export const WHISPER_VENV = join(RUNTIME_DIR, "whisper");
/** The set the compose image and the owner's box run: PyAV 19 broke every transcription. */
export const WHISPER_PACKAGES = ["faster-whisper==1.2.1", "av==17.0.0", "ctranslate2==4.7.1"];
/** transformers.js' cache, outside the release: inside node_modules, every update re-downloaded the model. */
export const TRANSFORMERS_CACHE = join(MY_CLAW_DIR, "models", "transformers");

export type Run = (cmd: string[]) => Promise<{ code: number; output: string }>;

export const runCommand: Run = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output: `${out}${err}`.trim() };
};

export type PrepareState = { state: "idle" } | { state: "installing" } | { state: "ready" } | { state: "failed"; error: string };

/** The model whisper-server.py loads: the files freeing removes. */
function whisperModelDir(): string {
  const model = process.env["FASTER_WHISPER_MODEL"] ?? "small";
  const hub = process.env["HF_HOME"] ? join(process.env["HF_HOME"], "hub") : join(homedir(), ".cache", "huggingface", "hub");
  return join(hub, `models--Systran--faster-whisper-${model}`);
}

/**
 * faster-whisper for the bare-metal unit: already importable by the system Python (an install that
 * set it up by hand keeps working untouched), or installed into its own venv, once, when local
 * speech-to-text is asked for. The unit is not started before that: started without its package it
 * restarts forever.
 */
export class WhisperRuntime {
  private current: PrepareState = { state: "idle" };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly run: Run = runCommand, private readonly venv = WHISPER_VENV) {}

  status(): PrepareState {
    return this.current;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: PrepareState): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  private async importable(python: string): Promise<boolean> {
    return (await this.run([python, "-c", "import faster_whisper"])).code === 0;
  }

  /** True when the unit can start now. Otherwise starts the install, once, and answers false. */
  async prepare(): Promise<boolean> {
    if (this.current.state === "ready") return true;
    if (this.current.state === "installing") return false;
    const venvPython = join(this.venv, "bin", "python");
    if ((existsSync(venvPython) && (await this.importable(venvPython))) || (await this.importable("python3"))) {
      this.set({ state: "ready" });
      return true;
    }
    this.set({ state: "installing" });
    void this.install(venvPython);
    return false;
  }

  private async install(venvPython: string): Promise<void> {
    void log("info", "local speech-to-text: installing faster-whisper", { venv: this.venv });
    const steps: Array<[string, string[]]> = [
      ["python3 -m venv failed (is python3-venv installed?)", ["python3", "-m", "venv", this.venv]],
      ["pip install failed", [venvPython, "-m", "pip", "install", "--quiet", ...WHISPER_PACKAGES]],
    ];
    for (const [what, cmd] of steps) {
      const done = await this.run(cmd).catch((err: unknown) => ({ code: -1, output: String(err) }));
      if (done.code !== 0) {
        const error = `${what}: ${done.output.split("\n").slice(-3).join(" ").slice(0, 300)}`;
        void log("warn", "local speech-to-text: install failed", { error });
        this.set({ state: "failed", error });
        return;
      }
    }
    void log("info", "local speech-to-text: faster-whisper installed");
    this.set({ state: "ready" });
  }

  /** Removes the venv and the model it downloaded. The caller checks the engine is not in use. */
  async free(): Promise<void> {
    await rm(this.venv, { recursive: true, force: true });
    await rm(whisperModelDir(), { recursive: true, force: true });
    this.set({ state: "idle" });
  }

  paths(): string[] {
    return [this.venv, whisperModelDir()];
  }
}

export const whisperRuntime = new WhisperRuntime();

/** Bytes held on disk by a set of paths; 0 for what does not exist. */
export async function diskBytes(paths: string[], run: Run = runCommand): Promise<number> {
  const present = paths.filter((p) => existsSync(p));
  if (present.length === 0) return 0;
  const out = await run(["du", "-sbc", ...present]);
  const total = /^(\d+)\s+total$/m.exec(out.output);
  return total ? Number(total[1]) : 0;
}

export async function freeEmbeddingModels(): Promise<void> {
  await rm(TRANSFORMERS_CACHE, { recursive: true, force: true });
}
