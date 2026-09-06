/**
 * Sentinel for a run cancelled by the user (`/stop`). Threaded by reference through
 * the whole run subtree via a shared AbortSignal; never swallowed by tool try/catch.
 */
export class AbortedError extends Error {
  constructor() {
    super("Run aborted by user");
    this.name = "AbortedError";
  }
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof AbortedError) return true;
  if (signal?.aborted) return true;
  return err instanceof DOMException && err.name === "AbortError";
}

/** Convert any abort-shaped failure into AbortedError so it bubbles up instead of becoming a tool result. */
export function rethrowIfAborted(err: unknown, signal?: AbortSignal): void {
  if (isAbort(err, signal)) throw new AbortedError();
}

/**
 * A wait that stops when the run does.
 *
 * The retry backoff of the three transports slept on a bare `setTimeout`, so a provider answering
 * `429 Retry-After: 30` made `/stop` a no-op for half a minute: the signal was already aborted,
 * the run was already marked stopped, and the process sat in a timer that nothing could reach.
 * The check happens before the wait as well as during it -- a stop that landed a moment earlier
 * must not buy one more delay.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
