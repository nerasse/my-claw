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
 */

import type { UnifiedMessage } from "../channels/types.ts";

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

class RunRegistry {
  private controllers = new Map<string, AbortController>();
  private runs = new Map<AbortSignal, RunNode[]>();
  private mailboxes = new Map<string, Mailbox>();

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

  /** Abort the whole subtree of a session's run. Returns false if nothing was running. */
  stop(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** True while any top-level run is in flight, across every session. */
  hasAny(): boolean {
    return this.controllers.size > 0;
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
    mb.accepting = false;
    for (const item of mb.claimed) {
      if (outcome === "resolve") item.resolve();
      else item.reject(err);
    }
    for (const item of mb.pending) {
      // Pending-but-undrained at settle only happens on forced close (budget exhausted) or
      // abort/error. On success: reroute to a fresh run; otherwise propagate the failure.
      if (outcome === "resolve") item.reject(new RerouteSignal(item.message));
      else item.reject(err);
    }
    mb.claimed.length = 0;
    mb.pending.length = 0;
  }

  clear(): void {
    this.controllers.clear();
    this.runs.clear();
    this.mailboxes.clear();
  }
}

export const runRegistry = new RunRegistry();
