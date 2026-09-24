import { BrowserWindows, type WindowsBackend } from "../../src/tools/browser/windows.ts";

/**
 * A browser with one window holding one tab, for the tests of tools that act on a page: the window
 * machinery itself is tested in tests/tools/browser-windows.test.ts. `call()` builds the arguments
 * a run would send, naming that window.
 */
export function oneTab(pageId = "p1"): { pages: BrowserWindows; call: (args?: Record<string, unknown>) => Record<string, unknown> } {
  const backend: WindowsBackend = {
    listWindows: async () => [{ windowId: 1, tabs: [{ pageId, url: "https://example.com", title: "" }] }],
    createWindow: async (url) => ({ windowId: 2, pageId: "w2", url, snapshot: { raw: "", refs: [] } }),
    closeWindow: async () => {},
    closeTab: async () => {},
    focusTab: async () => {},
  };
  return {
    pages: new BrowserWindows(backend),
    call: (args = {}) => ({ window: 1, __sessionId: "run", ...args }),
  };
}
