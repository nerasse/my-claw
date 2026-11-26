import { type Tool, type ToolResult, num, str, strOpt } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import { requestWall, type RequestWall } from "../utils/deadline.ts";
import { hooks } from "../hooks/index.ts";

// A raw HTML page (scripts, styles, inline CSS) can be hundreds of KB of noise that the
// model never needs and that poisons the whole session context once stored. We convert
// HTML to readable text and cap the size before it ever reaches the LLM.
const MAX_FETCH_CHARS = 50_000;

// Hard ceiling on bytes pulled into memory before windowing. response.text() would buffer the
// whole body (hundreds of MB for a bad URL) before a single char is trimmed; stop reading early.
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

/** How long one hop waits for response headers, by default. See requestWall. */
const FETCH_TIMEOUT_MS = 30_000;

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

// The only two schemes this tool speaks, and a redirect is checked like a typed URL: a page that
// 302s to file: is not a different outcome, it is the same one the model did not type.
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function isAllowedScheme(raw: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

export interface FetchToolOptions {
  /** The wall of one hop. Injectable so the timeout path can be tested without waiting 30s. */
  timeoutMs?: number;
  /** The pause before the single retry of a transient failure. Injectable for tests. */
  retryDelayMs?: number;
  /** How long a successful GET answer stays reusable. Injectable for tests. */
  cacheTtlMs?: number;
}

/** 429 and the transient 5xx: the statuses where one retry is worth more than a guess. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_CAP_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_ENTRY_CHARS = 2_000_000;

interface CachedFetch {
  raw: string;
  contentType: string | null;
  shell: boolean;
  at: number;
}

/**
 * A URL that just said "not here".
 *
 * The success cache never held failures, so a model guessing paths at a vendor's documentation
 * could ask the same dead URL five times in a row and pay five round-trips for the same answer --
 * measured at 110 of the 136 fetch failures between 20 and 25 November, three agents walking a
 * documentation tree by guessing names. Ten minutes is short enough that a page published since
 * is not lost, and long enough to break the loop.
 */
interface FailedFetch {
  status: number;
  at: number;
}

const FAILURE_TTL_MS = 10 * 60_000;
/** Every tool instance's cache, so a test run can blank them between files (tests/setup-globals.ts). */
const caches = new Set<Map<string, CachedFetch>>();
const failureCaches = new Set<Map<string, FailedFetch>>();

export function resetFetchToolCaches(): void {
  for (const cache of caches) cache.clear();
  for (const cache of failureCaches) cache.clear();
}

/**
 * What a non-2xx answer means for the caller, in the words that change its next move.
 *
 * "Check the URL, method, and authentication" was true of every status and therefore useless for
 * all of them: a 404 and a 403 want opposite next steps, and a model that reads one sentence for
 * both retries the URL that cannot work. See docs/tool-errors.md.
 */
export function httpErrorText(status: number, url: string): string {
  if (status === 404 || status === 410) {
    return `HTTP ${status} from ${url}: nothing is at this URL. Find the page with web_search (or the site's own index) instead of guessing another path; a near-miss URL is almost always wrong too.`;
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status} from ${url}: the server refused access. That is not a retry and not a quieter request: it needs credentials, or the page is closed to this client.`;
  }
  if (status === 429) {
    return `HTTP 429 from ${url}: the host is rate limiting. Wait or fetch another page; repeating it now answers 429 again.`;
  }
  return `HTTP ${status} from ${url}. The host answered; this is not a network failure. A 5xx may pass on another try, a 4xx will not.`;
}

/** `Retry-After` in either of its two spellings, capped: a host does not get to hold the run. */
export function retryDelayFor(header: string | null, base: number): number {
  if (!header) return base;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_DELAY_CAP_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_DELAY_CAP_MS);
  return base;
}

export function createFetchTool(options: FetchToolOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, CachedFetch>();
  caches.add(cache);
  const failures = new Map<string, FailedFetch>();
  failureCaches.add(failures);
  return {
  name: "fetch",
  description:
    "Make an HTTP request. HTML responses are converted to readable text. Large responses " +
    `are returned in windows of up to ${MAX_FETCH_CHARS} characters; if content remains, the ` +
    "output ends with the exact `offset` to pass on a follow-up call to read the next window. " +
    "A GET that hits a transient 429/5xx is retried once (honoring Retry-After), and a successful " +
    "GET answer is reusable for a few minutes, so re-reading the same URL costs nothing. A URL that " +
    "answered 404 or a refusal is remembered too: asking it again says so instead of paying the trip.",
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
    if (!isAllowedScheme(url)) {
      return { success: false, output: "", error: "Blocked: fetch only follows http and https URLs." };
    }
    const signal = args["__signal"] as AbortSignal | undefined;
    rethrowIfAborted(undefined, signal);
    // 301/302/303 conventionally become GET (drop the body); 307/308 MUST preserve the method
    // and body, or a POST behind such a redirect silently turns into an empty GET.
    let currentUrl = url;
    let currentMethod = strOpt(args, "method") ?? "GET";
    let currentBody = strOpt(args, "body");
    // The wall of the hop that failed, so the catch can say which of the two ended it.
    let wall: RequestWall | undefined;

    const cacheable = currentMethod === "GET" && !currentBody;
    if (cacheable) {
      const hit = cache.get(url);
      if (hit && Date.now() - hit.at < cacheTtlMs) {
        let text = processFetchBody(hit.raw, hit.contentType, num(args, "offset", 0));
        if (hit.shell) text += JS_SHELL_HINT;
        hooks.emit("tool:fetch:request", { url, method: currentMethod, status: 200, cached: true });
        return { success: true, output: text };
      }
      const failed = failures.get(url);
      if (failed && Date.now() - failed.at < FAILURE_TTL_MS) {
        return {
          success: false,
          output: "",
          error: `${httpErrorText(failed.status, url)} This was already asked ${Math.max(1, Math.round((Date.now() - failed.at) / 60_000))} min ago; the answer has not changed.`,
        };
      }
    }

    try {
      const MAX_REDIRECTS = 5;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // One wall per hop, and it names itself: a Stop and this budget abort the same request,
        // and telling them apart is the whole verdict of the run (docs/stop.md).
        const attempt = async (): Promise<Response> => {
          wall = requestWall(signal, timeoutMs);
          const response = await fetch(currentUrl, {
            method: currentMethod,
            body: currentBody,
            redirect: "manual",
            signal: wall.signal,
          });
          wall.clear();
          return response;
        };

        let response = await attempt();
        // A side-effecting method is never replayed; a GET that hit a transient wall twice in a
        // row is the host's answer, and gets reported as one.
        if (currentMethod === "GET" && !signal?.aborted && RETRY_STATUSES.has(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          const delay = retryDelayFor(response.headers.get("retry-after"), retryDelayMs);
          if (delay > 0) await Bun.sleep(delay);
          response = await attempt();
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            return { success: false, output: "", error: `Redirect (HTTP ${response.status}) from ${currentUrl} with no Location header.` };
          }
          const resolved = new URL(location, currentUrl).href;
          if (!isAllowedScheme(resolved)) {
            return { success: false, output: "", error: "Blocked: redirect target is not an http or https URL." };
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
        const shell = isJsRenderedShell(rawText, contentType);
        let text = processFetchBody(rawText, contentType, num(args, "offset", 0));
        if (shell) {
          text += JS_SHELL_HINT;
        }
        hooks.emit("tool:fetch:request", { url: currentUrl, method: currentMethod, status: response.status });
        if (response.ok) {
          if (cacheable && rawText.length <= CACHE_MAX_ENTRY_CHARS) {
            if (cache.size >= CACHE_MAX_ENTRIES) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(url, { raw: rawText, contentType, shell, at: Date.now() });
          }
          return { success: true, output: text };
        }
        // A refusal that cannot change on its own is remembered, so the next call is answered
        // here instead of at the host: guessing paths at a documentation tree is the measured case.
        if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
          failures.set(currentUrl, { status: response.status, at: Date.now() });
        }
        return {
          success: false,
          output: text,
          error: httpErrorText(response.status, currentUrl),
        };
      }

      return { success: false, output: "", error: "Too many redirects." };
    } catch (e) {
      // A Stop first: the run is over, and no message about this request matters any more.
      rethrowIfAborted(e, signal);
      if (wall?.expired()) {
        return {
          success: false,
          output: "",
          error: `Fetch timed out after ${wall.seconds} seconds waiting for ${currentUrl} to respond. The host is slow or holding the connection open: do not retry the same URL blindly, look for the information elsewhere.`,
        };
      }
      return { success: false, output: "", error: formatError(`Failed to fetch "${url}"`, e) };
    }
  },
  };
}

/** The registry's fetch tool: the default wall. */
export const fetchTool: Tool = createFetchTool();
