import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { BrowserPool } from "../../src/browser/pool.ts";

describe("BrowserPool", () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = new BrowserPool("http://127.0.0.1:9222");
  });

  afterEach(async () => {
    await pool.disconnect();
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
});
