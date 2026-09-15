/**
 * One stop per cycle, derived from the work itself.
 *
 * "A stop is in flight" is not a datum to store, it is a fact about the work: it is true exactly
 * while the work a stop aborted has not departed. The work says so on its own. The signal of the
 * aborted controller stays aborted for the whole wind-down, and the entry that holds it (the
 * registry's `controllers`/`compactions`, the runner's `activeRuns`) is only dropped when the
 * work settles. A flag can desynchronise from that; the abort cannot.
 *
 * A cycle where everything is already aborting has nothing left to take: "stopping", because a
 * second answer for the same stop could only draw a second bubble. Otherwise the abort falls
 * here, on everything that was not already aborting, and the answer is "stopped". No flag at
 * all: nothing to lift, nothing to forget to lift, and an authority that appears tomorrow
 * inherits the behaviour by going through here.
 *
 * Each pending controller is aborted exactly once, so "this call issued the abort" stays true.
 */
export type StopOutcome = "stopped" | "stopping" | "idle";

export function stopOutcomeOf(controllers: readonly AbortController[]): StopOutcome {
  if (controllers.length === 0) return "idle";
  const pending = controllers.filter((controller) => !controller.signal.aborted);
  if (pending.length === 0) return "stopping";
  for (const controller of pending) controller.abort();
  return "stopped";
}
