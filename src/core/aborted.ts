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
  // When a signal is given, it is the only authority, because every `AbortedError` this codebase
  // raises is raised under `if (signal?.aborted)` of that same signal: a stop is exactly "the
  // signal of the run being asked about is aborted".
  //
  // The shape of the error is not evidence. A tool's own budget, a socket that died and a
  // sub-agent stopped on its own all arrive as `AbortError` (or as an `AbortedError` raised for
  // *their* signal) while the run's own signal is perfectly alive, and reading those as a user
  // stop is measured, not theoretical: on 2026-09-21 a `fetch` that hung past its own 30s budget
  // ended a research run as "run stopped by user". Nobody had stopped anything. The parent's two
  // sibling sub-agents ran 5 and 9 more minutes, their results landed after the run's `run_end`,
  // and the log needed a dead-branch repair. docs/stop.md.
  if (signal) return signal.aborted;
  // No signal at all: a caller that cannot ask has only the shape to go on.
  if (err instanceof AbortedError) return true;
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * How long a stopped run still waits for a tool that is in its own cleanup.
 *
 * A batch is waited for in full so nothing a run started writes after its `run_end`
 * (docs/stop.md, measured 2026-09-21). That promise is only worth keeping while the tools answer,
 * and on 2026-11-24 one did not: a `bash` call whose detached child held the call's stdout never
 * returned, so the run never unwound, its controller was never dropped, and every Stop after it
 * answered "stopping" for fourteen hours. The grace is the net: a tool that will not settle loses
 * its claim on the run, and the run ends without it.
 */
export const STOP_GRACE_MS = 5_000;

/**
 * Wait for `work`, but never past a stop by more than the grace.
 *
 * A tool is expected to settle on the signal it is handed -- `bash` kills its cgroup, `fetch`
 * cancels its request -- and when it does, its result is the result and the batch keeps its
 * guarantee. What this adds is an end to the wait: a call that ignores the signal is abandoned
 * after `graceMs`, its own listener still registered, its own cleanup still running.
 */
export function untilSettledOrStopped<T>(work: Promise<T>, signal: AbortSignal | undefined, graceMs = STOP_GRACE_MS): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        void work.catch(() => undefined);
        reject(new AbortedError());
      }, graceMs);
      timer.unref?.();
    };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
    work.then(
      (value) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", arm);
        resolve(value);
      },
      (err: unknown) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", arm);
        reject(err);
      },
    );
  });
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
