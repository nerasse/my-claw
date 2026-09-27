// The owner's live view against a real Chromium: the VNC screen, the pictures, the owner's hand.
// Run with: BROWSER_E2E=1 BROWSER_E2E_CDP_URL=http://127.0.0.1:<throwaway> bun test tests-e2e/browser/live.test.ts
// The throwaway Chromium runs on an Xvfb screen of 1920x1080 (the sidecar's default stage). With
// BROWSER_E2E_DISPLAY set, the X server itself is asked where the windows are.

import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert";
import { join } from "node:path";
import { BrowserClient } from "../../src/browser/client.ts";
import type { BrowserWindowView } from "../../src/browser/types.ts";
import { BrowserLive } from "../../src/channels/my-claw-app/browser-live.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { BrowserSession } from "../../src/tools/browser/session.ts";

const E2E_ENABLED = process.env.BROWSER_E2E === "1";
const SIDECAR_PORT = Number(process.env.BROWSER_E2E_LIVE_PORT || 9336);
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const NODE_BIN = process.env.NODE_BIN || "node";
const CDP_URL = process.env.BROWSER_E2E_CDP_URL || "http://127.0.0.1:9222";
const DISPLAY = process.env.BROWSER_E2E_DISPLAY;

const html = (body: string) => new Response(`<!DOCTYPE html><html>${body}</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });

describe.skipIf(!E2E_ENABLED)("Browser E2E: the live view", () => {
  let sidecar: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let site: string;
  let other: string;
  const heard: string[] = [];
  const client = new BrowserClient(SIDECAR_URL);
  const opened: number[] = [];

  async function window(id: number): Promise<BrowserWindowView> {
    const w = (await client.listWindows()).find((x) => x.windowId === id);
    assert.ok(w, `window ${id} is listed`);
    return w;
  }

  async function onStage(): Promise<number[]> {
    return (await client.listWindows()).filter((w) => w.onStage).map((w) => w.windowId);
  }

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 5000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (ok(value)) return value;
      if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)}`);
      await Bun.sleep(100);
    }
  }

  /** The X server's own answer: the windows whose left edge is on the 1920 px screen. */
  async function xOnScreen(): Promise<string[]> {
    const proc = Bun.spawn(["xwininfo", "-root", "-children"], { env: { ...process.env, DISPLAY: DISPLAY ?? "" }, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    return out
      .split("\n")
      .filter((l) => / - Chromium"/.test(l))
      .flatMap((l) => {
        const m = l.match(/"(.*) - Chromium".*\s(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
        return m && Number(m[4]) < 1920 ? [m[1]!] : [];
      });
  }

  /** A picture stream straight from the sidecar, the way the server's relay opens it. */
  function cast(streams: Array<{ pageId: string }>) {
    const socket = new WebSocket(`${SIDECAR_URL.replace("http", "ws")}/cast`);
    const frames: Array<{ pageId: string; width: number; height: number; at: number }> = [];
    const gone: string[] = [];
    socket.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; pageId: string; width: number; height: number };
      if (m.type === "frame") frames.push({ pageId: m.pageId, width: m.width, height: m.height, at: Date.now() });
      if (m.type === "gone") gone.push(m.pageId);
    };
    const ready = new Promise<void>((resolve) => {
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "watch", streams: streams.map((s) => ({ ...s, maxWidth: 800, maxHeight: 450, quality: 50, fps: 20 })) }));
        resolve();
      };
    });
    return { socket, frames, gone, ready };
  }

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      routes: {
        "/heard": async (req) => {
          heard.push(await req.text());
          return new Response("ok");
        },
        "/page": html(
          `<head><title>page</title></head><body style="margin:0"><div style="height:100px">top</div><iframe id=f style="width:600px;height:200px;border:0"></iframe><div style="height:4000px">tall</div><script>document.getElementById('f').src=location.href.replace('localhost','127.0.0.1').replace('/page','/frame')</script></body>`,
        ),
        "/frame": html(
          `<body style="margin:0"><button id=b style="width:200px;height:80px" onclick="fetch('/heard',{method:'POST',body:'click '+event.isTrusted})">verify</button><input id=i style="width:300px;height:40px" onkeydown="if(event.key==='Enter')fetch('/heard',{method:'POST',body:'enter '+this.value+' '+event.isTrusted})"></body>`,
        ),
        "/opener": html(
          `<head><title>opener</title></head><body><button id=p style="width:200px;height:40px" onclick="window.open('/popup','','width=500,height=400')">popup</button></body>`,
        ),
        "/popup": html(`<head><title>popup</title></head><body>popup</body>`),
        "/one": html(`<head><title>one</title></head><body>one</body>`),
        "/two": html(`<head><title>two</title></head><body>two</body>`),
      },
    });
    site = `http://localhost:${server.port}`;
    other = `http://127.0.0.1:${server.port}`;
    sidecar = Bun.spawn({
      cmd: [NODE_BIN, join(import.meta.dir, "../../sidecar/server.mjs")],
      env: { ...process.env, CDP_URL, PORT: String(SIDECAR_PORT) },
      stdout: "inherit",
      stderr: "inherit",
    });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${SIDECAR_URL}/health`).then((r) => r.ok, () => false)) break;
      await Bun.sleep(50);
    }
  });

  afterAll(async () => {
    for (const id of opened) await client.closeWindow(id).catch(() => undefined);
    sidecar?.kill();
    server.stop();
  });

  test("an agent's window is born off the VNC screen; the owner's goes on it, alone", async () => {
    const agent = await client.createWindow(`${site}/one`);
    opened.push(agent.windowId);
    assert.equal((await window(agent.windowId)).onStage, false, "an agent's window never lands where the owner looks");
    const mine = await client.createWindow(`${site}/two`, { onStage: true });
    opened.push(mine.windowId);
    assert.deepEqual(await onStage(), [mine.windowId], "one window on the screen: the owner's");
    if (DISPLAY) assert.deepEqual(await xOnScreen(), ["two"], "the X server agrees");

    await client.stage(agent.windowId);
    assert.deepEqual(await onStage(), [agent.windowId], "staging swaps: the other one leaves the screen");
    if (DISPLAY) assert.deepEqual(await xOnScreen(), ["one"]);
  }, 60_000);

  test("a popup of a window off the screen is put off it; a popup of the window on it stays", async () => {
    const back = await client.createWindow(`${site}/opener`);
    opened.push(back.windowId);
    const front = await client.createWindow(`${site}/opener`, { onStage: true });
    opened.push(front.windowId);

    await client.click(back.pageId, back.snapshot.refs[0]!);
    const offPopup = await until(
      async () => (await client.listWindows()).find((w) => w.tabs.some((t) => t.openerPageId === back.pageId)),
      (w) => w !== undefined,
      "the popup of the window off the screen",
    );
    await until(async () => (await window(offPopup!.windowId)).onStage, (v) => v === false, "that popup leaves the screen");
    assert.deepEqual(await onStage(), [front.windowId], "the owner's window stays alone on the screen");

    await client.click(front.pageId, front.snapshot.refs[0]!);
    const onPopup = await until(
      async () => (await client.listWindows()).find((w) => w.tabs.some((t) => t.openerPageId === front.pageId)),
      (w) => w !== undefined,
      "the popup of the window on the screen",
    );
    await Bun.sleep(500);
    assert.equal((await window(onPopup!.windowId)).onStage, true, "a sign-in popup of the owner's window stays where the owner is");
    opened.push(offPopup!.windowId, onPopup!.windowId);
  }, 60_000);

  test("when the window on the screen closes, the one worked in last takes its place", async () => {
    const a = await client.createWindow(`${site}/one`);
    const b = await client.createWindow(`${site}/two`, { onStage: true });
    opened.push(a.windowId);
    await client.focusTab(a.pageId);
    await client.closeWindow(b.windowId);
    await until(onStage, (ids) => ids.length === 1, "the screen is filled again");
    assert.deepEqual(await onStage(), [a.windowId]);
  }, 60_000);

  test("a window says which tab it shows: the one brought forward last", async () => {
    const w = await client.createWindow(`${site}/one`);
    opened.push(w.windowId);
    const second = await client.navigate(`${site}/two`, { windowId: w.windowId, newTab: true });
    let tabs = (await window(w.windowId)).tabs;
    assert.equal(tabs.find((t) => t.active)?.pageId, second.pageId, "a new tab is the one its window shows");
    await client.focusTab(w.pageId);
    tabs = (await window(w.windowId)).tabs;
    assert.equal(tabs.find((t) => t.active)?.pageId, w.pageId);
  }, 60_000);

  test("a window off the screen streams, a tap lands in a cross-origin frame as a real click, text and keys go in", async () => {
    const w = await client.createWindow(`${site}/page`);
    opened.push(w.windowId);
    assert.equal((await window(w.windowId)).onStage, false);
    const live = cast([{ pageId: w.pageId }]);
    await live.ready;
    const first = await until(async () => live.frames.length, (n) => n > 0, "a first picture");
    assert.ok(first > 0);
    const { width, height } = live.frames[0]!;
    assert.ok(width > 1000 && height > 500, `the picture carries the viewport (${width}x${height})`);

    // The iframe starts 100 px down; its button spans 0..200 x 0..80, its field 200..500 x 20..60.
    await Bun.sleep(500);
    await client.input(w.pageId, { kind: "tap", x: 100 / width, y: 140 / height });
    await client.input(w.pageId, { kind: "tap", x: 350 / width, y: 140 / height });
    await client.input(w.pageId, { kind: "text", text: "héllo 日本" });
    await client.input(w.pageId, { kind: "key", key: "Enter" });
    await until(async () => heard.length, (n) => n >= 2, "the page heard the click and the Enter");
    assert.deepEqual(heard.slice(0, 2), ["click true", "enter héllo 日本 true"]);

    // A wheel scrolls asynchronously (smooth scrolling): wait for the page, not for a picture, since
    // the caret blinking in the field repaints on its own.
    await client.input(w.pageId, { kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 900 });
    await until(async () => Number((await client.evaluate(w.pageId, "return scrollY")).value), (y) => y > 0, "the wheel scrolls the page");

    await client.input(w.pageId, { kind: "key", key: "a", modifiers: ["Control"] });
    const refused = await client.input(w.pageId, { kind: "key", key: "not a key!" }).then(() => "", (e: Error) => e.message);
    assert.match(refused, /Not a key/);

    await client.closeWindow(w.windowId);
    await until(async () => live.gone, (g) => g.includes(w.pageId), "the closed tab is announced");
    live.socket.close();
    opened.splice(opened.indexOf(w.windowId), 1);
  }, 60_000);

  test("the owner navigates a tab: an address, back, forward, reload", async () => {
    const w = await client.createWindow(`${site}/one`);
    opened.push(w.windowId);
    assert.equal((await client.go(w.pageId, { action: "goto", url: `${other}/two` })).url, `${other}/two`);
    await client.go(w.pageId, { action: "back" });
    await until(async () => (await window(w.windowId)).tabs[0]!.url, (u) => u === `${site}/one`, "back");
    await client.go(w.pageId, { action: "forward" });
    await until(async () => (await window(w.windowId)).tabs[0]!.url, (u) => u === `${other}/two`, "forward");
    await client.go(w.pageId, { action: "reload" });
    const refused = await client.go(w.pageId, { action: "goto", url: "file:///etc/passwd" }).then(() => "", (e: Error) => e.message);
    assert.match(refused, /file:\/\//);
  }, 60_000);

  // The whole path a phone uses: the channel's live view, the server's relay, the sidecar's socket.
  test("a device watching through the server gets the listing, the pictures, and its taps land", async () => {
    const session = new BrowserSession({ browser: { enabled: true, sidecarUrl: SIDECAR_URL } } as MyClawConfig);
    const live = new BrowserLive(() => session);
    const device = { getBufferedAmount: () => 0 };
    const got: MyClawAppServerFrame[] = [];
    const w = await client.createWindow(`${site}/page`);
    opened.push(w.windowId);
    heard.length = 0;

    live.watch(device, { type: "browser.watch", windows: true, streams: [{ pageId: w.pageId, quality: "focus" }] }, (f) => got.push(f));
    const listing = await until(
      async () => got.find((f) => f.type === "browser.windows.result"),
      (f) => f !== undefined,
      "the listing",
    );
    const mine = listing!.type === "browser.windows.result" ? listing!.windows.find((x) => x.windowId === w.windowId) : undefined;
    assert.ok(mine, "the new window is listed");
    assert.equal(mine!.state, "free");
    assert.equal(mine!.onStage, false);
    assert.ok(mine!.tabs.some((t) => t.pageId === w.pageId && t.active));

    const picture = await until(async () => got.find((f) => f.type === "browser.frame"), (f) => f !== undefined, "a picture relayed");
    assert.ok(picture!.type === "browser.frame" && picture!.data.length > 100 && picture!.width > 1000);

    await Bun.sleep(400);
    const width = picture!.type === "browser.frame" ? picture!.width : 1;
    const height = picture!.type === "browser.frame" ? picture!.height : 1;
    await live.input({ type: "browser.input", pageId: w.pageId, ts: Date.now(), input: { kind: "tap", x: 100 / width, y: 140 / height } }, (f) => got.push(f));
    await until(async () => heard.length, (n) => n >= 1, "the tap relayed to the page");
    assert.equal(heard[0], "click true");

    await live.control({ type: "browser.control", id: "s", action: "stage", windowId: w.windowId }, (f) => got.push(f));
    assert.ok(got.some((f) => f.type === "browser.control.result" && f.id === "s" && f.ok));
    await until(
      async () => got.filter((f) => f.type === "browser.windows.result").at(-1),
      (f) => f?.type === "browser.windows.result" && f.windows.find((x) => x.windowId === w.windowId)?.onStage === true,
      "the listing says the window is on the VNC screen",
    );
    live.drop(device);
  }, 60_000);
});
