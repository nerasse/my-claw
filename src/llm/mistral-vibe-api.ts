/**
 * The Mistral API calls behind the `vibe` tool, on the Vibe plan's allowance.
 *
 * Every call here carries the same fingerprint as the chat transport: the Vibe user-agent, an
 * affinity UUID, and `metadata.call_source: "vibe_code"` in the JSON body. That field is what
 * bills the call to the Vibe allowance instead of the API key's own pool, and every endpoint that
 * accepts a JSON body does (measured 2026-11-28 on chat, OCR, speech and image generation). The
 * multipart transcription endpoint does not, so transcription goes through chat with Voxtral's
 * audio input instead, which does accept the metadata.
 *
 * See docs/mistral-backend.md for the captures and the endpoint matrix.
 */
import { refreshEnvFile, type MyClawConfig } from "../core/config.ts";
import { vibeMetadata, vibeSessionId, vibeHeaders } from "./mistral-vibe.ts";

const DEFAULT_BASE = "https://api.mistral.ai/v1";
const IMAGE_MODEL = "mistral-large-4-0";
const OCR_MODEL = "mistral-ocr-latest";
const TTS_MODEL = "voxtral-mini-tts-3";
const TRANSCRIBE_MODEL = "voxtral-small-2507";
const CHAT_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface VibeCredentials {
  provider: string;
  apiKey: string;
  baseUrl: string;
  /** Stable for the tool's lifetime: sent as `x-affinity` and as `metadata.session_id`. */
  sessionId: string;
}

/** The first enabled `mistral-vibe` provider that has its key, or nothing. */
export function vibeCredentials(config: MyClawConfig): VibeCredentials | undefined {
  refreshEnvFile();
  for (const [provider, entry] of Object.entries(config.llm?.providers ?? {})) {
    if (entry.type !== "mistral-vibe" || entry.disabled) continue;
    const apiKey = process.env[entry.apiKeyEnv ?? "MISTRAL_API_KEY"];
    if (!apiKey) continue;
    return {
      provider,
      apiKey,
      baseUrl: (entry.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, ""),
      sessionId: vibeSessionId(`vibe-tool:${provider}`),
    };
  }
  return undefined;
}

function errorMessage(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) return fallback;
  const record = data as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  if (typeof record["message"] === "string") return record["message"];
  if (typeof record["detail"] === "string") return record["detail"];
  return fallback;
}

async function call(
  credentials: VibeCredentials,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(`${credentials.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credentials.apiKey}`,
      ...vibeHeaders(credentials.sessionId),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let data: unknown = raw;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    // The text is the provider's answer, and the message below carries a slice of it.
  }
  if (!response.ok) {
    throw new Error(`Mistral ${path}: HTTP ${response.status} — ${errorMessage(data, raw.slice(0, 300))}`);
  }
  return data;
}

function body(credentials: VibeCredentials, value: Record<string, unknown>): string {
  return JSON.stringify({ ...value, metadata: vibeMetadata(credentials.sessionId) });
}

/** The visible text of an assistant `content` that is a string or Mistral's part list. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const record = part as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string" ? [record["text"]] : [];
    })
    .join("");
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// Image generation

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

function imageUrlOf(data: unknown): string | undefined {
  const root = recordOf(data);
  const choice = root && Array.isArray(root["choices"]) ? recordOf((root["choices"] as unknown[])[0]) : undefined;
  // `chat.multi_completion`: the server ran the image tool itself and the tool result carries the
  // signed URL. The final assistant message repeats it as markdown, which is the fallback.
  const messages = choice && Array.isArray(choice["messages"]) ? choice["messages"] : [];
  for (const entry of messages) {
    const message = recordOf(entry);
    if (message?.["role"] !== "tool" || typeof message["content"] !== "string") continue;
    try {
      const result = JSON.parse(message["content"]) as Record<string, unknown>;
      if (typeof result["url"] === "string") return result["url"];
    } catch {
      // Not the JSON tool result; the markdown fallback below still applies.
    }
  }
  const single = choice ? choice["message"] : undefined;
  const text = textOf(recordOf(single)?.["content"]) || textOf(choice?.["content"]);
  return text.match(/https:\/\/[^\s)\]]+/)?.[0];
}

export async function vibeImage(credentials: VibeCredentials, prompt: string): Promise<GeneratedImage> {
  const data = await call(credentials, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(credentials, {
      model: IMAGE_MODEL,
      stream: false,
      max_tokens: 400,
      tools: [{ type: "image_generation" }],
      messages: [{ role: "user", content: prompt }],
    }),
  }, CHAT_TIMEOUT_MS);

  const url = imageUrlOf(data);
  if (!url) throw new Error("Mistral returned no image URL");
  const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`image download: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  return { bytes, mimeType: sniffImageType(bytes, header) };
}

/** The blob host answers `application/octet-stream` for a JPEG (measured 2026-11-28). */
function sniffImageType(bytes: Uint8Array, header: string | undefined): string {
  if (header?.startsWith("image/")) return header;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/png";
}

// ---------------------------------------------------------------------------------------------
// OCR

export interface OcrResult {
  markdown: string;
  pages: number;
}

export async function vibeOcr(
  credentials: VibeCredentials,
  document: { bytes: Uint8Array; mimeType: string; filename?: string } | { url: string },
  pages?: string,
): Promise<OcrResult> {
  const chunk = "url" in document
    ? documentUrlChunk(document.url)
    : documentUrlChunk(`data:${document.mimeType};base64,${Buffer.from(document.bytes).toString("base64")}`, document.filename);
  const data = await call(credentials, "/ocr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(credentials, {
      model: OCR_MODEL,
      document: chunk,
      ...(pages ? { pages } : {}),
    }),
  }, DEFAULT_TIMEOUT_MS);

  const root = recordOf(data);
  const list = root && Array.isArray(root["pages"]) ? root["pages"] : [];
  const markdown = list
    .map((entry) => {
      const page = recordOf(entry);
      return typeof page?.["markdown"] === "string" ? page["markdown"] : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  if (!markdown) throw new Error("Mistral OCR returned no text");
  return { markdown, pages: list.length };
}

function documentUrlChunk(url: string, filename?: string): Record<string, unknown> {
  const isPdf = url.startsWith("data:application/pdf") || /\.pdf(?:$|\?)/i.test(url);
  return isPdf
    ? { type: "document_url", document_url: url, ...(filename ? { document_name: filename } : {}) }
    : { type: "image_url", image_url: url };
}

// ---------------------------------------------------------------------------------------------
// Speech

export async function vibeSpeech(
  credentials: VibeCredentials,
  text: string,
  voiceId?: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const data = await call(credentials, "/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(credentials, {
      model: TTS_MODEL,
      input: text,
      ...(voiceId ? { voice_id: voiceId } : { voice_id: "voice_3150" }),
    }),
  }, DEFAULT_TIMEOUT_MS);

  const audio = recordOf(data)?.["audio_data"];
  if (typeof audio !== "string" || audio.length === 0) throw new Error("Mistral speech returned no audio");
  return { bytes: new Uint8Array(Buffer.from(audio, "base64")), mimeType: "audio/mpeg" };
}

// ---------------------------------------------------------------------------------------------
// Transcription, through Voxtral's audio input on chat

export async function vibeTranscribe(
  credentials: VibeCredentials,
  bytes: Uint8Array,
  language?: string,
): Promise<string> {
  const instruction = language
    ? `Transcribe this audio exactly, in ${language}. Reply with the transcript only.`
    : "Transcribe this audio exactly. Reply with the transcript only.";
  const data = await call(credentials, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(credentials, {
      model: TRANSCRIBE_MODEL,
      stream: false,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "input_audio", input_audio: Buffer.from(bytes).toString("base64") },
          { type: "text", text: instruction },
        ],
      }],
    }),
  }, CHAT_TIMEOUT_MS);

  const root = recordOf(data);
  const choice = root && Array.isArray(root["choices"]) ? recordOf((root["choices"] as unknown[])[0]) : undefined;
  const text = textOf(recordOf(choice?.["message"])?.["content"]).trim();
  if (!text) throw new Error("Mistral transcription returned no text");
  return text;
}

// ---------------------------------------------------------------------------------------------
// Account and catalogue

export interface VibeAccount {
  email?: string;
  plan?: string;
  organization?: string;
  workspace?: string;
  vibe?: { usedPercent: number; total?: number; currency?: string; resetAt?: string };
  api?: { usedPercent: number; total?: number; currency?: string; resetAt?: string };
  payg?: boolean;
}

function budgetOf(value: unknown): VibeAccount["vibe"] | undefined {
  const record = recordOf(value);
  const used = record?.["usage_percentage"];
  if (!record || typeof used !== "number") return undefined;
  return {
    usedPercent: used,
    ...(typeof record["initial_budget"] === "number" ? { total: record["initial_budget"] } : {}),
    ...(typeof record["currency"] === "string" ? { currency: record["currency"] } : {}),
    ...(typeof record["reset_at"] === "string" ? { resetAt: record["reset_at"] } : {}),
  };
}

export async function vibeAccount(credentials: VibeCredentials): Promise<VibeAccount> {
  const [identity, budget, subscription] = await Promise.all([
    call(credentials, "/users/me", { method: "GET" }, DEFAULT_TIMEOUT_MS).catch(() => undefined),
    call(credentials, "/billing/budget", { method: "GET" }, DEFAULT_TIMEOUT_MS).catch(() => undefined),
    call(credentials, "/billing/subscription", { method: "GET" }, DEFAULT_TIMEOUT_MS).catch(() => undefined),
  ]);
  const me = recordOf(identity);
  const plan = recordOf(subscription);
  const budgets = recordOf(budget);
  const account: VibeAccount = {};
  if (typeof me?.["email"] === "string") account.email = me["email"];
  if (typeof plan?.["plan_name"] === "string") account.plan = plan["plan_name"];
  const workspace = recordOf(me?.["workspace"]);
  if (typeof workspace?.["name"] === "string") account.workspace = workspace["name"];
  const organization = recordOf(me?.["organization"]);
  if (typeof organization?.["name"] === "string") account.organization = organization["name"];
  account.vibe = budgetOf(budgets?.["vibe_budget"]);
  account.api = budgetOf(budgets?.["api_budget"]) ?? budgetOf(budgets);
  const payg = plan?.["vibe_payg_enabled"] ?? plan?.["payg_enabled"];
  if (typeof payg === "boolean") account.payg = payg;
  return account;
}

export async function vibeModels(credentials: VibeCredentials): Promise<string[]> {
  const data = await call(credentials, "/models", { method: "GET" }, DEFAULT_TIMEOUT_MS);
  const root = recordOf(data);
  const rows = root && Array.isArray(root["data"]) ? root["data"] : [];
  return rows.flatMap((entry) => {
    const model = recordOf(entry);
    const id = model?.["id"];
    const capabilities = recordOf(model?.["capabilities"]);
    if (typeof id !== "string" || capabilities?.["completion_chat"] === false) return [];
    return [id];
  });
}
