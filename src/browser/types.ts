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
