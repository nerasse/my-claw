import type { BrowserSnapshot } from "../../browser/types.ts";
import { resolveAndCheckUrl } from "../fetch.ts";

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
    throw new Error("file:// protocol is blocked for security.");
  }
  if (await resolveAndCheckUrl(url)) {
    throw new Error(`Navigation to ${parsed.hostname} is blocked: private/internal network address.`);
  }
}

export function formatSnapshot(snapshot: BrowserSnapshot): string {
  const header = snapshot.refs.length > 0 ? `Interactive refs: ${snapshot.refs.join(", ")}\n\n` : "";
  return header + snapshot.raw;
}
