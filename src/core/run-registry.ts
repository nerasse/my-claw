/**
 * Tracks in-flight agent runs. Two jobs:
 *  - stop target: one AbortController per top-level session (`/stop`).
 *  - live view: every run (main + sub-agents at any depth) is a node, grouped by the
 *    root AbortSignal it shares. The shared signal is the cross-level link, so no
 *    parent->child map is maintained and the bookkeeping can never diverge from the
 *    real abort (the signal is the source of truth, this registry is observability).
 */

export interface RunNode {
  label: string;
  depth: number;
  startedAt: number;
}

class RunRegistry {
  private controllers = new Map<string, AbortController>();
  private runs = new Map<AbortSignal, RunNode[]>();

  /** Called by the router when a top-level run starts. */
  startRoot(sessionId: string): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    this.runs.set(controller.signal, []);
    return {
      signal: controller.signal,
      end: () => {
        if (this.controllers.get(sessionId) === controller) {
          this.controllers.delete(sessionId);
        }
        this.runs.delete(controller.signal);
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

  /** Live nodes for a session's run subtree (main + sub-agents), for /status. */
  list(sessionId: string): RunNode[] {
    const controller = this.controllers.get(sessionId);
    if (!controller) return [];
    return this.runs.get(controller.signal) ?? [];
  }

  clear(): void {
    this.controllers.clear();
    this.runs.clear();
  }
}

export const runRegistry = new RunRegistry();
