import { test, describe } from "bun:test";
import assert from "node:assert";
import {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserListTabsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
  setCurrentPageId,
} from "../../src/tools/browser.ts";
import type { BrowserClient } from "../../src/browser/client.ts";
import { createMock } from "../helpers/mock.ts";

function createMockClient(): BrowserClient {
  const snapshot = { raw: 'button "OK" [__ref="5"]', refs: [5] };
  return {
    navigate: createMock(() => Promise.resolve({ pageId: "p1", snapshot, url: "https://example.com" })),
    snapshot: createMock(() => Promise.resolve(snapshot)),
    click: createMock(() => Promise.resolve()),
    type: createMock(() => Promise.resolve()),
    screenshot: createMock(() => Promise.resolve({ type: "image", path: "/tmp/test.png", mimeType: "image/png" })),
    screenshotWithLabels: createMock(() => Promise.resolve({ type: "image", path: "/tmp/test.png", mimeType: "image/png" })),
    listTabs: createMock(() => Promise.resolve([{ id: "0", url: "https://example.com", title: "" }])),
    focusTab: createMock(() => Promise.resolve("p1")),
    closeTab: createMock(() => Promise.resolve()),
    cleanup: createMock(() => Promise.resolve()),
  } as unknown as BrowserClient;
}

describe("browser tools", () => {
  test("navigate rejects localhost", async () => {
    const tool = createBrowserNavigateTool(createMockClient());
    const result = await tool.execute({ url: "http://localhost:8080" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("blocked"));
  });

  test("navigate rejects file protocol", async () => {
    const tool = createBrowserNavigateTool(createMockClient());
    const result = await tool.execute({ url: "file:///etc/passwd" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("blocked"));
  });

  test("navigate succeeds with valid url and sets the current page", async () => {
    const tool = createBrowserNavigateTool(createMockClient());
    const result = await tool.execute({ url: "https://example.com" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("OK"));
  });

  test("snapshot requires active page", async () => {
    setCurrentPageId(null);
    const tool = createBrowserSnapshotTool(createMockClient());
    const result = await tool.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("click requires active page", async () => {
    setCurrentPageId(null);
    const tool = createBrowserClickTool(createMockClient());
    const result = await tool.execute({ ref: 5 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("type requires active page", async () => {
    setCurrentPageId(null);
    const tool = createBrowserTypeTool(createMockClient());
    const result = await tool.execute({ ref: 3, text: "hello" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("click uses the current page id", async () => {
    const client = createMockClient();
    setCurrentPageId("p7");
    const tool = createBrowserClickTool(client);
    const result = await tool.execute({ ref: 5 });
    assert.strictEqual(result.success, true);
    assert.strictEqual((client.click as unknown as { calls: { arguments: unknown[] }[] }).calls[0]?.arguments[0], "p7");
  });

  test("screenshot returns attachment", async () => {
    setCurrentPageId("p1");
    const tool = createBrowserScreenshotTool(createMockClient());
    const result = await tool.execute({ full_page: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.attachments);
    assert.strictEqual(result.attachments![0]!.type, "image");
  });

  test("list_tabs returns tab list", async () => {
    const tool = createBrowserListTabsTool(createMockClient());
    const result = await tool.execute({});
    assert.strictEqual(result.success, true);
  });

  test("focus_tab switches to tab", async () => {
    const tool = createBrowserFocusTabTool(createMockClient());
    setCurrentPageId("p0");
    const result = await tool.execute({ index: 0 });
    assert.strictEqual(result.success, true);
  });

  test("close_tab closes tab", async () => {
    const tool = createBrowserCloseTabTool(createMockClient());
    const result = await tool.execute({ index: 0 });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("closed"));
  });
});
