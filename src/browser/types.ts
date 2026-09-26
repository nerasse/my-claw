export interface BrowserSnapshot {
  raw: string;
  refs: number[];
}

export interface BrowserResult {
  pageId: string;
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

/** A tab of a window. `openerPageId` is the page whose click opened it, if any. */
export interface BrowserTabView {
  pageId: string;
  url: string;
  title: string;
  openerPageId?: string;
}

export interface BrowserWindowView {
  windowId: number;
  tabs: BrowserTabView[];
}

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
  path: string;
  filename: string;
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
