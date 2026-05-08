const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MIN_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER = 0.1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMatrixRetryableError(err: unknown): boolean {
  const text = String(err).toLowerCase();
  return (
    text.includes("429") ||
    text.includes("m_limit_exceeded") ||
    text.includes("timeout") ||
    text.includes("network") ||
    text.includes("temporarily") ||
    text.includes("unavailable") ||
    text.includes("reset") ||
    text.includes("connect") ||
    text.includes("closed")
  );
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
