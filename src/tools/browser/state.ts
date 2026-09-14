import type { BrowserSnapshot } from "../../browser/types.ts";

// Tracks the current page id across tool calls of ONE subagent run. This used to be a
// module-level global: concurrent browser subagents clobbered each other's page id and
// ended up clicking/snapshotting each other's tabs. Each subagent now owns its state.
export interface BrowserPageState {
  currentPageId: string | null;
}

export function createBrowserPageState(): BrowserPageState {
  return { currentPageId: null };
}

export function getPageId(state: BrowserPageState): string {
  if (!state.currentPageId) {
    throw new Error("No active browser page. Call browser_navigate first.");
  }
  return state.currentPageId;
}

export async function guardUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol === "file:") {
    throw new Error("file:// is not a page: the browser tool navigates the web.");
  }
}

export function formatSnapshot(snapshot: BrowserSnapshot): string {
  const header = snapshot.refs.length > 0 ? `Interactive refs: ${snapshot.refs.join(", ")}\n\n` : "";
  return header + snapshot.raw;
}

/**
 * The workspace of the run calling the tool, injected by the agent loop under `__workspaceDir`;
 * the registration-time default otherwise. The browser tools are registered once for the process
 * and run for whichever conversation delegated the task, so the directory an upload is read from
 * or a download lands in is the caller's, not the one the tools were built with.
 */
export function workspaceOf(args: Record<string, unknown>, fallback?: string): string | undefined {
  return typeof args["__workspaceDir"] === "string" ? args["__workspaceDir"] : fallback;
}
