import { test, describe } from "node:test";
import assert from "node:assert";
import {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  setCurrentPage,
} from "../../src/tools/browser.ts";
import { BrowserService } from "../../src/browser/service.ts";
import { createMock } from "../helpers/mock.ts";
import type { Page } from "playwright-core";

function createMockService(): BrowserService {
  const mockSnapshot = createMock(() => Promise.resolve({ raw: 'button "OK" [__ref="5"]', refs: [5] }));
  const mockPage = {
    goto: createMock(() => Promise.resolve()),
    url: createMock(() => "https://example.com"),
    locator: createMock(() => ({
      click: createMock(() => Promise.resolve()),
      fill: createMock(() => Promise.resolve()),
      ariaSnapshot: createMock(() => Promise.resolve('button "OK" [__ref="5"]')),
    })),
    screenshot: createMock(() => Promise.resolve()),
    close: createMock(() => Promise.resolve()),
    evaluate: createMock(() => Promise.resolve()),
    goBack: createMock(() => Promise.resolve()),
    setViewportSize: createMock(() => Promise.resolve()),
  };

  const mockContext = {
    newPage: createMock(() => Promise.resolve(mockPage)),
    pages: createMock(() => [mockPage]),
  };

  const mockPool = {
    newContext: createMock(() => Promise.resolve(mockContext)),
    connect: createMock(() => Promise.resolve()),
    disconnect: createMock(() => Promise.resolve()),
    isConnected: () => true,
  } as unknown as import("../../src/browser/pool.ts").BrowserPool;

  const service = new BrowserService(mockPool);
  service.snapshot = mockSnapshot;
  service.navigate = createMock(() => Promise.resolve({
    page: mockPage as unknown as Page,
    snapshot: { raw: 'button "OK" [__ref="5"]', refs: [5] },
    url: "https://example.com",
  }));
  service.click = createMock(() => Promise.resolve());
  service.type = createMock(() => Promise.resolve());
  service.screenshot = createMock(() => Promise.resolve({ type: "image", path: "/tmp/test.png", mimeType: "image/png" }));

  return service;
}

describe("browser tools", () => {
  test("navigate rejects localhost", async () => {
    const tool = createBrowserNavigateTool(createMockService());
    const result = await tool.execute({ url: "http://localhost:8080" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("blocked"));
  });

  test("navigate rejects file protocol", async () => {
    const tool = createBrowserNavigateTool(createMockService());
    const result = await tool.execute({ url: "file:///etc/passwd" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("blocked"));
  });

  test("navigate succeeds with valid url", async () => {
    const service = createMockService();
    const tool = createBrowserNavigateTool(service);
    const result = await tool.execute({ url: "https://example.com" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("OK"));
  });

  test("snapshot requires active page", async () => {
    setCurrentPage(null);
    const tool = createBrowserSnapshotTool(createMockService());
    const result = await tool.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("click requires active page", async () => {
    setCurrentPage(null);
    const tool = createBrowserClickTool(createMockService());
    const result = await tool.execute({ ref: 5 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("type requires active page", async () => {
    setCurrentPage(null);
    const tool = createBrowserTypeTool(createMockService());
    const result = await tool.execute({ ref: 3, text: "hello" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("screenshot returns attachment", async () => {
    const mockPage = { url: () => "" } as unknown as Page;
    setCurrentPage(mockPage);
    const tool = createBrowserScreenshotTool(createMockService());
    const result = await tool.execute({ full_page: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.attachments);
    assert.strictEqual(result.attachments![0].type, "image");
  });
});
