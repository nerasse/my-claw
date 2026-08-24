/**
 * Tracks in-flight agent runs. Three jobs:
 *  - stop target: one AbortController per top-level session (`/stop`).
 *  - live view: every run (main + sub-agents at any depth) is a node, grouped by the
 *    root AbortSignal it shares. The shared signal is the cross-level link, so no
 *    parent->child map is maintained and the bookkeeping can never diverge from the
 *    real abort (the signal is the source of truth, this registry is observability).
 *  - injection mailbox: a per-session inbox so a message arriving while a run is in
 *    progress is injected into that run at the next iteration boundary (mid-run steering)
 *    instead of waiting for the whole run to finish. See `docs/injection.md`.
 *  - compaction hold: a compaction rewrites the very history a run would resume, so it takes
 *    the session for its whole duration. Runs and compactions exclude each other in both
 *    directions. See `docs/compaction.md`.
 */

import type { UnifiedMessage } from "../channels/types.ts";
import { isAbort } from "./aborted.ts";

export interface RunNode {
  label: string;
  depth: number;
  startedAt: number;
}

/** Thrown into a pending injection's promise when the run ended without absorbing it
 *  (forced close: iteration budget exhausted). The caller re-routes it as a fresh run. */
export class RerouteSignal extends Error {
  constructor(public readonly injected: UnifiedMessage) {
    super("injection rerouted to a new run");
    this.name = "RerouteSignal";
  }
}

interface InjectionItem {
  message: UnifiedMessage;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface Mailbox {
  pending: InjectionItem[]; // arrived, not yet drained by the run
  claimed: InjectionItem[]; // drained into the run, awaiting final resolution
  accepting: boolean; // false once the run commits to ending
}

/** Hard cap on injections per run, regardless of config -- guards against an injection
 *  spam keeping a run alive forever. Beyond it, messages fall back to a new queued run. */
export const MAX_INJECTIONS_PER_RUN = 25;

interface Compaction {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

class RunRegistry {
  private controllers = new Map<string, AbortController>();
  private runs = new Map<AbortSignal, RunNode[]>();
  private mailboxes = new Map<string, Mailbox>();
  private compactions = new Map<string, Compaction>();

  /** Called by the router when a top-level run starts. */
  startRoot(sessionId: string): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    this.runs.set(controller.signal, []);
    this.mailboxes.set(sessionId, { pending: [], claimed: [], accepting: true });
    return {
      signal: controller.signal,
      end: () => {
        if (this.controllers.get(sessionId) === controller) {
          this.controllers.delete(sessionId);
        }
        this.runs.delete(controller.signal);
        this.mailboxes.delete(sessionId);
      },
    };
  }

  /** Called by every AgentBridge.handle (main and sub-agents) to register itself in the live view. */
  enter(signal: AbortSignal, label: string, depth: number): { exit: () => void } | undefined {
    const list = this.runs.get(signal);
    if (!list) return undefined;
    const node: RunNode = { label, depth, startedAt: Date.now() };
    list.push(node);
    return {
      exit: () => {
        const i = list.indexOf(node);
        if (i >= 0) list.splice(i, 1);
      },
    };
  }

  /** Abort the whole subtree of a session's run, or its compaction. False if nothing was running. */
  stop(sessionId: string): boolean {
    const compaction = this.compactions.get(sessionId);
    if (compaction) {
      compaction.controller.abort();
      return true;
    }
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  // --- Compaction hold ---------------------------------------------------------------

  /**
   * Takes the session for a compaction. Both engines rewrite the history a run resumes -- the
   * SDK one by driving a second CLI process on the same session file -- so the two must never
   * overlap: a run in flight refuses the hold, and a run starting later waits for it
   * (`waitForCompaction`). Returns null when the session is already taken.
   */
  beginCompaction(sessionId: string): { signal: AbortSignal; release: () => void } | null {
    if (this.controllers.has(sessionId) || this.compactions.has(sessionId)) return null;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Compaction = { controller: new AbortController(), done, finish };
    this.compactions.set(sessionId, entry);
    return {
      signal: entry.controller.signal,
      release: () => {
        if (this.compactions.get(sessionId) === entry) this.compactions.delete(sessionId);
        finish();
      },
    };
  }

  isCompacting(sessionId: string): boolean {
    return this.compactions.has(sessionId);
  }

  /**
   * Resolves once no compaction holds the session. Loops rather than awaiting once: releasing
   * the hold and taking it again is legal, and a caller must not slip in between the two.
   */
  async waitForCompaction(sessionId: string): Promise<void> {
    for (let held = this.compactions.get(sessionId); held; held = this.compactions.get(sessionId)) {
      await held.done;
    }
  }

  // --- Injection mailbox -------------------------------------------------------------

  /**
   * Opens a mailbox without a controller. A sub-agent's run is driven from inside a parent's, and
   * its abort must stay the shared root signal -- a controller of its own would cut it out of the
   * parent's /stop cascade. The mailbox alone is what makes the run steerable, so this is all a
   * sub-agent attaches; idempotent, because the app-driven path may already have opened one via
   * startRoot().
   */
  openMailbox(sessionId: string): void {
    if (!this.mailboxes.has(sessionId)) {
      this.mailboxes.set(sessionId, { pending: [], claimed: [], accepting: true });
    }
  }

  /** Removes the mailbox; called when the run that owned it has settled it. */
  closeMailbox(sessionId: string): void {
    this.mailboxes.delete(sessionId);
  }

  /** True while a run can still absorb an injected message (mailbox open, not committed to ending). */
  canInject(sessionId: string): boolean {
    const mailbox = this.mailboxes.get(sessionId);
    return mailbox !== undefined && mailbox.accepting;
  }

  /** True while any top-level run or compaction is in flight, across every session. */
  hasAny(): boolean {
    return this.controllers.size > 0 || this.compactions.size > 0;
  }

  /** Live nodes for a session's run subtree (main + sub-agents), for /status. */
  list(sessionId: string): RunNode[] {
    const controller = this.controllers.get(sessionId);
    if (!controller) return [];
    return this.runs.get(controller.signal) ?? [];
  }

  // --- Injection mailbox -------------------------------------------------------------

  /**
   * Queue a message into the active run's mailbox. Returns a promise that resolves when the
   * run finishes addressing it (-> done reaction) or rejects on abort/error. Returns null if
   * there is no open mailbox (no run, or run already committed to ending, or cap reached) --
   * the caller must then route it as a normal new run.
   */
  enqueueInjection(sessionId: string, message: UnifiedMessage): Promise<void> | null {
    const mb = this.mailboxes.get(sessionId);
    if (!mb || !mb.accepting) return null;
    if (mb.pending.length + mb.claimed.length >= MAX_INJECTIONS_PER_RUN) return null;
    return new Promise<void>((resolve, reject) => {
      mb.pending.push({ message, resolve, reject });
    });
  }

  /** Drain pending injections for this run, keeping the mailbox open (the run continues). */
  drainInjections(sessionId: string): UnifiedMessage[] {
    const mb = this.mailboxes.get(sessionId);
    if (!mb || mb.pending.length === 0) return [];
    const items = mb.pending.splice(0);
    mb.claimed.push(...items);
    return items.map((i) => i.message);
  }

  /**
   * Drain pending injections; if there are none, atomically close the mailbox (no `await`
   * around this call). Used at the run's natural end point so a message that arrived during
   * the final LLM call is still picked up; once closed, late arrivals fall back to a new run.
   */
  drainOrClose(sessionId: string): UnifiedMessage[] {
    const mb = this.mailboxes.get(sessionId);
    if (!mb) return [];
    if (mb.pending.length === 0) {
      mb.accepting = false;
      return [];
    }
    const items = mb.pending.splice(0);
    mb.claimed.push(...items);
    return items.map((i) => i.message);
  }

  /** Resolve/reject all injection promises at the end of a run. */
  settleMailbox(sessionId: string, outcome: "resolve" | "reject", err?: unknown): void {
    const mb = this.mailboxes.get(sessionId);
    if (!mb) return;
    const aborted = outcome === "reject" && isAbort(err);
    mb.accepting = false;
    for (const item of mb.claimed) {
      if (outcome === "resolve") item.resolve();
      else item.reject(err);
    }
    for (const item of mb.pending) {
      // Pending-but-undrained at settle only happens on forced close (budget exhausted) or
      // abort/error. Either way this message was never read, so its own attempt is still owed: the
      // run that died died for its own reasons. It used to inherit that failure and vanish, which
      // read as a send silently dropped. An abort is the exception -- the owner asked for the stop,
      // and reviving the message they interrupted would defeat it.
      if (aborted) item.reject(err);
      else item.reject(new RerouteSignal(item.message));
    }
    mb.claimed.length = 0;
    mb.pending.length = 0;
  }

  clear(): void {
    for (const held of this.compactions.values()) held.finish();
    this.compactions.clear();
    this.controllers.clear();
    this.runs.clear();
    this.mailboxes.clear();
  }
}

export const runRegistry = new RunRegistry();
