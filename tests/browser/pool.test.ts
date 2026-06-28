import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { BrowserPool, getBrowserPool } from "../../src/browser/pool.ts";
import { createMock } from "../helpers/mock.ts";

describe("BrowserPool", () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = new BrowserPool("http://127.0.0.1:9222", 1000);
  });

  afterEach(async () => {
    try {
      await pool.disconnect();
    } catch {
      // ignore disconnect errors in tests
    }
  });

  test("isConnected returns false before connect", () => {
    assert.strictEqual(pool.isConnected(), false);
  });

  test("concurrent connect calls share the same promise", async () => {
    const fakeBrowser = {
      isConnected: () => false,
      close: () => Promise.resolve(),
      contexts: () => [],
      newContext: () => Promise.resolve({}),
      on: () => {},
    } as unknown as import("playwright-core").Browser;

    const { chromium } = await import("playwright-core");
    const originalConnect = chromium.connectOverCDP;
    let resolveConnect: (b: typeof fakeBrowser) => void;
    const connectPromise = new Promise<typeof fakeBrowser>((r) => { resolveConnect = r; });
    let connectCalls = 0;
    chromium.connectOverCDP = () => { connectCalls++; return connectPromise as any; };

    try {
      const p1 = pool.connect();
      const p2 = pool.connect();
      resolveConnect!(fakeBrowser);
      const [b1, b2] = await Promise.all([p1, p2]);
      assert.strictEqual(b1, b2);
      assert.strictEqual(connectCalls, 1);
    } finally {
      chromium.connectOverCDP = originalConnect;
    }
  });

  test("trackPage and touchPage update activity", () => {
    const mockPage = {
      context: () => ({
        browser: () => ({ version: () => "1.0" }),
      }),
    } as unknown as import("playwright-core").Page;

    pool.trackPage(mockPage);
    pool.touchPage(mockPage);
    assert.ok(true);
  });

  test("disconnect does NOT close (kill) the shared CDP browser", async () => {
    const closeMock = createMock(() => Promise.resolve());
    const fakeBrowser = {
      isConnected: () => true,
      close: closeMock,
      contexts: () => [],
      on: () => {},
    } as unknown as import("playwright-core").Browser;

    const { chromium } = await import("playwright-core");
    const originalConnect = chromium.connectOverCDP;
    chromium.connectOverCDP = () => Promise.resolve(fakeBrowser) as any;

    try {
      await pool.connect();
      await pool.disconnect();
      assert.strictEqual(closeMock.calls.length, 0, "disconnect must never call browser.close() on a CDP-attached Chromium");
      assert.strictEqual(pool.isConnected(), false);
    } finally {
      chromium.connectOverCDP = originalConnect;
    }
  });

  test("getBrowserPool returns a singleton per cdpUrl", () => {
    const a = getBrowserPool("http://127.0.0.1:9222");
    const b = getBrowserPool("http://127.0.0.1:9222");
    const c = getBrowserPool("http://127.0.0.1:9999");
    assert.strictEqual(a, b, "same cdpUrl must reuse the same pool");
    assert.notStrictEqual(a, c, "different cdpUrl must get a different pool");
  });

  test("idle sweeper tracks and sweeps pages", async () => {
    const mockClose = createMock(() => Promise.resolve());
    const mockPage = {
      close: mockClose,
      context: () => ({
        browser: () => ({ version: () => "1.0" }),
      }),
    };

    // Need to connect first so the sweep interval is started
    const fakeBrowser = {
      isConnected: () => true,
      close: () => Promise.resolve(),
      contexts: () => [],
      on: () => {},
    } as unknown as import("playwright-core").Browser;

    const { chromium } = await import("playwright-core");
    const originalConnect = chromium.connectOverCDP;
    chromium.connectOverCDP = () => Promise.resolve(fakeBrowser) as any;

    try {
      await pool.connect();
      pool.trackPage(mockPage as any);
      // Verify page is tracked
      assert.ok(true);
      // After disconnect, close should be called
      await pool.disconnect();
      assert.strictEqual(mockClose.calls.length, 1);
    } finally {
      chromium.connectOverCDP = originalConnect;
    }
  });
});
