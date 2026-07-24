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

// skipIf (not an early return): a disabled block is reported as skipped, not as
// passing tests that asserted nothing.
describe.skipIf(!E2E_ENABLED)("Browser E2E", () => {
  let client: BrowserClient;
  let sidecar: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(async () => {
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
        // Reproduces the Instagram birthday blocker: a custom combobox whose options are
        // plain divs with role=option, rendered in a portal at the end of <body>.
        "/combobox": new Response(
          `<!DOCTYPE html><html><body><div id="trigger" role="combobox" aria-label="Month" tabindex="0" style="width:200px;height:30px;border:1px solid #000">Month</div><div id="value">none</div><script>const OPTIONS=["July","August"];document.getElementById("trigger").onclick=()=>{if(document.getElementById("listbox"))return;const lb=document.createElement("div");lb.id="listbox";lb.setAttribute("role","listbox");for(const o of OPTIONS){const d=document.createElement("div");d.setAttribute("role","option");d.textContent=o;d.style.cssText="width:200px;height:24px";d.onclick=(e)=>{e.stopPropagation();document.getElementById("value").innerText="selected "+o;lb.remove();};lb.appendChild(d);}document.body.appendChild(lb);};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        // Reproduces the Instagram profile-photo blocker: the real input[type=file] is
        // display:none (so it gets no ref) and a visible button clicks it, which is what
        // opens the native OS dialog.
        "/upload": new Response(
          `<!DOCTYPE html><html><body><button id="pick" style="width:200px;height:30px">Add a profile photo</button><input id="file" type="file" style="display:none" /><div id="name">no file</div><script>document.getElementById("pick").onclick=()=>document.getElementById("file").click();document.getElementById("file").onchange=(e)=>{document.getElementById("name").innerText="file: "+((e.target.files[0]||{}).name||"");};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/tall": new Response(
          `<!DOCTYPE html><html><body><div style="height:3000px">spacer</div><button id="deep" style="width:200px;height:30px">Deep button</button></body></html>`,
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
    // Tabs are never auto-closed now, so this test tidies up its own tabs (those
    // pointing at the local test server) to avoid leaking them into the shared browser.
    try {
      const tabs = await client.listTabs();
      for (let i = tabs.length - 1; i >= 0; i--) {
        if (tabs[i]?.url.includes("localhost:")) await client.closeTab(i).catch(() => undefined);
      }
    } catch {
      // sidecar may already be gone
    }
    await client.cleanup().catch(() => undefined);
    sidecar?.kill();
    server.stop();
  });

  test("navigate reuses the same tab when reusePageId is given", async () => {
    const first = await client.navigate(`${baseUrl}/button`, { newTab: true });
    const reused = await client.navigate(`${baseUrl}/form`, { reusePageId: first.pageId });
    assert.equal(reused.pageId, first.pageId, "same tab must be reused, not a new one");
    assert.ok(reused.url.includes("/form"));
    await client.closeTab((await client.listTabs()).findIndex((t) => t.url.includes("/form"))).catch(() => undefined);
  });

  test("cleanup leaves tabs open (persistent browser)", async () => {
    const before = (await client.listTabs()).length;
    await client.navigate(`${baseUrl}/button`, { newTab: true });
    await client.cleanup();

    // A fresh session on the same sidecar still sees the tab: it was NOT closed.
    const fresh = new BrowserClient(SIDECAR_URL);
    const after = await fresh.listTabs();
    assert.ok(after.length >= before + 1, "cleanup must not close tabs");
    const idx = after.findIndex((t) => t.url.includes("/button"));
    if (idx >= 0) await fresh.closeTab(idx).catch(() => undefined);
    await fresh.cleanup().catch(() => undefined);
  });

  test("navigate returns a snapshot with injected interactive refs", async () => {
    const result = await client.navigate(`${baseUrl}/button`);
    assert.ok(result.pageId);
    assert.ok(result.snapshot.raw.includes("Click me"));
    assert.ok(result.snapshot.refs.includes(1), "interactive elements must get refs");
    assert.ok(result.url.includes("/button"));
  });

  test("click changes page state", async () => {
    const result = await client.navigate(`${baseUrl}/button`);
    await client.click(result.pageId, 1);
    const snapshot = await client.snapshot(result.pageId);
    assert.ok(snapshot.raw.includes("clicked"));
  });

  test("type and submit form", async () => {
    const result = await client.navigate(`${baseUrl}/form`);
    await client.type(result.pageId, 1, "John");
    await client.click(result.pageId, 2);
    const snapshot = await client.snapshot(result.pageId);
    assert.ok(snapshot.raw.includes("Hello John"));
  });

  test("screenshot produces file", async () => {
    const result = await client.navigate(`${baseUrl}/button`);
    const attachment = await client.screenshot(result.pageId);
    assert.strictEqual(attachment.type, "image");
    assert.strictEqual(attachment.mimeType, "image/png");
    const { stat } = await import("node:fs/promises");
    const s = await stat(attachment.path);
    assert.ok(s.size > 0);
  });

  test("custom combobox options are reachable by ref (role=option)", async () => {
    const result = await client.navigate(`${baseUrl}/combobox`);
    const trigger = result.snapshot.raw.match(/\[__ref="(\d+)"\] combobox/)?.[1];
    assert.ok(trigger, "the combobox trigger must get a ref");
    await client.click(result.pageId, Number(trigger));
    const opened = await client.snapshot(result.pageId);
    // The regression: options used to appear in the aria tree with no ref at all.
    assert.ok(/\[__ref="\d+"\] option "July"/.test(opened.raw), "options must be stamped with refs");
  });

  test("select_option picks a value in a custom combobox", async () => {
    const result = await client.navigate(`${baseUrl}/combobox`);
    const trigger = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] combobox/)?.[1]);
    const info = await client.selectOption(result.pageId, trigger, "July");
    assert.ok(info.via.startsWith("role=") || info.via === "text", `unexpected path: ${info.via}`);
    const after = await client.snapshot(result.pageId);
    assert.ok(after.raw.includes("selected July"), "the selection must reach the page");
  });

  test("upload sets a file on a hidden input that has no ref", async () => {
    const path = "/tmp/my-claw-e2e-upload.txt";
    await Bun.write(path, "payload");
    const result = await client.navigate(`${baseUrl}/upload`);
    const info = await client.uploadFile(result.pageId, [path]);
    assert.strictEqual(info.via, "page-input");
    const after = await client.snapshot(result.pageId);
    assert.ok(after.raw.includes("file: my-claw-e2e-upload.txt"), "the file must be attached");
  });

  test("upload through the trigger button intercepts the native file chooser", async () => {
    const path = "/tmp/my-claw-e2e-upload2.txt";
    await Bun.write(path, "payload");
    const result = await client.navigate(`${baseUrl}/upload`);
    const button = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] button/)?.[1]);
    const info = await client.uploadFile(result.pageId, [path], button);
    assert.strictEqual(info.via, "filechooser");
    const after = await client.snapshot(result.pageId);
    assert.ok(after.raw.includes("file: my-claw-e2e-upload2.txt"));
  });

  test("offscreen elements are flagged and scroll brings them into view", async () => {
    const result = await client.navigate(`${baseUrl}/tall`);
    assert.ok(/button "Deep button" \(offscreen/.test(result.snapshot.raw), "below-the-fold must be flagged");
    await client.scroll(result.pageId, "down", 3000);
    const after = await client.snapshot(result.pageId);
    assert.ok(/\[__ref="\d+"\] button "Deep button"(?! \(offscreen)/.test(after.raw), "scroll must reveal it");
  });

  test("multi-tab lifecycle: open two, focus one, close one", async () => {
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
