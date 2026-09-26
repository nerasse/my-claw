// A tab whose page is stuck in its own JavaScript, against a real Chromium: it must hold up no one.
// Run with: BROWSER_E2E=1 BROWSER_E2E_CDP_URL=http://127.0.0.1:<throwaway> bun test tests-e2e/browser/frozen.test.ts
//
// 2026-09-26: a careers site froze one tab, and the window listing, which asked every tab its
// title, timed out 80 times over forty minutes for every run, on every site.

import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert";
import { join } from "node:path";
import { BrowserClient } from "../../src/browser/client.ts";

const E2E_ENABLED = process.env.BROWSER_E2E === "1";
const SIDECAR_PORT = Number(process.env.BROWSER_E2E_FROZEN_PORT || 9335);
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const NODE_BIN = process.env.NODE_BIN || "node";
const CDP_URL = process.env.BROWSER_E2E_CDP_URL || "http://127.0.0.1:9222";

const html = (body: string) => new Response(`<!DOCTYPE html><html>${body}</html>`, { headers: { "Content-Type": "text/html" } });

describe.skipIf(!E2E_ENABLED)("Browser E2E: a frozen tab", () => {
  let sidecar: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  async function startSidecar(): Promise<void> {
    sidecar = Bun.spawn({
      cmd: [NODE_BIN, join(import.meta.dir, "../../sidecar/server.mjs")],
      env: { ...process.env, CDP_URL, PORT: String(SIDECAR_PORT) },
      stdout: "inherit",
      stderr: "inherit",
    });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${SIDECAR_URL}/health`).then((r) => r.ok, () => false)) return;
      await Bun.sleep(50);
    }
    throw new Error("the sidecar did not come up");
  }

  /** A tab that loads, then locks its renderer in a loop for good. */
  async function frozenTab(client: BrowserClient): Promise<string> {
    const { pageId } = await client.navigate(`${base}/freeze`, { newTab: true });
    await Bun.sleep(700);
    return pageId;
  }

  async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
    const started = Date.now();
    const value = await work;
    return { value, ms: Date.now() - started };
  }

  async function failure(call: Promise<unknown>): Promise<string> {
    try {
      await call;
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("the call was expected to fail");
  }

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      routes: {
        "/freeze": html(`<head><title>frozen</title></head><body>soon frozen<script>setTimeout(()=>{for(;;){}},300)</script></body>`),
        "/freeze-now": html(`<head><title>frozen at birth</title></head><body><script>for(;;){}</script></body>`),
        "/healthy": html(`<head><title>healthy</title></head><body><button id="b" style="width:150px;height:30px" onclick="this.textContent='clicked'">Go</button></body>`),
        // noopener: a popup that shares its opener's renderer freezes the opener with it (measured),
        // which is a frozen opener, a case of its own. This one lives in a process of its own.
        "/opens-frozen": html(`<body><button id="o" style="width:150px;height:30px" onclick="window.open('/freeze-now','_blank','noopener')">Open</button></body>`),
        "/long": html(`<body><pre>${"0123456789".repeat(30_000)}</pre></body>`),
      },
    });
    base = `http://localhost:${server.port}`;
    await startSidecar();
  });

  afterAll(async () => {
    const client = new BrowserClient(SIDECAR_URL);
    for (const tab of await client.listTabs().catch(() => [])) {
      if (tab.url.includes(`:${server.port}/`)) await client.closeTab(tab.id).catch(() => undefined);
    }
    sidecar?.kill();
    server.stop();
  });

  test("the listings answer at once, and another window works, on the same site too", async () => {
    const client = new BrowserClient(SIDECAR_URL);
    const frozen = await frozenTab(client);

    const windows = await timed(client.listWindows());
    assert.ok(windows.ms < 2000, `list-windows took ${windows.ms}ms`);
    const listed = windows.value.flatMap((w) => w.tabs).find((t) => t.pageId === frozen);
    assert.equal(listed?.title, "frozen", "the frozen tab is listed with its title, read from the browser");
    const tabs = await timed(client.listTabs());
    assert.ok(tabs.ms < 2000, `tabs took ${tabs.ms}ms`);

    const other = await timed(client.createWindow(`${base}/healthy`));
    assert.ok(other.ms < 5000, `a new window took ${other.ms}ms`);
    const tab = await client.navigate(`${base}/healthy`, { windowId: other.value.windowId, newTab: true });
    assert.ok(tab.snapshot.refs.length > 0);
    await client.click(tab.pageId, tab.snapshot.refs[0]!);
    assert.match((await client.snapshot(tab.pageId)).raw, /clicked/);
    assert.equal((await client.screenshot(tab.pageId)).type, "image");

    await client.closeWindow(other.value.windowId);
    await client.closeTab(frozen);
  }, 60_000);

  test("a popup frozen from its first line does not stop anyone opening windows", async () => {
    const client = new BrowserClient(SIDECAR_URL);
    const opener = await client.navigate(`${base}/opens-frozen`, { newTab: true });
    await client.click(opener.pageId, opener.snapshot.refs[0]!);
    await Bun.sleep(700);

    const other = await timed(client.createWindow(`${base}/healthy`));
    assert.ok(other.ms < 5000, `a new window took ${other.ms}ms`);
    const listing = await timed(client.listWindows());
    assert.ok(listing.ms < 2000, `list-windows took ${listing.ms}ms`);

    const born = listing.value.flatMap((w) => w.tabs).find((t) => t.url.endsWith("/freeze-now"));
    if (born) await client.closeTab(born.pageId).catch(() => undefined);
    await client.closeWindow(other.value.windowId);
    await client.closeTab(opener.pageId);
  }, 60_000);

  test("a call on the frozen tab closes it and says so; the other tabs are left", async () => {
    const client = new BrowserClient(SIDECAR_URL, undefined, { default: 3000 });
    const healthy = await client.navigate(`${base}/healthy`, { newTab: true });
    const frozen = await frozenTab(client);

    const error = await failure(client.snapshot(frozen));
    assert.match(error, /frozen/);
    assert.match(error, /was closed/);
    const ids = (await client.listTabs()).map((t) => t.id);
    assert.ok(!ids.includes(frozen), "the frozen tab is gone");
    assert.ok(ids.includes(healthy.pageId), "the healthy tab stayed");
    await client.closeTab(healthy.pageId);
  }, 60_000);

  test("a page that is slow but alive is left open", async () => {
    const client = new BrowserClient(SIDECAR_URL, undefined, { default: 1500 });
    const slow = await client.navigate(`${base}/healthy`, { newTab: true });
    const error = await failure(client.evaluate(slow.pageId, "await new Promise((r) => setTimeout(r, 4000)); return 1"));
    assert.match(error, /slow, not stuck/);
    assert.ok((await client.listTabs()).some((t) => t.id === slow.pageId), "a slow tab is not closed");
    await client.closeTab(slow.pageId);
  }, 60_000);

  // Owner, 2026-09-26: never close a tab an agent handed to the user.
  test("a frozen tab a human was handed is left open", async () => {
    const client = new BrowserClient(SIDECAR_URL, undefined, { default: 3000 });
    const frozen = await frozenTab(client);
    client.keepOpenWhen((pageId) => pageId === frozen);
    const error = await failure(client.snapshot(frozen));
    assert.match(error, /left open/);
    assert.ok((await client.listTabs()).some((t) => t.id === frozen), "the human's tab is still there");
    await client.closeTab(frozen);
  }, 60_000);

  test("a sidecar restarted beside a frozen tab reaches the browser again, by closing it", async () => {
    const client = new BrowserClient(SIDECAR_URL);
    const healthy = await client.navigate(`${base}/healthy`, { newTab: true });
    const frozen = await frozenTab(client);
    sidecar?.kill();
    await sidecar?.exited;
    await startSidecar();

    const windows = await timed(client.listWindows());
    assert.ok(windows.ms < 25_000, `reconnecting took ${windows.ms}ms`);
    const ids = windows.value.flatMap((w) => w.tabs).map((t) => t.pageId);
    assert.ok(!ids.includes(frozen), "the frozen tab was closed");
    assert.ok(ids.includes(healthy.pageId), "the healthy tab survived the restart");
    assert.match((await client.snapshot(healthy.pageId)).raw, /Go/);
    await client.closeTab(healthy.pageId);
  }, 90_000);

  test("nothing a page gives back is cut by the sidecar", async () => {
    const client = new BrowserClient(SIDECAR_URL);
    const page = await client.navigate(`${base}/long`, { newTab: true });
    assert.equal((await client.text(page.pageId)).text.length, 300_000);
    const value = (await client.evaluate(page.pageId, "return 'y'.repeat(150000)")).value;
    assert.equal(value.length, 150_002, "the JSON string, quotes included, whole");
    await client.closeTab(page.pageId);
  }, 60_000);
});
