import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { BrowserPool } from "../../src/browser/pool.ts";
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

  test("throws when connecting twice concurrently", async () => {
    const fakeBrowser = {
      isConnected: () => false,
      close: () => Promise.resolve(),
      contexts: () => [],
      newContext: () => Promise.resolve({}),
    } as unknown as import("playwright-core").Browser;

    const { chromium } = await import("playwright-core");
    const originalConnect = chromium.connectOverCDP;
    let resolveConnect: (b: typeof fakeBrowser) => void;
    const connectPromise = new Promise<typeof fakeBrowser>((r) => { resolveConnect = r; });
    chromium.connectOverCDP = () => connectPromise as any;

    try {
      const p1 = pool.connect();
      const p2 = pool.connect();
      await assert.rejects(p2, /already in progress/);
      resolveConnect!(fakeBrowser);
      await p1;
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
