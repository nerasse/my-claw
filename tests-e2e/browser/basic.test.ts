// E2E Browser Tests
// Requires a real Chromium with CDP on http://127.0.0.1:9222 AND Node on PATH
// (the sidecar runs under Node — Playwright connectOverCDP hangs under Bun).
// Run with: BROWSER_E2E=1 bun test tests-e2e/browser/*.test.ts

import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert";
import { join } from "node:path";
import { BrowserClient } from "../../src/browser/client.ts";

const E2E_ENABLED = process.env.BROWSER_E2E === "1";
const SIDECAR_PORT = Number(process.env.BROWSER_E2E_PORT || 9333);
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const NODE_BIN = process.env.NODE_BIN || "node";

describe("Browser E2E", () => {
  let client: BrowserClient;
  let sidecar: ReturnType<typeof Bun.spawn> | undefined;
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
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    const sidecarPath = join(import.meta.dir, "../../sidecar/server.mjs");
    sidecar = Bun.spawn({
      cmd: [NODE_BIN, sidecarPath],
      env: { ...process.env, CDP_URL: "http://127.0.0.1:9222", PORT: String(SIDECAR_PORT) },
      stdout: "inherit",
      stderr: "inherit",
    });

    // Wait for the sidecar to accept connections.
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${SIDECAR_URL}/health`);
        if (res.ok) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }

    client = new BrowserClient(SIDECAR_URL);
  });

  afterAll(async () => {
    if (!E2E_ENABLED) return;
    await client.cleanup().catch(() => undefined);
    sidecar?.kill();
    server.stop();
  });

  test("navigate returns a snapshot with injected interactive refs", async () => {
    if (!E2E_ENABLED) return;
    const result = await client.navigate(`${baseUrl}/button`);
    assert.ok(result.pageId);
    assert.ok(result.snapshot.raw.includes("Click me"));
    assert.ok(result.snapshot.refs.includes(1), "interactive elements must get refs");
    assert.ok(result.url.includes("/button"));
  });

  test("click changes page state", async () => {
    if (!E2E_ENABLED) return;
    const result = await client.navigate(`${baseUrl}/button`);
    await client.click(result.pageId, 1);
    const snapshot = await client.snapshot(result.pageId);
    assert.ok(snapshot.raw.includes("clicked"));
  });

  test("type and submit form", async () => {
    if (!E2E_ENABLED) return;
    const result = await client.navigate(`${baseUrl}/form`);
    await client.type(result.pageId, 1, "John");
    await client.click(result.pageId, 2);
    const snapshot = await client.snapshot(result.pageId);
    assert.ok(snapshot.raw.includes("Hello John"));
  });

  test("screenshot produces file", async () => {
    if (!E2E_ENABLED) return;
    const result = await client.navigate(`${baseUrl}/button`);
    const attachment = await client.screenshot(result.pageId);
    assert.strictEqual(attachment.type, "image");
    assert.strictEqual(attachment.mimeType, "image/png");
    const { stat } = await import("node:fs/promises");
    const s = await stat(attachment.path);
    assert.ok(s.size > 0);
  });

  test("multi-tab lifecycle: open two, focus one, close one", async () => {
    if (!E2E_ENABLED) return;
    const before = (await client.listTabs()).length;

    await client.navigate(`${baseUrl}/button`);
    await client.navigate(`${baseUrl}/form`);
    const afterOpen = await client.listTabs();
    assert.strictEqual(afterOpen.length, before + 2, "two tabs were opened");

    // Focus a known tab and confirm the sidecar can address it by index.
    const formIndex = afterOpen.findIndex((t) => t.url.includes("/form"));
    const focusedPageId = await client.focusTab(formIndex);
    assert.ok(focusedPageId);

    await client.closeTab(formIndex);
    const afterClose = await client.listTabs();
    assert.strictEqual(afterClose.length, before + 1, "one tab was closed");
  });
});
