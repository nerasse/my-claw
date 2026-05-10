import type { Page, Browser, BrowserContext } from "playwright-core";

export interface BrowserSnapshot {
  raw: string;
  refs: number[];
}

export interface BrowserResult {
  page: Page;
  snapshot: BrowserSnapshot;
  url: string;
}

export interface BrowserAttachment {
  type: "image";
  path: string;
  mimeType: string;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
}
