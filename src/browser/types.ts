export interface BrowserSnapshot {
  raw: string;
  refs: number[];
}

export interface BrowserResult {
  pageId: string;
  snapshot: BrowserSnapshot;
  url: string;
  /** The address was itself a download: Chromium handed it to the download manager instead of
   *  rendering it. The tab still holds the previous page; browser_download saves the file. */
  downloaded?: boolean;
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

/** A tab of a window. `openerPageId` is the page whose click opened it, if any. */
export interface BrowserTabView {
  pageId: string;
  url: string;
  title: string;
  openerPageId?: string;
  /** The tab its window shows (the one that came forward last). */
  active?: boolean;
}

export interface BrowserWindowView {
  windowId: number;
  /** The window on the VNC screen: one at a time, the others parked off it (docs/browser-live.md). */
  onStage?: boolean;
  tabs: BrowserTabView[];
}

/** The owner's hand on a page, placed as a fraction (0..1) of the live picture they saw. */
export type BrowserInput =
  | { kind: "tap"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { kind: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string; modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift"> };

export type BrowserGo = { action: "back" | "forward" | "reload" } | { action: "goto"; url: string };

/** How the sidecar actually performed an action. Surfaced to the agent because the path
 *  taken (native select vs keyboard fallback) tells it how much to trust the result. */
export interface BrowserActionInfo {
  via: string;
  fileInputs?: number;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

/** A screenshot carries the viewport so the agent can convert what it sees into the
 *  fractions browser_click_at expects, without assuming the image was not resized. */
export interface BrowserScreenshot extends BrowserAttachment {
  viewport?: BrowserViewport;
}

export interface BrowserClickAtResult {
  x: number;
  y: number;
  viewport: BrowserViewport;
}

export interface BrowserWaitResult {
  waited: string;
}

/** Low-level results come pre-serialized. Their length is the agent loop's to handle, like any
 *  tool output: past its ceiling the rest goes to a file the agent can read. */
export interface BrowserEvalResult {
  value: string;
}

/** A request issued by the page itself (cookies, same-origin rules), never by the tool. */
export interface BrowserFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface BrowserTextResult {
  text: string;
}

export interface BrowserCdpResult {
  result: string;
}

export interface BrowserDownloadResult {
  /** The record the sidecar kept, usable with browser_download to save it again elsewhere. */
  id?: number;
  path: string;
  filename: string;
  /** Bytes on disk, as the claim found them. */
  bytes?: number;
  /** Sniffed from the first bytes, never from the name: a PDF link answered with an HTML error
   *  page is the most common way an agent reports a file it does not have. */
  kind?: string;
  /** The URL Chromium actually downloaded from. */
  url?: string;
  /** The name the page asked for, before sanitising. */
  suggested?: string;
}

/** One file Chromium downloaded, as the sidecar holds it. `claimedInto` names where it went. */
export interface BrowserDownloadRecord {
  id: number;
  pageId: string;
  windowId?: number;
  suggested: string;
  url: string;
  state: "saving" | "ready" | "failed";
  error?: string;
  bytes?: number;
  kind?: string;
  createdAt: number;
  claimedInto?: string;
}

export interface BrowserFindResult {
  query: string;
  matches: number;
  lines: string[];
  url: string;
}

export interface BrowserResponseInfo {
  id: number;
  url: string;
  status: number;
  type: string;
  method: string;
}

/** `total` counts everything recorded for the page, `responses` only what the filter kept: an
 *  agent that saw 3 of 90 must be able to tell that from a page with 3. */
export interface BrowserResponseList {
  total: number;
  responses: BrowserResponseInfo[];
}

export interface BrowserResponseBody {
  url: string;
  status: number;
  body: string;
}
