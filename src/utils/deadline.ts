/**
 * The wall of one outbound request, told apart from the run's Stop.
 *
 * A tool that arms its own budget has two ways to end, and they mean opposite things: its wall
 * fired -- this host is slow, a fact for the model to work around and a failure result to hand it
 * -- or the run was stopped, which ends the run (docs/stop.md). Both arrive as an aborted request,
 * so the difference has to be carried, not guessed: this call's timer aborts `own`, a stop aborts
 * the run's signal, and only `expired()` answers for the wall.
 *
 * Classifying by shape instead is what turned a 30s `fetch` budget into "run stopped by user"
 * (2026-09-21). `isAbort` now decides on the run's signal for the same reason.
 *
 * The composite signal still carries both, so a Stop cuts a hung request immediately.
 */
export interface RequestWall {
  /** Hand this to fetch: a Stop cuts the request through it, and so does this wall. */
  readonly signal: AbortSignal;
  /** True when this wall -- never a Stop -- ended the request. */
  readonly expired: () => boolean;
  /** Seconds, for the sentence a caller writes when it expires. */
  readonly seconds: number;
  /** Disarm the timer once the request is over: a pending timer keeps the process awake. */
  readonly clear: () => void;
}

export function requestWall(runSignal: AbortSignal | undefined, ms: number): RequestWall {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(new DOMException(`timed out after ${ms}ms`, "TimeoutError")), ms);
  return {
    signal: runSignal ? AbortSignal.any([own.signal, runSignal]) : own.signal,
    expired: () => own.signal.aborted,
    seconds: ms / 1000,
    clear: () => clearTimeout(timer),
  };
}
