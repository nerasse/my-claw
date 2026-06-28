import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert";
import { BrowserService, extractRefs } from "../../src/browser/service.ts";
import { BrowserPool } from "../../src/browser/pool.ts";
import { createMock } from "../helpers/mock.ts";

describe("BrowserService", () => {
  let service: BrowserService;
  let mockPool: BrowserPool;

  beforeEach(() => {
    const mockPage = {
      goto: createMock(() => Promise.resolve()),
      url: createMock(() => "https://example.com"),
      locator: createMock(() => ({
        ariaSnapshot: createMock(() => Promise.resolve('button "OK" [__ref="5"]')),
      })),
      screenshot: createMock(() => Promise.resolve()),
      close: createMock(() => Promise.resolve()),
      evaluate: createMock(() => Promise.resolve()),
      goBack: createMock(() => Promise.resolve()),
      setViewportSize: createMock(() => Promise.resolve()),
      on: createMock(() => undefined),
    };

    const mockContext = {
      newPage: createMock(() => Promise.resolve(mockPage)),
      pages: createMock(() => [mockPage]),
    };

    mockPool = {
      newContext: createMock(() => Promise.resolve(mockContext)),
      connect: createMock(() => Promise.resolve({
        isConnected: () => true,
        contexts: () => [],
        close: () => Promise.resolve(),
      })),
      disconnect: createMock(() => Promise.resolve()),
      isConnected: () => true,
      trackPage: createMock(() => undefined),
      touchPage: createMock(() => undefined),
    } as unknown as BrowserPool;

    service = new BrowserService(mockPool);
  });

  test("navigate creates page and returns snapshot", async () => {
    const result = await service.navigate("https://example.com");
    assert.strictEqual(result.url, "https://example.com");
    assert.ok(result.snapshot);
    assert.deepStrictEqual(result.snapshot.refs, [5]);
  });

  test("click resolves ref and clicks", async () => {
    const mockClick = createMock(() => Promise.resolve());
    const mockPage = {
      locator: createMock(() => ({ click: mockClick })),
    } as unknown as import("playwright-core").Page;

    await service.click(mockPage, 5);
    assert.strictEqual((mockPage.locator as any).calls[0].arguments[0], '[__ref="5"]');
    assert.strictEqual(mockClick.calls.length, 1);
  });

  test("type resolves ref and fills", async () => {
    const mockFill = createMock(() => Promise.resolve());
    const mockPage = {
      locator: createMock(() => ({ fill: mockFill })),
    } as unknown as import("playwright-core").Page;

    await service.type(mockPage, 3, "hello");
    assert.strictEqual((mockPage.locator as any).calls[0].arguments[0], '[__ref="3"]');
    assert.strictEqual(mockFill.calls[0].arguments[0], "hello");
  });

  test("screenshot returns attachment", async () => {
    const mockPage = {
      screenshot: createMock(() => Promise.resolve()),
    } as unknown as import("playwright-core").Page;

    const attachment = await service.screenshot(mockPage);
    assert.strictEqual(attachment.type, "image");
    assert.strictEqual(attachment.mimeType, "image/png");
    assert.ok(attachment.path.startsWith("/tmp/browser-"));
  });

  test("listTabs returns tab info", async () => {
    const tabs = await service.listTabs();
    assert.ok(Array.isArray(tabs));
  });

  test("focusTab switches page and returns it", async () => {
    const mockBringToFront = createMock(() => Promise.resolve());
    const mockPage = {
      bringToFront: mockBringToFront,
      url: createMock(() => "https://example.com"),
    } as unknown as import("playwright-core").Page;

    const mockContext = {
      pages: createMock(() => [mockPage]),
    };

    mockPool = {
      newContext: createMock(() => Promise.resolve(mockContext)),
      connect: createMock(() => Promise.resolve()),
      disconnect: createMock(() => Promise.resolve()),
      isConnected: () => true,
    } as unknown as BrowserPool;

    service = new BrowserService(mockPool);
    const page = await service.focusTab(0);
    assert.strictEqual(mockBringToFront.calls.length, 1);
    assert.strictEqual(page.url(), "https://example.com");
  });

  test("closeTab closes page by index", async () => {
    const mockClose = createMock(() => Promise.resolve());
    const mockPage = {
      close: mockClose,
    } as unknown as import("playwright-core").Page;

    const mockContext = {
      pages: createMock(() => [mockPage]),
    };

    mockPool = {
      newContext: createMock(() => Promise.resolve(mockContext)),
      connect: createMock(() => Promise.resolve()),
      disconnect: createMock(() => Promise.resolve()),
      isConnected: () => true,
    } as unknown as BrowserPool;

    service = new BrowserService(mockPool);
    await service.closeTab(0);
    assert.strictEqual(mockClose.calls.length, 1);
  });

  test("cleanup closes only the pages it opened and NEVER disconnects the shared pool", async () => {
    const closeMock = createMock(() => Promise.resolve());
    const ownPage = {
      goto: createMock(() => Promise.resolve()),
      url: createMock(() => "https://example.com"),
      locator: createMock(() => ({ ariaSnapshot: createMock(() => Promise.resolve('x [__ref="1"]')) })),
      close: closeMock,
      on: createMock(() => undefined),
    };
    const ctx = { newPage: createMock(() => Promise.resolve(ownPage)), pages: createMock(() => [ownPage]) };
    const disconnectMock = createMock(() => Promise.resolve());
    const pool = {
      newContext: createMock(() => Promise.resolve(ctx)),
      disconnect: disconnectMock,
      trackPage: createMock(() => undefined),
      touchPage: createMock(() => undefined),
      connect: createMock(() => Promise.resolve()),
      isConnected: () => true,
    } as unknown as BrowserPool;

    const svc = new BrowserService(pool);
    await svc.navigate("https://example.com");
    await svc.cleanup();

    assert.strictEqual(closeMock.calls.length, 1, "the tab this task opened must be closed");
    assert.strictEqual(disconnectMock.calls.length, 0, "cleanup must NEVER disconnect the shared pool (would kill the external Chromium)");
  });

  test("cleanup does not close tabs it did not open", async () => {
    const foreignClose = createMock(() => Promise.resolve());
    const foreignPage = { close: foreignClose } as unknown as import("playwright-core").Page;
    const ctx = { newPage: createMock(() => Promise.resolve(foreignPage)), pages: createMock(() => [foreignPage]) };
    const pool = {
      newContext: createMock(() => Promise.resolve(ctx)),
      disconnect: createMock(() => Promise.resolve()),
      trackPage: createMock(() => undefined),
      touchPage: createMock(() => undefined),
      connect: createMock(() => Promise.resolve()),
      isConnected: () => true,
    } as unknown as BrowserPool;

    const svc = new BrowserService(pool);
    // never navigated -> opened no pages of its own
    await svc.cleanup();
    assert.strictEqual(foreignClose.calls.length, 0, "cleanup must not touch pages from other tasks");
  });
});

describe("extractRefs", () => {
  test("extracts ref numbers from snapshot", () => {
    const snapshot = 'button "OK" [__ref="5"]\ninput [__ref="3"]\nlink [__ref="5"]'; // duplicate 5
    const refs = extractRefs(snapshot);
    assert.deepStrictEqual(refs, [3, 5]);
  });

  test("returns empty array when no refs", () => {
    const refs = extractRefs("no refs here");
    assert.deepStrictEqual(refs, []);
  });
});
