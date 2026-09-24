import type { BrowserSnapshot } from "../../browser/types.ts";

type ObjectSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * A browser tool's parameters, plus the window it acts in. Every action names one: that is how two
 * runs share one browser without ever sharing a tab -- docs/browser-windows.md.
 */
export function windowed(schema: ObjectSchema): ObjectSchema {
  return {
    type: "object",
    properties: {
      window: { type: "number", description: "The window to act in, as browser_list_windows numbers it" },
      ...schema.properties,
    },
    required: ["window", ...(schema.required ?? [])],
  };
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
