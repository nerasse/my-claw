const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MIN_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER = 0.1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERRCODES = new Set(["M_LIMIT_EXCEEDED", "M_UNKNOWN"]);
const RETRYABLE_TEXT_PATTERNS = /\b429\b|M_LIMIT_EXCEEDED|timeout|network|temporarily|unavailable|reset|connect|closed/i;

export function isMatrixRetryableError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const typed = err as { httpStatus?: number; errcode?: string; statusCode?: number };
    if (typeof typed.httpStatus === "number" && RETRYABLE_HTTP_STATUS.has(typed.httpStatus)) return true;
    if (typeof typed.statusCode === "number" && RETRYABLE_HTTP_STATUS.has(typed.statusCode)) return true;
    if (typeof typed.errcode === "string" && RETRYABLE_ERRCODES.has(typed.errcode)) return true;
  }
  const text = String(err);
  return RETRYABLE_TEXT_PATTERNS.test(text);
}

export function matrixRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate =
    "data" in err && err.data && typeof err.data === "object"
      ? (err.data as { retry_after_ms?: unknown }).retry_after_ms
      : "retry_after_ms" in err
        ? (err as { retry_after_ms?: unknown }).retry_after_ms
        : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : undefined;
}

export async function withMatrixRetry<T>(params: {
  task: () => Promise<T>;
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  shouldRetry?: (err: unknown) => boolean;
}): Promise<T> {
  const attempts = Math.max(1, Math.floor(params.attempts ?? DEFAULT_ATTEMPTS));
  const minDelayMs = Math.max(1, Math.floor(params.minDelayMs ?? DEFAULT_MIN_DELAY_MS));
  const maxDelayMs = Math.max(minDelayMs, Math.floor(params.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
  const jitter = Math.max(0, params.jitter ?? DEFAULT_JITTER);
  const shouldRetry = params.shouldRetry ?? isMatrixRetryableError;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await params.task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }
      const retryAfterMs = matrixRetryAfterMs(error);
      const base = retryAfterMs ?? Math.min(maxDelayMs, minDelayMs * 2 ** Math.max(0, attempt - 1));
      const delay = Math.max(
        minDelayMs,
        Math.min(maxDelayMs, Math.round(base * (1 + (Math.random() * 2 - 1) * jitter))),
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
