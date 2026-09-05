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

/** Low-level results are pre-serialized and truncated by the sidecar: page-controlled data
 *  must not be able to flood the agent's context. */
export interface BrowserEvalResult {
  value: string;
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

/** `total` counts everything recorded for the page, `responses` only what the filter kept and
 *  the cap allowed: an agent that saw 3 of 90 must be able to tell that from a page with 3. */
export interface BrowserResponseList {
  total: number;
  responses: BrowserResponseInfo[];
}

export interface BrowserResponseBody {
  url: string;
  status: number;
  truncated: boolean;
  body: string;
}
