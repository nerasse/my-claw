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
// Point it at a throwaway Chromium: this suite opens windows and tabs in whatever browser it drives.
const CDP_URL = process.env.BROWSER_E2E_CDP_URL || "http://127.0.0.1:9222";

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
        "/cookie": new Response(`<!DOCTYPE html><html><body>cookie set</body></html>`, {
          headers: { "Content-Type": "text/html", "Set-Cookie": "e2e=shared; Path=/" },
        }),
        "/whoami": new Response(`<!DOCTYPE html><html><body><script>document.body.innerText="cookie: "+document.cookie</script></body></html>`, {
          headers: { "Content-Type": "text/html" },
        }),
        "/opener": new Response(
          `<!DOCTYPE html><html><body><a id="blank" href="/button" target="_blank" style="display:block;width:150px;height:28px">Blank</a><button id="pop" style="width:150px;height:28px" onclick="window.open('/form','','width=500,height=400')">Popup</button></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/tall": new Response(
          `<!DOCTYPE html><html><body><div style="height:3000px">spacer</div><button id="deep" style="width:200px;height:30px">Deep button</button></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        // Content in an iframe lives in a separate JS context: without per-frame stamping the
        // agent cannot see or reach any of it.
        "/iframe": new Response(
          `<!DOCTYPE html><html><body><h1>Outer</h1><iframe src="/iframe-inner" width="400" height="200"></iframe></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/iframe-inner": new Response(
          `<!DOCTYPE html><html><body><button id="b" style="width:150px;height:28px">Inner button</button><script>document.getElementById("b").onclick=()=>{document.getElementById("b").textContent="inner clicked";};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        // Web components hide their controls in a shadow root, which querySelectorAll skips.
        "/shadow": new Response(
          `<!DOCTYPE html><html><body><div id="host"></div><script>const r=document.getElementById("host").attachShadow({mode:"open"});r.innerHTML='<button id="sb" style="width:150px;height:28px">Shadow button</button><div id="out">idle</div>';r.getElementById("sb").onclick=()=>{r.getElementById("out").textContent="shadow clicked";};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/dialog": new Response(
          `<!DOCTYPE html><html><body><button id="ask" style="width:150px;height:28px">Ask</button><div id="res">none</div><script>document.getElementById("ask").onclick=()=>{const r=confirm("sure?");document.getElementById("res").textContent="answer "+r;};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/hover": new Response(
          `<!DOCTYPE html><html><body><button id="menu" style="width:150px;height:28px">Menu</button><button id="sub" style="display:none;width:150px;height:28px">Submenu item</button><script>document.getElementById("menu").onmouseenter=()=>{document.getElementById("sub").style.display="block";};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        // A viewport-sized pad that records where the click landed, to check the
        // fraction-to-pixel conversion rather than merely that a click happened.
        "/pad": new Response(
          `<!DOCTYPE html><html><body style="margin:0"><div id="pad" style="width:100vw;height:100vh"></div><div id="out" style="position:fixed;bottom:0;left:0">none</div><script>document.getElementById("pad").onclick=(e)=>{document.getElementById("out").textContent="at "+e.clientX+","+e.clientY;};</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        "/downloadpage": new Response(
          `<!DOCTYPE html><html><body><a id="dl" href="/file" style="display:block;width:150px;height:28px">Download</a></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        // A page whose download link closes its own tab the moment the file starts: the case the
        // staging registry exists for (22 runs measured with "download.saveAs: canceled").
        "/downloadpage-selfclose": new Response(
          `<!DOCTYPE html><html><body><a id="dl" href="/file" target="_blank" style="display:block;width:150px;height:28px">Download</a><script>document.getElementById("dl").addEventListener("click",()=>setTimeout(()=>window.close(),50));</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
        // A 300-character filename, which produced ENAMETOOLONG six times: the page chooses the
        // name, so the sidecar has to shorten it.
        "/download-long-name": new Response('<!DOCTYPE html><html><body><a id="dl" href="/file-long" style="display:block">Download</a></body></html>', {
          headers: { "Content-Type": "text/html" },
        }),
        // A PDF link answered by a login wall: the name says .pdf, the bytes are HTML, and an
        // agent that trusts the name reports a paper it does not have.
        "/download-liar": new Response('<!DOCTYPE html><html><body><a id="dl" href="/file-liar" style="display:block">Download</a></body></html>', {
          headers: { "Content-Type": "text/html" },
        }),
        "/file-liar": new Response("<!DOCTYPE html><html><body>Please sign in</body></html>", {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="article.pdf"',
          },
        }),
        "/file-long": new Response("long-name-payload", {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${"a".repeat(300)}.pdf"`,
          },
        }),
        "/api/json": new Response(JSON.stringify({ hello: "world" }), {
          headers: { "Content-Type": "application/json" },
        }),
        "/file": new Response("hello", {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="hello.txt"',
          },
        }),
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    const sidecarPath = join(import.meta.dir, "../../sidecar/server.mjs");
    sidecar = Bun.spawn({
      cmd: [NODE_BIN, sidecarPath],
      env: { ...process.env, CDP_URL, PORT: String(SIDECAR_PORT) },
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
      for (const tab of await client.listTabs()) {
        if (tab.url.includes("localhost:")) await client.closeTab(tab.id).catch(() => undefined);
      }
    } catch {
      // sidecar may already be gone
    }
    sidecar?.kill();
    server.stop();
  });

  test("navigate reuses the same tab when its pageId is given", async () => {
    const first = await client.navigate(`${baseUrl}/button`, { newTab: true });
    const reused = await client.navigate(`${baseUrl}/form`, { pageId: first.pageId });
    assert.equal(reused.pageId, first.pageId, "same tab must be reused, not a new one");
    assert.ok(reused.url.includes("/form"));
    await client.closeTab(first.pageId).catch(() => undefined);
  });

  const windowOf = async (pageId: string): Promise<number | undefined> =>
    (await client.listWindows()).find((w) => w.tabs.some((t) => t.pageId === pageId))?.windowId;

  test("a new window is a real window of its own, listed with its tab, sharing the profile's cookies", async () => {
    const a = await client.createWindow(`${baseUrl}/cookie`);
    const b = await client.createWindow(`${baseUrl}/whoami`);
    try {
      assert.notStrictEqual(a.windowId, b.windowId);
      const windows = await client.listWindows();
      assert.deepStrictEqual(windows.find((w) => w.windowId === a.windowId)?.tabs.map((t) => t.pageId), [a.pageId]);
      assert.ok((await client.text(b.pageId)).text.includes("cookie: e2e=shared"), "one profile: a login in one window is a login in all");
    } finally {
      await client.closeWindow(a.windowId);
      await client.closeWindow(b.windowId);
    }
    assert.strictEqual(await windowOf(a.pageId), undefined, "close-window closes its tabs");
  });

  test("a new tab opens in the window it is asked for, even when another window has the focus", async () => {
    const a = await client.createWindow(`${baseUrl}/button`);
    const b = await client.createWindow(`${baseUrl}/form`);
    try {
      await client.focusTab(b.pageId);
      const tab = await client.navigate(`${baseUrl}/tall`, { windowId: a.windowId, newTab: true });
      assert.strictEqual(await windowOf(tab.pageId), a.windowId);
    } finally {
      await client.closeWindow(a.windowId);
      await client.closeWindow(b.windowId);
    }
  });

  test("a tab or a window a click opens is listed with the page that opened it", async () => {
    const a = await client.createWindow(`${baseUrl}/opener`);
    const extra: number[] = [];
    try {
      const blank = Number(a.snapshot.raw.match(/\[__ref="(\d+)"\] a "Blank"/)?.[1]);
      const pop = Number(a.snapshot.raw.match(/\[__ref="(\d+)"\] button "Popup"/)?.[1]);
      await client.click(a.pageId, blank);
      await client.click(a.pageId, pop);
      await Bun.sleep(500);
      const windows = await client.listWindows();
      const opened = windows.flatMap((w) => w.tabs.map((t) => ({ ...t, windowId: w.windowId }))).filter((t) => t.openerPageId === a.pageId);
      const sameWindow = opened.find((t) => t.url.includes("/button"));
      const popup = opened.find((t) => t.url.includes("/form"));
      assert.strictEqual(sameWindow?.windowId, a.windowId, "target=_blank stays in the opener's window");
      assert.ok(popup && popup.windowId !== a.windowId, "a window.open with features is a window of its own");
      if (popup) extra.push(popup.windowId);
    } finally {
      await client.closeWindow(a.windowId);
      for (const w of extra) await client.closeWindow(w).catch(() => undefined);
    }
  });

  test("clicking a file input opens no native dialog, and the upload answers the chooser it opened", async () => {
    const path = "/tmp/my-claw-e2e-upload3.txt";
    await Bun.write(path, "payload");
    const result = await client.navigate(`${baseUrl}/upload`);
    const button = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] button/)?.[1]);
    await client.click(result.pageId, button);
    const clicked = await client.snapshot(result.pageId);
    assert.ok(clicked.raw.includes("A file chooser is open on this page"), "the chooser is intercepted and announced");
    const info = await client.uploadFile(result.pageId, [path]);
    assert.strictEqual(info.via, "open-chooser");
    const after = await client.snapshot(result.pageId);
    assert.ok(after.raw.includes("file: my-claw-e2e-upload3.txt"));
    assert.ok(!after.raw.includes("A file chooser is open"), "an answered chooser is not announced again");
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

  test("iframe content gets refs and is clickable across the frame boundary", async () => {
    const result = await client.navigate(`${baseUrl}/iframe`);
    assert.ok(result.snapshot.raw.includes("[iframe"), "the iframe must be announced");
    const ref = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] button "Inner button"/)?.[1]);
    assert.ok(ref > 0, "the button inside the iframe must get a ref");
    await client.click(result.pageId, ref);
    const after = await client.snapshot(result.pageId);
    assert.ok(after.raw.includes("inner clicked"), "the click must reach inside the iframe");
  });

  test("shadow DOM controls get refs and are clickable", async () => {
    const result = await client.navigate(`${baseUrl}/shadow`);
    const ref = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] button "Shadow button"/)?.[1]);
    assert.ok(ref > 0, "a button inside a shadow root must get a ref");
    await client.click(result.pageId, ref);
    const out = await client.evaluate(
      result.pageId,
      "return document.getElementById('host').shadowRoot.getElementById('out').textContent",
    );
    assert.strictEqual(out.value, '"shadow clicked"');
  });

  test("hover reveals a menu that is hidden otherwise", async () => {
    const result = await client.navigate(`${baseUrl}/hover`);
    assert.ok(!result.snapshot.raw.includes("Submenu item"), "the submenu starts hidden");
    const menu = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] button "Menu"/)?.[1]);
    assert.ok(menu > 0, "the hover trigger must have a ref");
    await client.hover(result.pageId, menu);
    const after = await client.snapshot(result.pageId);
    assert.ok(after.raw.includes("Submenu item"), "hovering must reveal the submenu");
  });

  test("click_at converts viewport fractions into the right pixel position", async () => {
    const result = await client.navigate(`${baseUrl}/pad`);
    const at = await client.clickAt(result.pageId, 0.5, 0.5);
    const out = await client.evaluate(result.pageId, "return document.getElementById('out').textContent");
    const expected = `"at ${Math.round(at.viewport.width * 0.5)},${Math.round(at.viewport.height * 0.5)}"`;
    assert.strictEqual(out.value, expected);
  });

  test("click_at refuses coordinates outside 0..1", async () => {
    const result = await client.navigate(`${baseUrl}/pad`);
    await assert.rejects(client.clickAt(result.pageId, 960, 540), /fractions/);
  });

  test("wait_for resolves on visible text", async () => {
    const result = await client.navigate(`${baseUrl}/button`);
    const waited = await client.waitFor(result.pageId, { text: "Click me", timeoutMs: 3000 });
    assert.strictEqual(waited.waited, "text");
  });

  test("dialogs are auto-accepted by default and can be dismissed on demand", async () => {
    const result = await client.navigate(`${baseUrl}/dialog`);
    const ask = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] button "Ask"/)?.[1]);
    await client.click(result.pageId, ask);
    let res = await client.evaluate(result.pageId, "return document.getElementById('res').textContent");
    assert.strictEqual(res.value, '"answer true"', "default policy accepts");

    await client.handleDialog(result.pageId, false);
    await client.click(result.pageId, ask);
    res = await client.evaluate(result.pageId, "return document.getElementById('res').textContent");
    assert.strictEqual(res.value, '"answer false"', "the override must dismiss exactly once");

    await client.click(result.pageId, ask);
    res = await client.evaluate(result.pageId, "return document.getElementById('res').textContent");
    assert.strictEqual(res.value, '"answer true"', "auto-accept must resume after the override");
  });

  test("downloads are captured and saved", async () => {
    const dir = `/tmp/my-claw-e2e-downloads-${Date.now()}`;
    const result = await client.navigate(`${baseUrl}/downloadpage`);
    const link = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] a "Download"/)?.[1]);
    await client.click(result.pageId, link).catch(() => undefined); // a download click never "navigates"
    const saved = await client.claimDownload({ pageId: result.pageId, dir, waitMs: 15000 });
    assert.strictEqual(saved.filename, "hello.txt");
    assert.strictEqual(saved.kind, "unknown");
    assert.strictEqual(saved.bytes, 5);
    const { readFile } = await import("node:fs/promises");
    assert.strictEqual(await readFile(saved.path, "utf8"), "hello");
  });

  test("a download survives the tab that started it closing", async () => {
    // The case behind 22 "download.saveAs: canceled": the page hands the file off and goes away, and
    // the bytes have to be secured before that happens, not when the agent asks for them.
    const dir = `/tmp/my-claw-e2e-downloads-${Date.now()}-close`;
    const result = await client.navigate(`${baseUrl}/downloadpage-selfclose`);
    const link = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] a "Download"/)?.[1]);
    await client.click(result.pageId, link).catch(() => undefined);
    // Wait for the record, then close the page: the claim must still work.
    let records = await client.downloads({ windowId: await windowOf(result.pageId) });
    for (let i = 0; i < 40 && records.length === 0; i++) {
      await Bun.sleep(100);
      records = await client.downloads({ windowId: await windowOf(result.pageId) });
    }
    assert.ok(records.length > 0, "the download is recorded the moment it starts");
    await client.closeTab(result.pageId).catch(() => undefined);
    const saved = await client.claimDownload({ windowId: await windowOf(result.pageId).catch(() => undefined), dir, waitMs: 5000 });
    assert.strictEqual(saved.filename, "hello.txt");
    const { readFile } = await import("node:fs/promises");
    assert.strictEqual(await readFile(saved.path, "utf8"), "hello");
  });

  test("a 300-character name from the page is shortened, and keeps its extension", async () => {
    const dir = `/tmp/my-claw-e2e-downloads-${Date.now()}-long`;
    const result = await client.navigate(`${baseUrl}/download-long-name`);
    const link = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] a "Download"/)?.[1]);
    await client.click(result.pageId, link).catch(() => undefined);
    const saved = await client.claimDownload({ pageId: result.pageId, dir, waitMs: 15000 });
    assert.ok(saved.filename.endsWith(".pdf"), saved.filename);
    assert.ok(saved.filename.length <= 150, `kept ${saved.filename.length} chars`);
    assert.strictEqual(await Bun.file(saved.path).text(), "long-name-payload");
  });

  test("a PDF name holding an HTML page is reported as such", async () => {
    const dir = `/tmp/my-claw-e2e-downloads-${Date.now()}-liar`;
    const result = await client.navigate(`${baseUrl}/download-liar`);
    const link = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] a "Download"/)?.[1]);
    await client.click(result.pageId, link).catch(() => undefined);
    const saved = await client.claimDownload({ pageId: result.pageId, dir, waitMs: 15000 });
    assert.strictEqual(saved.filename, "article.pdf");
    assert.strictEqual(saved.kind, "html", "the type comes from the bytes, never the name");
  });

  test("a download never overwrites the previous one of the same name", async () => {
    const dir = `/tmp/my-claw-e2e-downloads-${Date.now()}-dup`;
    const first = await client.navigate(`${baseUrl}/downloadpage`);
    const link = Number(first.snapshot.raw.match(/\[__ref="(\d+)"\] a "Download"/)?.[1]);
    await client.click(first.pageId, link).catch(() => undefined);
    const a = await client.claimDownload({ pageId: first.pageId, dir, waitMs: 15000 });
    await client.click(first.pageId, link).catch(() => undefined);
    const b = await client.claimDownload({ pageId: first.pageId, dir, waitMs: 15000 });
    assert.notStrictEqual(a.path, b.path);
    assert.strictEqual(b.filename, "hello (2).txt");
  });

  test("a claim cannot write outside the directory it was given", async () => {
    const dir = `/tmp/my-claw-e2e-downloads-${Date.now()}-escape`;
    const result = await client.navigate(`${baseUrl}/downloadpage`);
    const link = Number(result.snapshot.raw.match(/\[__ref="(\d+)"\] a "Download"/)?.[1]);
    await client.click(result.pageId, link).catch(() => undefined);
    const saved = await client.claimDownload({ pageId: result.pageId, dir, filename: "../../etc/escaped.txt", waitMs: 15000 });
    assert.ok(saved.path.startsWith(dir), `${saved.path} must stay in ${dir}`);
    assert.strictEqual(saved.filename, "escaped.txt");
  });

  test("navigating to a URL that is a download reports it instead of failing", async () => {
    // 54 navigations over 1631 runs were killed by "Download is starting", 18 of them re-attempted
    // as errors. The tab keeps the previous page and the file is in the registry.
    const result = await client.navigate(`${baseUrl}/file`, { newTab: true });
    assert.strictEqual(result.downloaded, true);
    const [record] = await client.downloads({ windowId: await windowOf(result.pageId) });
    assert.ok(record, "the download the navigation started must be recorded");
  });

  test("download_wait fails fast on a stale page instead of burning the timeout", async () => {
    const started = Date.now();
    // A page that is gone is not an error any more: the record outlives it, so no record is the
    // only thing the caller can act on, and it must say so at once rather than wait.
    await assert.rejects(client.claimDownload({ pageId: "bogus-page-id", dir: "/tmp", waitMs: 20000 }), /No download to save/);
    assert.ok(Date.now() - started < 3000, "it must not wait for the timeout");
  });

  test("cdp reaches allowed methods and the sidecar refuses session-credential ones", async () => {
    const result = await client.navigate(`${baseUrl}/button`);
    const doc = await client.cdp(result.pageId, "DOM.getDocument", { depth: 1 });
    assert.ok(doc.result.includes("root"), "DOM.getDocument must work");
    // Defence in depth: refused by the sidecar itself, whatever the Bun-side config says.
    await assert.rejects(client.cdp(result.pageId, "Network.getAllCookies"), /blocked/i);
    await assert.rejects(client.cdp(result.pageId, "Target.createTarget"), /blocked/i);
  });

  test("pdf export writes a real PDF", async () => {
    const path = "/tmp/my-claw-e2e-page.pdf";
    const result = await client.navigate(`${baseUrl}/button`);
    await client.pdf(result.pageId, path);
    const { readFile } = await import("node:fs/promises");
    const head = (await readFile(path)).subarray(0, 5).toString("latin1");
    assert.strictEqual(head, "%PDF-", "the file must actually be a PDF");
  });

  test("reload returns a fresh page, and text reads it", async () => {
    const page = await client.navigate(`${baseUrl}/button`);
    await client.click(page.pageId, page.snapshot.refs[0]!);
    const clicked = await client.text(page.pageId);
    assert.match(clicked.text, /clicked/, "the click is visible on the page");

    const reloaded = await client.reload(page.pageId);
    assert.ok(reloaded.snapshot.refs.length > 0, "a real reload re-stamps refs");
    const after = await client.text(page.pageId);
    assert.doesNotMatch(after.text, /clicked/, "a reload hands back the page as loaded, not as left");
  });

  test("fetch issues the request from the page itself", async () => {
    const page = await client.navigate(`${baseUrl}/button`);
    const ok = await client.fetchInPage(page.pageId, { url: "/api/json" });
    assert.strictEqual(ok.status, 200);
    assert.match(ok.body, /hello/);
    assert.match(ok.contentType, /application\/json/);

    const missing = await client.fetchInPage(page.pageId, { url: "/api/does-not-exist" });
    assert.strictEqual(missing.status, 404, "a non-2xx comes back as a result, not a thrown error");
  });

  test("multi-tab lifecycle: open two, focus one, close one", async () => {
    const before = (await client.listTabs()).length;

    await client.navigate(`${baseUrl}/button`);
    const form = await client.navigate(`${baseUrl}/form`);
    const afterOpen = await client.listTabs();
    assert.strictEqual(afterOpen.length, before + 2, "two tabs were opened");
    assert.ok(afterOpen.some((t) => t.id === form.pageId), "tabs are listed by their page id");

    await client.focusTab(form.pageId);
    await client.closeTab(form.pageId);
    const afterClose = await client.listTabs();
    assert.strictEqual(afterClose.length, before + 1, "one tab was closed");
  });
});
