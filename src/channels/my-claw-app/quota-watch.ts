/**
 * The provider pages open right now, and the push that keeps them current.
 *
 * A page registers its socket with one provider; the module asks that provider's quota source on
 * the quota module's own schedule (which already refuses to read faster than each source allows)
 * and sends a frame only when the answer changed. The countdown is drawn by the app from the reset
 * timestamp, so a five-minute interval still looks alive between two reads.
 */
import type { ServerWebSocket } from "bun";
import type { QuotaOutcome } from "../../llm/quota/index.ts";
import type { MyClawAppSessionData } from "./controllers.ts";
import type { MyClawAppQuotaState } from "./types.ts";

export interface QuotaWatchDeps {
  /** One provider's answer, from the quota module's cache. */
  read(provider: string): Promise<QuotaOutcome>;
  send(ws: ServerWebSocket<MyClawAppSessionData>, frame: MyClawAppQuotaState): void;
  tickMs?: number;
}

interface Page {
  provider: string;
  /** The last answer sent for that provider, so an unchanged read is not a frame. */
  signature: string;
}

const DEFAULT_TICK_MS = 30_000;

export class QuotaWatch {
  private readonly pages = new Map<ServerWebSocket<MyClawAppSessionData>, Page>();
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: QuotaWatchDeps) {
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Registers the page and answers now: the watch is also the first read. */
  async watch(ws: ServerWebSocket<MyClawAppSessionData>, provider: string): Promise<void> {
    this.pages.set(ws, { provider, signature: "" });
    this.ensureTimer();
    const outcome = await this.deps.read(provider);
    // The page may have moved to another provider while the read was in flight.
    if (this.pages.get(ws)?.provider !== provider) return;
    this.pages.set(ws, { provider, signature: signatureOf(outcome) });
    this.deps.send(ws, { type: "quota.state", provider, outcome });
  }

  unwatch(ws: ServerWebSocket<MyClawAppSessionData>): void {
    this.pages.delete(ws);
    if (this.pages.size === 0) this.stop();
  }

  /** For tests: pages registered right now. */
  size(): number {
    return this.pages.size;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.pages.size === 0) return;
    this.ticking = true;
    try {
      for (const provider of new Set([...this.pages.values()].map((page) => page.provider))) {
        const outcome = await this.deps.read(provider);
        const signature = signatureOf(outcome);
        for (const [ws, page] of [...this.pages]) {
          if (page.provider !== provider || page.signature === signature) continue;
          this.pages.set(ws, { provider, signature });
          this.deps.send(ws, { type: "quota.state", provider, outcome });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

function signatureOf(outcome: QuotaOutcome): string {
  return JSON.stringify(outcome);
}
