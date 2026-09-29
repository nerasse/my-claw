import type {
  BrowserActionInfo,
  BrowserCdpResult,
  BrowserClickAtResult,
  BrowserDownloadResult,
  BrowserEvalResult,
  BrowserFetchResult,
  BrowserFindResult,
  BrowserGo,
  BrowserInput,
  BrowserResponseBody,
  BrowserResponseList,
  BrowserResult,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserTextResult,
  BrowserWaitResult,
  BrowserWindowView,
} from "./types.ts";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

// Per-endpoint HTTP budgets. A single global timeout was either too short for the slow
// operations or so long that a wedged fast one hung the whole run. Each value sits just
// above what the sidecar itself allows, so the server-side error wins the race and the
// agent gets a real message instead of an opaque abort.
const DEFAULT_TIMEOUTS_MS: Record<string, number> = {
  default: 30000,
  navigate: 45000,
  "create-window": 45000,
  reload: 45000,
  screenshot: 45000,
  upload: 60000,
  "select-option": 45000,
  "wait-for": 35000,
  "download-wait": 125000,
  pdf: 60000,
  // The probe waits up to 3 s for a page by design: it must never inherit a shorter default.
  probe: 10000,
  // Every tab probed in parallel, each for up to 3 s.
  frozen: 10000,
  "close-target": 10000,
  // The owner's own clicks and keys: a long wait here is a hand that feels nothing.
  input: 10000,
  stage: 15000,
  go: 45000,
};

/** A tab whose page no longer answers, as the sidecar found it. */
interface FrozenTab {
  pageId: string;
  url: string;
}

/** A failed sidecar call, with what the recovery needs to know about it. */
class SidecarCallError extends Error {
  constructor(
    message: string,
    /** The call ran out of time: on a slow page, or on a frozen one. */
    readonly stalled: boolean,
    /** Tabs the sidecar found frozen while it could not reach the browser. */
    readonly frozen: FrozenTab[] = [],
  ) {
    super(message);
  }
}

// Playwright's own wording when a page operation runs out of time inside the sidecar.
const PAGE_TIMEOUT = /Timeout \d+ms exceeded/;

/** HTTP client for the Node browser sidecar. All Playwright work happens in the
 *  sidecar process (connectOverCDP hangs under Bun); here we only exchange JSON and name
 *  pages by their CDP target id and windows by their CDP window id. It holds no state: which
 *  run works where is the server's (src/tools/browser/windows.ts), so one client serves every
 *  run at once. */
export class BrowserClient {
  constructor(
    private sidecarUrl: string,
    private viewport = DEFAULT_VIEWPORT,
    private timeoutsMs: Record<string, number> = {},
  ) {}

  private keptForHuman: (pageId: string) => boolean = () => false;

  /**
   * Which tabs must stay open even frozen: the ones a human was handed. The client closes the
   * others on its own when they stop the browser, and only the windows know which is which.
   */
  keepOpenWhen(predicate: (pageId: string) => boolean): void {
    this.keptForHuman = predicate;
  }

  /**
   * Points the client at the sidecar the live config names. The browser tools hold one client for
   * the life of the process, so this is how a hot-reloaded `browser.sidecarUrl`, viewport or
   * timeout reaches the runs: applied to the next call, whichever run makes it.
   */
  reconfigure(sidecarUrl: string, viewport = DEFAULT_VIEWPORT, timeoutsMs: Record<string, number> = {}): void {
    this.sidecarUrl = sidecarUrl;
    this.viewport = viewport;
    this.timeoutsMs = timeoutsMs;
  }

  /** A call that asks the sidecar to wait (`wait_for`, a download) gets that wait, and a margin for the answer. */
  private budgetFor(path: string, body: Record<string, unknown>): number {
    const asked = typeof body["timeoutMs"] === "number" ? body["timeoutMs"] + 5000 : 0;
    return Math.max(this.timeoutFor(path), asked);
  }

  private timeoutFor(path: string): number {
    return (
      this.timeoutsMs[path] ??
      DEFAULT_TIMEOUTS_MS[path] ??
      this.timeoutsMs["default"] ??
      DEFAULT_TIMEOUTS_MS["default"] ??
      30000
    );
  }

  /**
   * One sidecar call, and the one recovery a stuck browser needs: a tab stuck in its own JavaScript
   * answers nothing, and whatever waited on it waited for every run (2026-09-26, 80 timeouts of the
   * window listing over forty minutes). Such a tab is closed, unless a human is working in it, and
   * the run is told; a page that is only slow is left alone and said to be slow.
   */
  private async call<T>(path: string, body: Record<string, unknown>, retried = false): Promise<T> {
    try {
      return await this.send<T>(path, body);
    } catch (e) {
      if (!(e instanceof SidecarCallError)) throw e;
      if (e.frozen.length > 0) {
        const kept = e.frozen.filter((t) => this.keptForHuman(t.pageId));
        await Promise.all(e.frozen.filter((t) => !kept.includes(t)).map((t) => this.closeFrozen(t.pageId)));
        if (kept.length === 0 && !retried) return this.call<T>(path, body, true);
        if (kept.length > 0) {
          throw new Error(
            `The browser is held up by a frozen tab a human was handed (${kept.map((t) => t.url).join(", ")}): it is left open for them, and closed once their hold ends. Try again later.`,
          );
        }
        throw new Error(e.message);
      }
      const pageId = typeof body["pageId"] === "string" ? body["pageId"] : undefined;
      if (e.stalled && pageId) throw await this.explainStall(path, body, pageId, e);
      throw new Error(e.message);
    }
  }

  private async explainStall(path: string, body: Record<string, unknown>, pageId: string, e: SidecarCallError): Promise<Error> {
    const probe = await this.send<{ open: boolean; responsive: boolean; url?: string }>("probe", { pageId }).catch(() => undefined);
    if (!probe?.open) return new Error(e.message);
    if (probe.responsive) {
      // Playwright's own timeout on a live page says what it waited for; ours says only how long.
      if (PAGE_TIMEOUT.test(e.message)) return new Error(e.message);
      return new Error(
        `Browser ${path} took longer than ${this.budgetFor(path, body)}ms, but the page still responds: it is slow, not stuck. Retry, or wait for something specific with browser_wait_for.`,
      );
    }
    const url = probe.url ?? "";
    if (this.keptForHuman(pageId)) {
      return new Error(
        `The tab stopped responding: its page is frozen (${url}). It is left open, because a human was handed its window: work in another window.`,
      );
    }
    await this.closeFrozen(pageId);
    return new Error(
      `The tab stopped responding: its page is frozen, and it was closed so it cannot hold up the browser. Open ${url} again in a new tab (browser_navigate with new_tab) if you still need it.`,
    );
  }

  /**
   * Probes every tab and closes the frozen ones, unless a human was handed their window. Asked
   * while no run works: a frozen tab found this way holds nobody up, instead of the next run.
   */
  async closeFrozenTabs(): Promise<number> {
    const { frozen } = await this.send<{ frozen: FrozenTab[] }>("frozen", {});
    const closeable = frozen.filter((t) => !this.keptForHuman(t.pageId));
    await Promise.all(closeable.map((t) => this.closeFrozen(t.pageId)));
    return closeable.length;
  }

  private async closeFrozen(pageId: string): Promise<void> {
    await this.send("close-target", { pageId }).catch(() => undefined);
  }

  private async send<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.sidecarUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.budgetFor(path, body)),
      });
    } catch (e) {
      // A blown budget and a dead sidecar are different failures and lead to different fixes,
      // but both land here: fetch rejects an AbortSignal.timeout the same way it rejects a
      // refused connection. Reporting every one of them as ECONNREFUSED told an agent the
      // browser had crashed whenever a slow call ran long, and it then reported that crash to
      // the owner as fact.
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new SidecarCallError(`Browser ${path} exceeded its ${this.budgetFor(path, body)}ms budget. The sidecar is still up.`, true);
      }
      throw new Error(`Browser sidecar unreachable at ${this.sidecarUrl}: ${String(e)}`);
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let frozen: FrozenTab[] = [];
      try {
        const data = (await res.json()) as { error?: string; frozen?: FrozenTab[] };
        if (data.error) message = data.error;
        if (Array.isArray(data.frozen)) frozen = data.frozen;
      } catch {
        // keep status-based message
      }
      throw new SidecarCallError(message, PAGE_TIMEOUT.test(message), frozen);
    }
    return (await res.json()) as T;
  }

  /** Navigates the given tab in place unless newTab is set, in which case the tab opens in the
   *  given window: a task stays in one tab instead of opening a new one per navigation. */
  async navigate(url: string, opts?: { pageId?: string; windowId?: number; newTab?: boolean }): Promise<BrowserResult> {
    return this.call<BrowserResult>("navigate", {
      url,
      pageId: opts?.pageId,
      windowId: opts?.windowId,
      newTab: opts?.newTab,
    });
  }

  async listWindows(): Promise<BrowserWindowView[]> {
    const { windows } = await this.call<{ windows: BrowserWindowView[] }>("list-windows", {});
    return windows;
  }

  /** A new window, off the VNC screen unless `onStage` (the owner's own) or the screen is empty. */
  async createWindow(url: string, opts: { onStage?: boolean } = {}): Promise<BrowserResult & { windowId: number }> {
    return this.call<BrowserResult & { windowId: number }>("create-window", {
      url,
      viewport: this.viewport,
      ...(opts.onStage ? { onStage: true } : {}),
    });
  }

  /** Puts a window on the VNC screen, and every other one off it. */
  async stage(windowId: number): Promise<void> {
    await this.call("stage", { windowId });
  }

  async input(pageId: string, action: BrowserInput): Promise<void> {
    await this.call("input", { pageId, ...action });
  }

  async go(pageId: string, nav: BrowserGo): Promise<{ url: string }> {
    return this.call<{ url: string }>("go", { pageId, ...nav });
  }

  async closeWindow(windowId: number): Promise<void> {
    await this.call("close-window", { windowId });
  }

  async snapshot(pageId: string): Promise<BrowserSnapshot> {
    return this.call<BrowserSnapshot>("snapshot", { pageId });
  }

  async reload(pageId: string): Promise<{ snapshot: BrowserSnapshot; url: string }> {
    return this.call<{ snapshot: BrowserSnapshot; url: string }>("reload", { pageId });
  }

  /** Runs in the page's context: the session's cookies ride along and the site's own
   *  same-origin rules apply. `browser_network`/`browser_response` only re-read. */
  async fetchInPage(
    pageId: string,
    opts: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<BrowserFetchResult> {
    return this.call<BrowserFetchResult>("fetch", { pageId, ...opts });
  }

  async text(pageId: string): Promise<BrowserTextResult> {
    return this.call<BrowserTextResult>("text", { pageId });
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

  /** Every tab, flat, for the app's Browser page. Agents go through the windows. */
  async listTabs(): Promise<BrowserTabInfo[]> {
    const { tabs } = await this.call<{ tabs: BrowserTabInfo[] }>("tabs", {});
    return tabs;
  }

  async focusTab(pageId: string): Promise<void> {
    await this.call("focus-tab", { pageId });
  }

  async closeTab(pageId: string): Promise<void> {
    await this.call("close-tab", { pageId });
  }
}
