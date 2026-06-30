import type { BrowserAttachment, BrowserResult, BrowserSnapshot, BrowserTabInfo } from "./types.ts";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const CALL_TIMEOUT_MS = 90000;

/** HTTP client for the Node browser sidecar. All Playwright work happens in the
 *  sidecar process (connectOverCDP hangs under Bun); here we only exchange JSON
 *  and reference pages by opaque string ids. One client instance == one sidecar
 *  session; cleanup() closes only the pages this session opened. */
export class BrowserClient {
  private sessionId: string | null = null;

  constructor(
    private sidecarUrl: string,
    private viewport = DEFAULT_VIEWPORT,
  ) {}

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.sidecarUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Browser sidecar unreachable at ${this.sidecarUrl} (ECONNREFUSED): ${String(e)}`);
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // keep status-based message
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) {
      const { sessionId } = await this.call<{ sessionId: string }>("session", { viewport: this.viewport });
      this.sessionId = sessionId;
    }
    return this.sessionId;
  }

  async navigate(url: string): Promise<BrowserResult> {
    const sessionId = await this.ensureSession();
    return this.call<BrowserResult>("navigate", { sessionId, url });
  }

  async snapshot(pageId: string): Promise<BrowserSnapshot> {
    return this.call<BrowserSnapshot>("snapshot", { pageId });
  }

  async click(pageId: string, ref: number): Promise<void> {
    await this.call("click", { pageId, ref });
  }

  async type(pageId: string, ref: number, text: string): Promise<void> {
    await this.call("type", { pageId, ref, text });
  }

  async screenshot(pageId: string, fullPage?: boolean): Promise<BrowserAttachment> {
    return this.call<BrowserAttachment>("screenshot", { pageId, fullPage });
  }

  async screenshotWithLabels(pageId: string, fullPage?: boolean): Promise<BrowserAttachment> {
    return this.call<BrowserAttachment>("screenshot", { pageId, fullPage, labels: true });
  }

  async scroll(pageId: string, direction: "up" | "down"): Promise<void> {
    await this.call("scroll", { pageId, direction });
  }

  async back(pageId: string): Promise<void> {
    await this.call("back", { pageId });
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    const sessionId = await this.ensureSession();
    const { tabs } = await this.call<{ tabs: BrowserTabInfo[] }>("tabs", { sessionId });
    return tabs;
  }

  async focusTab(index: number): Promise<string> {
    const sessionId = await this.ensureSession();
    const { pageId } = await this.call<{ pageId: string }>("focus-tab", { sessionId, index });
    return pageId;
  }

  async closeTab(index: number): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.call("close-tab", { sessionId, index });
  }

  async cleanup(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    await this.call("cleanup", { sessionId }).catch(() => undefined);
  }
}
