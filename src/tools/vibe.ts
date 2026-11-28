/**
 * One tool over the Mistral Vibe plan: image generation, OCR, speech, transcription and the
 * account's own numbers.
 *
 * Registered only while a `mistral-vibe` provider has its key (the registry's conditional
 * provider), so an install without the plan never sees it. Every action is billed to the Vibe
 * allowance through `metadata.call_source`, never to the API key's pool; the endpoint matrix and
 * the captures live in docs/mistral-backend.md.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { MyClawConfig } from "../core/config.ts";
import {
  vibeAccount,
  vibeCredentials,
  vibeImage,
  vibeModels,
  vibeOcr,
  vibeSpeech,
  vibeTranscribe,
  type VibeCredentials,
} from "../llm/mistral-vibe-api.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { str, strOpt, type Tool, type ToolResult } from "./types.ts";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const DOCUMENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

async function readInput(path: string): Promise<{ bytes: Uint8Array; name: string }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > MAX_INPUT_BYTES) throw new Error(`file is ${Math.round(info.size / 1024 / 1024)} MB, the limit is 25 MB`);
  return { bytes: new Uint8Array(await readFile(path)), name: path };
}

/** Voxtral reads mp3 and wav only; the app's own voice notes are WebM/Opus. */
async function playableAudio(path: string, bytes: Uint8Array): Promise<Uint8Array> {
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const mp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3));
  if (riff || mp3) return bytes;
  const dir = await mkdtemp(join(tmpdir(), "vibe-audio-"));
  const input = join(dir, `input${extname(path) || ".bin"}`);
  const output = join(dir, "output.wav");
  await writeFile(input, bytes);
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", output], { timeout: 120_000 });
  return new Uint8Array(await readFile(output));
}

async function saveTemp(prefix: string, extension: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, `output${extension}`);
  await writeFile(path, bytes);
  return path;
}

/** PNG is the one format the app always reads; the others are kept only when the API said so. */
function imageExtension(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType] ?? ".png";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatAccount(account: Awaited<ReturnType<typeof vibeAccount>>): string {
  const lines: string[] = [];
  if (account.email) lines.push(`Account: ${account.email}`);
  const places = [account.organization, account.workspace].filter(Boolean);
  if (places.length > 0) lines.push(`Where: ${places.join(" / ")}`);
  if (account.plan) lines.push(`Plan: ${account.plan}${account.payg ? " (pay as you go)" : ""}`);
  const money = (label: string, purse: typeof account.vibe): void => {
    if (!purse) return;
    const total = purse.total === undefined ? "" : ` of ${purse.total.toFixed(2)} ${purse.currency ?? ""}`.trimEnd();
    const left = purse.total === undefined ? "" : `, ${(purse.total * (1 - purse.usedPercent / 100)).toFixed(2)} left`;
    lines.push(`${label}: ${purse.usedPercent.toFixed(2)}% used${total}${left}${purse.resetAt ? `, resets ${purse.resetAt}` : ""}`);
  };
  money("Vibe credits", account.vibe);
  money("API credits", account.api);
  return lines.length > 0 ? lines.join("\n") : "Mistral answered nothing about this account.";
}

export function createVibeTool(config: MyClawConfig): Tool {
  async function image(credentials: VibeCredentials, args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = str(args, "prompt").trim();
    if (!prompt) return { success: false, output: "", error: "image needs prompt" };
    const generated = await vibeImage(credentials, prompt);
    const path = await saveTemp("vibe-image-", imageExtension(generated.mimeType), generated.bytes);
    return {
      success: true,
      output:
        `Image generated: ${path}\n` +
        `Not sent yet. To send it, put MEDIA:${path} in your answer.`,
      keepFromReply: true,
      attachments: [{ type: "image", path, mimeType: generated.mimeType }],
    };
  }

  async function ocr(credentials: VibeCredentials, args: Record<string, unknown>): Promise<ToolResult> {
    const url = strOpt(args, "url")?.trim();
    const path = strOpt(args, "path")?.trim();
    if (!url && !path) return { success: false, output: "", error: "ocr needs path or url" };
    let document: { bytes: Uint8Array; mimeType: string; filename?: string } | { url: string };
    if (url) {
      document = { url };
    } else {
      const resolved = resolveWorkspacePath(path!, strOpt(args, "__workspaceDir"));
      const mimeType = DOCUMENT_TYPES[extname(resolved).toLowerCase()];
      if (!mimeType) return { success: false, output: "", error: `ocr does not read ${extname(resolved) || "this file type"}; use png, jpg, webp, gif or pdf` };
      const input = await readInput(resolved);
      document = { bytes: input.bytes, mimeType, filename: resolved };
    }
    const result = await vibeOcr(credentials, document, strOpt(args, "pages"));
    return { success: true, output: `OCR: ${result.pages} page(s)\n\n${result.markdown}` };
  }

  async function speak(credentials: VibeCredentials, args: Record<string, unknown>): Promise<ToolResult> {
    const text = str(args, "text").trim();
    if (!text) return { success: false, output: "", error: "speak needs text" };
    const speech = await vibeSpeech(credentials, text, strOpt(args, "voice"));
    const path = await saveTemp("vibe-speech-", ".mp3", speech.bytes);
    return {
      success: true,
      output:
        `Audio generated: ${path}\n` +
        `Not sent yet. To send it, put MEDIA:${path} in your answer.`,
      keepFromReply: true,
      attachments: [{ type: "audio", path, mimeType: speech.mimeType }],
    };
  }

  async function transcribe(credentials: VibeCredentials, args: Record<string, unknown>): Promise<ToolResult> {
    const path = strOpt(args, "path")?.trim();
    if (!path) return { success: false, output: "", error: "transcribe needs path" };
    const resolved = resolveWorkspacePath(path, strOpt(args, "__workspaceDir"));
    const input = await readInput(resolved);
    const audio = await playableAudio(resolved, input.bytes);
    const text = await vibeTranscribe(credentials, audio, strOpt(args, "language"));
    return { success: true, output: text };
  }

  async function account(credentials: VibeCredentials): Promise<ToolResult> {
    const snapshot = await vibeAccount(credentials);
    if (Object.keys(snapshot).length === 0) return { success: false, output: "", error: "Mistral answered nothing about this account" };
    return { success: true, output: formatAccount(snapshot) };
  }

  async function models(credentials: VibeCredentials): Promise<ToolResult> {
    const ids = await vibeModels(credentials);
    return ids.length > 0
      ? { success: true, output: ids.join("\n") }
      : { success: false, output: "", error: "Mistral listed no chat model for this key" };
  }

  return {
    name: "vibe",
    description:
      "Use the Mistral Vibe plan: generate an image, OCR a document, synthesize speech, transcribe an " +
      "audio file, or read the account's plan and credits. Every call is billed to the Vibe allowance. " +
      "Available only while a Mistral Vibe provider is configured.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["image", "ocr", "speak", "transcribe", "account", "models"],
          description: "What to do: image, ocr, speak, transcribe, account, or models.",
        },
        prompt: { type: "string", description: "image: what to draw." },
        path: { type: "string", description: "ocr and transcribe: a local file. Relative paths resolve against the workspace." },
        url: { type: "string", description: "ocr: a public document URL instead of a local path." },
        pages: { type: "string", description: "ocr: pages to read, e.g. \"0,2-4\". Default: all." },
        text: { type: "string", description: "speak: the text to read." },
        voice: { type: "string", description: "speak: a Mistral voice id or slug. Default: voice_3150." },
        language: { type: "string", description: "transcribe: the audio's language, e.g. fr. Optional." },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const credentials = vibeCredentials(config);
      if (!credentials) {
        return { success: false, output: "", error: "No active Mistral Vibe provider: configure one with its API key first." };
      }
      const action = str(args, "action");
      try {
        switch (action) {
          case "image": return await image(credentials, args);
          case "ocr": return await ocr(credentials, args);
          case "speak": return await speak(credentials, args);
          case "transcribe": return await transcribe(credentials, args);
          case "account": return await account(credentials);
          case "models": return await models(credentials);
          default:
            return { success: false, output: "", error: `Invalid action: ${action || "(none)"}. Use image, ocr, speak, transcribe, account or models.` };
        }
      } catch (err) {
        return { success: false, output: "", error: errorText(err) };
      }
    },
  };
}

/** The registry's conditional set: the tool exists only while the plan is configured and keyed. */
export function vibeTools(config: MyClawConfig): Tool[] {
  const credentials = vibeCredentials(config);
  if (!credentials) return [];
  // The provider page's switch, on unless turned off: chat keeps working, the tool disappears.
  if (config.llm?.providers?.[credentials.provider]?.vibeTool === false) return [];
  return [createVibeTool(config)];
}
