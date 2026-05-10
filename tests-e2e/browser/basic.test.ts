// E2E Browser Tests
// Requires a real Chromium with CDP on ws://127.0.0.1:9222
// Run with: BROWSER_E2E=1 bun test tests-e2e/browser/*.test.ts

import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert";
import { BrowserPool } from "../../src/browser/pool.ts";
import { BrowserService } from "../../src/browser/service.ts";

const E2E_ENABLED = process.env.BROWSER_E2E === "1";

describe("Browser E2E", () => {
  let pool: BrowserPool;
  let service: BrowserService;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(async () => {
    if (!E2E_ENABLED) return;
    server = Bun.serve({
      port: 0,
      routes: {
        "/button": new Response(
          `<!DOCTYPE html><html><body><button __ref="1" id="btn">Click me</button><div id="result"></div><script>document.getElementById("btn").onclick=()=>{document.getElementById("result").innerText="clicked";}</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/form": new Response(
          `<!DOCTYPE html><html><body><input __ref="1" id="name" placeholder="Name" /><button __ref="2" id="submit">Submit</button><div id="output"></div><script>document.getElementById("submit").onclick=()=>{const v=document.getElementById("name").value;document.getElementById("output").innerText="Hello "+v;}</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/captcha": new Response(
          `<!DOCTYPE html><html><body><div>Please verify you are human</div><div class="g-recaptcha"></div></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
      },
    });
    baseUrl = `http://localhost:${server.port}`;
    pool = new BrowserPool("http://127.0.0.1:9222");
    service = new BrowserService(pool);
  });

  afterAll(async () => {
    if (!E2E_ENABLED) return;
    await service.cleanup();
    server.stop();
  });

  test("navigate and snapshot", async () => {
    if (!E2E_ENABLED) return;
    const result = await service.navigate(`${baseUrl}/button`);
    assert.ok(result.snapshot.raw.includes("Click me"));
    assert.ok(result.snapshot.refs.includes(1));
  });

  test("click changes page state", async () => {
    if (!E2E_ENABLED) return;
    const result = await service.navigate(`${baseUrl}/button`);
    await service.click(result.page, 1);
    const snapshot = await service.snapshot(result.page);
    assert.ok(snapshot.raw.includes("clicked"));
  });

  test("type and submit form", async () => {
    if (!E2E_ENABLED) return;
    const result = await service.navigate(`${baseUrl}/form`);
    await service.type(result.page, 1, "John");
    await service.click(result.page, 2);
    const snapshot = await service.snapshot(result.page);
    assert.ok(snapshot.raw.includes("Hello John"));
  });

  test("screenshot produces file", async () => {
    if (!E2E_ENABLED) return;
    const result = await service.navigate(`${baseUrl}/button`);
    const attachment = await service.screenshot(result.page);
    assert.strictEqual(attachment.type, "image");
    assert.strictEqual(attachment.mimeType, "image/png");
    const { stat } = await import("node:fs/promises");
    const s = await stat(attachment.path);
    assert.ok(s.size > 0);
  });

  test("multi-tab lifecycle", async () => {
    if (!E2E_ENABLED) return;
    const p1 = await service.navigate(`${baseUrl}/button`);
    const p2 = await service.navigate(`${baseUrl}/form`);
    const tabs = await service.listTabs();
    assert.strictEqual(tabs.length, 2);

    const focused = await service.focusTab(0);
    assert.strictEqual(focused.url(), `${baseUrl}/button`);

    await service.closeTab(1);
    const tabsAfter = await service.listTabs();
    assert.strictEqual(tabsAfter.length, 1);
  });
});
