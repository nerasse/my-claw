import type { Page, BrowserContext } from "playwright-core";
import { BrowserPool } from "./pool.ts";
import { injectRefLabels, removeRefLabels } from "./labels.ts";
import type { BrowserAttachment, BrowserResult, BrowserSnapshot, BrowserTabInfo } from "./types.ts";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const SCREENSHOT_DIR = "/tmp";
const SCROLL_AMOUNT = 500;

export class BrowserService {
  private context: BrowserContext | null = null;
  private ownPages: Page[] = [];

  constructor(private pool: BrowserPool, private viewport = DEFAULT_VIEWPORT) {}

  async navigate(url: string): Promise<BrowserResult> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.ownPages.push(page);
    this.pool.trackPage(page);
    this.attachDialogHandler(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const snapshot = await this.snapshot(page);
    return { page, snapshot, url: page.url() };
  }

  private attachDialogHandler(page: Page): void {
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });
  }

  async snapshot(page: Page): Promise<BrowserSnapshot> {
    // @ts-expect-error ariaSnapshot is available in recent Playwright but missing from typedefs
    const raw = await page.locator("body").ariaSnapshot({ ref: true });
    const refs = extractRefs(raw);
    return { raw, refs };
  }

  async click(page: Page, ref: number): Promise<void> {
    this.pool.touchPage(page);
    const locator = page.locator(`[__ref="${ref}"]`);
    await locator.click();
  }

  async type(page: Page, ref: number, text: string): Promise<void> {
    this.pool.touchPage(page);
    const locator = page.locator(`[__ref="${ref}"]`);
    await locator.fill(text);
  }

  async screenshot(page: Page, fullPage?: boolean): Promise<BrowserAttachment> {
    this.pool.touchPage(page);
    const path = `${SCREENSHOT_DIR}/browser-${crypto.randomUUID()}.png`;
    await page.screenshot({ path, fullPage });
    return { type: "image", path, mimeType: "image/png" };
  }

  async screenshotWithLabels(page: Page, fullPage?: boolean): Promise<BrowserAttachment> {
    this.pool.touchPage(page);
    const path = `${SCREENSHOT_DIR}/browser-${crypto.randomUUID()}.png`;
    await injectRefLabels(page);
    await page.screenshot({ path, fullPage });
    await removeRefLabels(page);
    return { type: "image", path, mimeType: "image/png" };
  }

  async scroll(page: Page, direction: "up" | "down"): Promise<void> {
    this.pool.touchPage(page);
    const amount = direction === "up" ? -SCROLL_AMOUNT : SCROLL_AMOUNT;
    await page.evaluate(`window.scrollBy(0, ${amount})`);
  }

  async back(page: Page): Promise<void> {
    this.pool.touchPage(page);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    const context = await this.ensureContext();
    const pages = context.pages();
    return pages.map((p, i) => ({
      id: String(i),
      url: p.url(),
      title: "",
    }));
  }

  async focusTab(index: number): Promise<Page> {
    const context = await this.ensureContext();
    const pages = context.pages();
    const page = pages[index];
    if (!page) {
      throw new Error(`Tab ${index} not found.`);
    }
    await page.bringToFront();
    return page;
  }

  async closeTab(index: number): Promise<void> {
    const context = await this.ensureContext();
    const pages = context.pages();
    const page = pages[index];
    if (!page) {
      throw new Error(`Tab ${index} not found.`);
    }
    await page.close();
  }

  async closeAllTabsExceptCurrent(page: Page): Promise<void> {
    const context = await this.ensureContext();
    const pages = context.pages();
    for (const p of pages) {
      if (p !== page) {
        await p.close().catch(() => undefined);
      }
    }
  }

  async closePage(page: Page): Promise<void> {
    await page.close();
  }

  async closeAllPages(): Promise<void> {
    if (!this.context) return;
    const pages = this.context.pages();
    for (const p of pages) {
      await p.close().catch(() => undefined);
    }
  }

  /** Close only the tabs this task opened. Does NOT disconnect the shared pool
   *  (that connection is reused across tasks) and does NOT delete screenshots:
   *  those are returned as attachments and removed post-send by the adapter. */
  async cleanup(): Promise<void> {
    for (const page of this.ownPages) {
      await page.close().catch(() => undefined);
    }
    this.ownPages = [];
    this.context = null;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (!this.context) {
      this.context = await this.pool.newContext(this.viewport);
    }
    return this.context;
  }
}

export function extractRefs(snapshot: string): number[] {
  const refs: number[] = [];
  const regex = /\[__ref="(\d+)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(snapshot)) !== null) {
    refs.push(Number(match[1]));
  }
  return [...new Set(refs)].sort((a, b) => a - b);
}
