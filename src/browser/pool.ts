import { chromium, type Browser, type BrowserContext } from "playwright-core";

export class BrowserPool {
  private browser: Browser | null = null;
  private connecting = false;

  constructor(private cdpUrl: string) {}

  async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (this.connecting) {
      throw new Error("Browser connection already in progress");
    }
    this.connecting = true;
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
      return this.browser;
    } finally {
      this.connecting = false;
    }
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

  async disconnect(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }
}
