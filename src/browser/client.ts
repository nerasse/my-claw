import type {
  BrowserActionInfo,
  BrowserCdpResult,
  BrowserClickAtResult,
  BrowserDownloadResult,
  BrowserEvalResult,
  BrowserFindResult,
  BrowserResponseBody,
  BrowserResponseList,
  BrowserResult,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserWaitResult,
} from "./types.ts";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

// Per-endpoint HTTP budgets. A single global timeout was either too short for the slow
// operations or so long that a wedged fast one hung the whole run. Each value sits just
// above what the sidecar itself allows, so the server-side error wins the race and the
// agent gets a real message instead of an opaque abort.
const DEFAULT_TIMEOUTS_MS: Record<string, number> = {
  default: 30000,
  navigate: 45000,
  screenshot: 45000,
  upload: 60000,
  "select-option": 45000,
  "wait-for": 35000,
  "download-wait": 125000,
  pdf: 60000,
};

/** HTTP client for the Node browser sidecar. All Playwright work happens in the
 *  sidecar process (connectOverCDP hangs under Bun); here we only exchange JSON
 *  and reference pages by opaque string ids. One client instance == one sidecar
 *  session; cleanup() closes only the pages this session opened. */
export class BrowserClient {
  private sessionId: string | null = null;

  constructor(
    private sidecarUrl: string,
    private viewport = DEFAULT_VIEWPORT,
    private timeoutsMs: Record<string, number> = {},
  ) {}

  private timeoutFor(path: string): number {
    return (
      this.timeoutsMs[path] ??
      DEFAULT_TIMEOUTS_MS[path] ??
      this.timeoutsMs["default"] ??
      DEFAULT_TIMEOUTS_MS["default"] ??
      30000
    );
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.sidecarUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutFor(path)),
      });
    } catch (e) {
      // A blown budget and a dead sidecar are different failures and lead to different fixes,
      // but both land here: fetch rejects an AbortSignal.timeout the same way it rejects a
      // refused connection. Reporting every one of them as ECONNREFUSED told an agent the
      // browser had crashed whenever a slow call ran long, and it then reported that crash to
      // the owner as fact.
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new Error(
          `Browser ${path} exceeded its ${this.timeoutFor(path)}ms budget. The sidecar is still up: split the work or raise the budget.`,
        );
      }
      throw new Error(`Browser sidecar unreachable at ${this.sidecarUrl}: ${String(e)}`);
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

  async find(pageId: string, query: string): Promise<BrowserFindResult> {
    return this.call<BrowserFindResult>("find", { pageId, query });
  }

  async responses(pageId: string, filter?: string): Promise<BrowserResponseList> {
    return this.call<BrowserResponseList>("responses", { pageId, filter });
  }

  async responseBody(pageId: string, responseId: number): Promise<BrowserResponseBody> {
    return this.call<BrowserResponseBody>("responseBody", { pageId, responseId });
  }

  async click(pageId: string, ref: number): Promise<void> {
    await this.call("click", { pageId, ref });
  }

  async type(pageId: string, ref: number, text: string): Promise<void> {
    await this.call("type", { pageId, ref, text });
  }

  async hover(pageId: string, ref: number): Promise<void> {
    await this.call("hover", { pageId, ref });
  }

  async drag(pageId: string, fromRef: number, toRef: number): Promise<void> {
    await this.call("drag", { pageId, fromRef, toRef });
  }

  /** x and y are fractions of the viewport, not pixels — see the sidecar handler. */
  async clickAt(pageId: string, x: number, y: number): Promise<BrowserClickAtResult> {
    return this.call<BrowserClickAtResult>("click-at", { pageId, x, y });
  }

  async waitFor(
    pageId: string,
    opts: { text?: string; ref?: number; timeoutMs?: number },
  ): Promise<BrowserWaitResult> {
    return this.call<BrowserWaitResult>("wait-for", { pageId, ...opts });
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

  async screenshot(pageId: string, fullPage?: boolean): Promise<BrowserScreenshot> {
    return this.call<BrowserScreenshot>("screenshot", { pageId, fullPage });
  }

  async screenshotWithLabels(pageId: string, fullPage?: boolean): Promise<BrowserScreenshot> {
    return this.call<BrowserScreenshot>("screenshot", { pageId, fullPage, labels: true });
  }

  async evaluate(pageId: string, js: string): Promise<BrowserEvalResult> {
    return this.call<BrowserEvalResult>("evaluate", { pageId, js });
  }

  async cdp(pageId: string, method: string, params?: Record<string, unknown>): Promise<BrowserCdpResult> {
    return this.call<BrowserCdpResult>("cdp", { pageId, method, params });
  }

  async handleDialog(pageId: string, accept: boolean, promptText?: string): Promise<void> {
    await this.call("handle-dialog", { pageId, accept, promptText });
  }

  async waitForDownload(pageId: string, dir: string, timeoutMs?: number): Promise<BrowserDownloadResult> {
    return this.call<BrowserDownloadResult>("download-wait", { pageId, dir, timeoutMs });
  }

  async pdf(pageId: string, path: string): Promise<{ path: string }> {
    return this.call<{ path: string }>("pdf", { pageId, path });
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
