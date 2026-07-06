import { lookup } from "node:dns/promises";
import { type Tool, type ToolResult, num, str, strOpt } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import { hooks } from "../hooks/index.ts";

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);

// A raw HTML page (scripts, styles, inline CSS) can be hundreds of KB of noise that the
// model never needs and that poisons the whole session context once stored. We convert
// HTML to readable text and cap the size before it ever reaches the LLM.
const MAX_FETCH_CHARS = 50_000;

// Hard ceiling on bytes pulled into memory before windowing. response.text() would buffer the
// whole body (hundreds of MB for a bad URL) before a single char is trimmed; stop reading early.
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_FETCH_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(merged);
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript|svg|template)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType && /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return true;
  if (contentType && /\b(application\/json|text\/plain|text\/csv|application\/xml)\b/i.test(contentType)) {
    return false;
  }
  return /<!doctype html|<html[\s>]|<body[\s>]/i.test(body.slice(0, 2000));
}

/** A JS-rendered SPA shell (Instagram, TikTok...) converts to near-empty text ("- | -"
 *  junk); without a hint the model keeps re-fetching it. Detects a large HTML body whose
 *  readable text is almost nothing. */
export function isJsRenderedShell(body: string, contentType: string | null): boolean {
  if (!looksLikeHtml(contentType, body)) return false;
  if (body.length < 5000) return false;
  const meaningful = htmlToText(body).replace(/[-|*•\s]/g, "");
  return meaningful.length < 200;
}

const JS_SHELL_HINT =
  "\n\n[Note: this page appears to be JavaScript-rendered — fetch cannot execute scripts, so there is almost no readable text here. Re-fetching will not help; use delegate_browser_task to read it in the real browser.]";

// Windowed output: each call is bounded (cost + context), but the model is never blind to
// the rest — it can re-call fetch with a larger `offset` to page through the full content.
export function processFetchBody(
  body: string,
  contentType: string | null,
  offset = 0,
  limit = MAX_FETCH_CHARS,
): string {
  const text = looksLikeHtml(contentType, body) ? htmlToText(body) : body;
  const total = text.length;
  const start = Math.max(0, Math.floor(offset));
  const window = Math.min(Math.max(1, Math.floor(limit)), MAX_FETCH_CHARS);

  if (start >= total && total > 0) {
    return `[fin du contenu : offset ${start} >= total ${total} caractères. Rien de plus à lire.]`;
  }

  const end = Math.min(start + window, total);
  const slice = text.slice(start, end);
  if (start === 0 && end === total) return slice;

  const header =
    start > 0
      ? `[suite : caractères ${start}–${end} sur ${total}]\n`
      : "";
  const footer =
    end < total
      ? `\n\n[... ${total - end} caractères restants. Pour lire la suite, rappelle fetch avec offset=${end} (même URL). ...]`
      : "\n\n[fin du contenu]";
  return `${header}${slice}${footer}`;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice(7);
      if (mapped.includes(".")) return isPrivateIp(mapped);
      // Hex form: ::ffff:7f00:1 -> 127.0.0.1
      const hexParts = mapped.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0]!, 16);
        const lo = parseInt(hexParts[1]!, 16);
        if (!isNaN(hi) && !isNaN(lo)) {
          const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isPrivateIp(v4);
        }
      }
    }
    return false;
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) return true;
  if (first === 192 && Number(parts[1]) === 168) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("0.") || ip === "0.0.0.0") return true;
  return false;
}

export function isPrivateUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname === "localhost") return true;
  if (isPrivateIp(hostname)) return true;
  return false;
}

export async function resolveAndCheckUrl(raw: string): Promise<boolean> {
  if (isPrivateUrl(raw)) return true;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  try {
    const results = await lookup(hostname, { all: true });
    for (const { address } of results) {
      if (isPrivateIp(address)) return true;
    }
  } catch {
    // DNS failure will also fail the fetch; allow through
  }
  return false;
}

export const fetchTool: Tool = {
  name: "fetch",
  description:
    "Make an HTTP request. HTML responses are converted to readable text. Large responses " +
    `are returned in windows of up to ${MAX_FETCH_CHARS} characters; if content remains, the ` +
    "output ends with the exact `offset` to pass on a follow-up call to read the next window.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method" },
      body: { type: "string", description: "Request body (for POST/PUT)" },
      offset: {
        type: "number",
        description: "Character offset to start reading from (default 0). Use the value suggested in a previous truncated response to page through long content.",
      },
    },
    required: ["url"],
  },
  async execute(args): Promise<ToolResult> {
    const url = str(args, "url");
    if (!url.trim()) {
      return { success: false, output: "url is required and cannot be empty." };
    }
    if (await resolveAndCheckUrl(url)) {
      return { success: false, output: "", error: "Blocked: URL points to a private/internal network address." };
    }
    const signal = args["__signal"] as AbortSignal | undefined;
    rethrowIfAborted(undefined, signal);
    try {
      const MAX_REDIRECTS = 5;
      let currentUrl = url;
      // 301/302/303 conventionally become GET (drop the body); 307/308 MUST preserve the method
      // and body, or a POST behind such a redirect silently turns into an empty GET.
      let currentMethod = strOpt(args, "method") ?? "GET";
      let currentBody = strOpt(args, "body");

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const reqSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        const response = await fetch(currentUrl, {
          method: currentMethod,
          body: currentBody,
          redirect: "manual",
          signal: reqSignal,
        });
        clearTimeout(timer);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            return { success: false, output: "", error: `Redirect (HTTP ${response.status}) from ${currentUrl} with no Location header.` };
          }
          const resolved = new URL(location, currentUrl).href;
          if (await resolveAndCheckUrl(resolved)) {
            return { success: false, output: "", error: "Blocked: redirect target points to a private/internal network address." };
          }
          if (response.status !== 307 && response.status !== 308) {
            currentMethod = "GET";
            currentBody = undefined;
          }
          currentUrl = resolved;
          continue;
        }

        const rawText = await readCapped(response);
        const contentType = response.headers.get("content-type");
        let text = processFetchBody(rawText, contentType, num(args, "offset", 0));
        if (isJsRenderedShell(rawText, contentType)) {
          text += JS_SHELL_HINT;
        }
        hooks.emit("tool:fetch:request", { url: currentUrl, method: currentMethod, status: response.status });
        if (response.ok) {
          return { success: true, output: text };
        }
        return {
          success: false,
          output: text,
          error: `HTTP ${response.status} from ${currentUrl}. Check the URL, method, and authentication.`,
        };
      }

      return { success: false, output: "", error: "Too many redirects." };
    } catch (e) {
      rethrowIfAborted(e, signal);
      return { success: false, output: "", error: formatError(`Failed to fetch "${url}"`, e) };
    }
  },
};
