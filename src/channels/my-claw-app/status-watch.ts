import type { ServerWebSocket } from "bun";
import type { MyClawAppSessionData } from "./controllers.ts";
import type { MyClawAppStatusPayload, MyClawAppStatusResult } from "./types.ts";

export interface StatusWatchDeps {
  /** The report of one conversation; undefined when the command pipeline is not wired. */
  report(owner: string, threadId: string): Promise<MyClawAppStatusPayload | undefined>;
  send(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppStatusResult): void;
  /** The session a thread of an owner resolves to: a conversation, a sub-agent, a cron run. */
  sessionOf(owner: string, threadId: string): string;
  /** The session a sub-agent session bills to, when it has one. */
  parentOf(sessionId: string): Promise<string | undefined>;
  /** How long a burst is gathered before one report goes out. */
  settleMs?: number;
}

/** A call, its recording and the run events around it land within a few ms of each other. */
const DEFAULT_SETTLE_MS = 250;

/** Sub-agents nest two deep; the walk stops well past that rather than trusting the data. */
const MAX_ANCESTORS = 4;

interface Page {
  owner: string;
  threadId: string;
  sessionId: string;
}

/**
 * The status pages open right now, and the push that keeps them current.
 *
 * The page used to ask again on every reading the app happened to hear about, which left it
 * blind to what it could not hear: a sub-agent's calls land on the sub-agent's thread, not the
 * parent's, and the parent's page kept its "delegated" figure until the parent itself spoke. The
 * server knows every event that moves a report, so it pushes: a page is registered with its
 * socket, every change names the session it happened in, and the pages open on that session or
 * on any conversation above it get a fresh report, one per burst.
 */
export class StatusWatch {
  private readonly pages = new Map<ServerWebSocket<MyClawAppSessionData>, Page>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settleMs: number;

  constructor(private readonly deps: StatusWatchDeps) {
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  }

  /** Registers the page and sends it the report now: the watch is also the first fetch. */
  async watch(ws: ServerWebSocket<MyClawAppSessionData>, owner: string, threadId: string): Promise<void> {
    this.pages.set(ws, { owner, threadId, sessionId: this.deps.sessionOf(owner, threadId) });
    const status = await this.deps.report(owner, threadId);
    // The page may have closed, or moved to another thread, while the report was being built.
    if (status && this.pages.get(ws)?.threadId === threadId) this.deps.send(ws, { type: "status.result", threadId, status });
  }

  unwatch(ws: ServerWebSocket<MyClawAppSessionData>): void {
    this.pages.delete(ws);
  }

  /** Something in `sessionId`'s report moved; `payer` is who it was billed to, when known. */
  async changed(sessionId: string, payer?: string): Promise<void> {
    if (this.pages.size === 0) return;
    const chain = [sessionId];
    if (payer && payer !== sessionId) chain.push(payer);
    for (let i = 0; i < MAX_ANCESTORS; i++) {
      const parent = await this.deps.parentOf(chain[chain.length - 1]!);
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
    }
    for (const page of this.pages.values()) {
      if (chain.includes(page.sessionId)) this.schedule(page);
    }
  }

  /** For tests: pages registered right now. */
  size(): number {
    return this.pages.size;
  }

  private schedule(page: Page): void {
    const key = `${page.owner}\u0000${page.threadId}`;
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.push(page.owner, page.threadId);
      }, this.settleMs),
    );
  }

  private async push(owner: string, threadId: string): Promise<void> {
    const targets = [...this.pages].filter(([, page]) => page.owner === owner && page.threadId === threadId);
    if (targets.length === 0) return;
    const status = await this.deps.report(owner, threadId);
    if (!status) return;
    for (const [ws, page] of targets) {
      if (this.pages.get(ws) === page) this.deps.send(ws, { type: "status.result", threadId, status });
    }
  }
}
