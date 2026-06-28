import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

interface PageActivity {
  page: Page;
  lastActive: number;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private connectPromise: Promise<Browser> | null = null;
  private pages = new Map<string, PageActivity>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cdpUrl: string,
    private idleTimeoutMs = 300000,
  ) {}

  async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = (async () => {
      try {
        this.browser = await chromium.connectOverCDP(this.cdpUrl);
        this.browser.on("disconnected", () => {
          this.pages.clear();
          this.browser = null;
          this.stopSweep();
        });
        this.startSweep();
        return this.browser;
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  async newContext(viewport?: { width: number; height: number }): Promise<BrowserContext> {
    const browser = await this.connect();
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      const ctx = contexts[0]!;
      if (viewport) {
        const pages = ctx.pages();
        for (const page of pages) {
          await page.setViewportSize(viewport);
        }
      }
      return ctx;
    }
    return browser.newContext({ viewport });
  }

  trackPage(page: Page): void {
    const id = crypto.randomUUID();
    this.pages.set(id, { page, lastActive: Date.now() });
  }

  touchPage(page: Page): void {
    for (const [, activity] of this.pages) {
      if (activity.page === page) {
        activity.lastActive = Date.now();
        return;
      }
    }
    this.trackPage(page);
  }

  private startSweep(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, activity] of this.pages) {
        if (now - activity.lastActive > this.idleTimeoutMs) {
          activity.page.close().catch(() => undefined);
          this.pages.delete(id);
        }
      }
    }, 60000);
  }

  private stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /** Close every page we opened and drop the local CDP connection.
   *  NEVER calls browser.close(): with connectOverCDP that sends a server-side
   *  Browser.close and terminates the externally-managed Chromium that other
   *  tasks (and future runs) rely on. We only release our local handles; the
   *  websocket transport is closed by the runtime on process exit. */
  async disconnect(): Promise<void> {
    this.stopSweep();
    for (const [, activity] of this.pages) {
      activity.page.close().catch(() => undefined);
    }
    this.pages.clear();
    this.browser = null;
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }
}

/** Process-wide shared pools, keyed by CDP URL. The persistent Chromium is an
 *  external service; we connect once and reuse the connection across every
 *  browser task instead of reconnecting (and previously killing it) per task. */
const sharedPools = new Map<string, BrowserPool>();

export function getBrowserPool(cdpUrl: string, idleTimeoutMs?: number): BrowserPool {
  let pool = sharedPools.get(cdpUrl);
  if (!pool) {
    pool = new BrowserPool(cdpUrl, idleTimeoutMs);
    sharedPools.set(cdpUrl, pool);
  }
  return pool;
}
