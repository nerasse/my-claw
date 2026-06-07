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
