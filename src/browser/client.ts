import type {
  BrowserActionInfo,
  BrowserAttachment,
  BrowserResult,
  BrowserSnapshot,
  BrowserTabInfo,
} from "./types.ts";

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

  /** Navigates the given tab (reusePageId) in place unless newTab is set, so a
   *  task can stay in one tab instead of opening a new one per navigation. */
  async navigate(url: string, opts?: { reusePageId?: string; newTab?: boolean }): Promise<BrowserResult> {
    const sessionId = await this.ensureSession();
    return this.call<BrowserResult>("navigate", {
      sessionId,
      url,
      reusePageId: opts?.reusePageId,
      newTab: opts?.newTab,
    });
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

  /** ref is optional on purpose: a file input is usually hidden and therefore has no ref,
   *  so the sidecar locates it in the page itself. */
  async uploadFile(pageId: string, paths: string[], ref?: number): Promise<BrowserActionInfo> {
    return this.call<BrowserActionInfo>("upload", { pageId, paths, ref });
  }

  async selectOption(pageId: string, ref: number, value: string): Promise<BrowserActionInfo> {
    return this.call<BrowserActionInfo>("select-option", { pageId, ref, value });
  }

  async pressKey(pageId: string, key: string, ref?: number): Promise<void> {
    await this.call("press-key", { pageId, key, ref });
  }

  async scroll(pageId: string, direction: string, amount?: number, ref?: number): Promise<void> {
    await this.call("scroll", { pageId, direction, amount, ref });
  }

  async screenshot(pageId: string, fullPage?: boolean): Promise<BrowserAttachment> {
    return this.call<BrowserAttachment>("screenshot", { pageId, fullPage });
  }

  async screenshotWithLabels(pageId: string, fullPage?: boolean): Promise<BrowserAttachment> {
    return this.call<BrowserAttachment>("screenshot", { pageId, fullPage, labels: true });
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
