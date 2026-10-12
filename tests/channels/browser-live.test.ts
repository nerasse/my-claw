import { describe, expect, test } from "bun:test";
import { BrowserLive, INPUT_STALE_MS, MAX_BUFFERED_BYTES, parseInput, withScheme } from "../../src/channels/my-claw-app/browser-live.ts";
import type { CastEvent, CastStream } from "../../src/browser/cast.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";
import type { BrowserSession } from "../../src/tools/browser/session.ts";
import type { WindowOverview } from "../../src/tools/browser/windows.ts";

/** The browser the live view talks to, recording every call. */
function fakeBrowser(windows: WindowOverview[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const watches = new Map<object, { streams: CastStream[]; deliver: (e: CastEvent) => void }>();
  let listings = 0;
  let failWith: string | undefined;
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (failWith) throw new Error(failWith);
    return method === "go" ? { url: "" } : undefined;
  };
  const session = {
    client: {
      input: record("input"),
      stage: record("stage"),
      createWindow: record("createWindow"),
      focusTab: record("focusTab"),
      closeTab: record("closeTab"),
      closeWindow: record("closeWindow"),
      go: record("go"),
    },
    windows: {
      async overview() {
        listings += 1;
        return windows;
      },
    },
    cast: {
      watch(w: object, streams: CastStream[], deliver: (e: CastEvent) => void) {
        if (streams.length === 0) watches.delete(w);
        else watches.set(w, { streams, deliver });
      },
      unwatch(w: object) {
        watches.delete(w);
      },
    },
  };
  return {
    session: session as unknown as BrowserSession,
    calls,
    watches,
    listings: () => listings,
    fail(message: string | undefined) {
      failWith = message;
    },
    setWindows(next: WindowOverview[]) {
      windows.splice(0, windows.length, ...next);
    },
  };
}

function socket(buffered = 0) {
  return { buffered, getBufferedAmount() { return this.buffered; } };
}

const win = (alias: number, extra: Partial<WindowOverview> = {}): WindowOverview => ({
  alias,
  windowId: 100 + alias,
  onStage: false,
  state: "free",
  tabs: [{ pageId: `p${alias}`, title: "t", url: "https://a.test", active: true }],
  ...extra,
});

describe("parseInput", () => {
  test("taps, the mouse, the wheel, text and keys are taken as they are", () => {
    expect(parseInput({ kind: "tap", x: 0.5, y: 0.25 })).toEqual({ kind: "tap", x: 0.5, y: 0.25 });
    expect(parseInput({ kind: "tap", x: 0, y: 1, button: "right", double: true })).toEqual({ kind: "tap", x: 0, y: 1, button: "right", double: true });
    expect(parseInput({ kind: "move", x: 0.1, y: 0.1 })).toEqual({ kind: "move", x: 0.1, y: 0.1 });
    expect(parseInput({ kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -300 })).toEqual({ kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -300 });
    expect(parseInput({ kind: "text", text: "héllo 日本" })).toEqual({ kind: "text", text: "héllo 日本" });
    expect(parseInput({ kind: "key", key: "a", modifiers: ["Control", "Hyper"] })).toEqual({ kind: "key", key: "a", modifiers: ["Control"] });
  });

  test("anything off the picture or malformed is refused", () => {
    expect(parseInput({ kind: "tap", x: 1.2, y: 0.5 })).toBeUndefined();
    expect(parseInput({ kind: "tap", x: "0.5", y: 0.5 })).toBeUndefined();
    expect(parseInput({ kind: "wheel", x: 0.5, y: 0.5, dx: Number.NaN, dy: 1 })).toBeUndefined();
    expect(parseInput({ kind: "text", text: "" })).toBeUndefined();
    expect(parseInput({ kind: "eval", js: "1" })).toBeUndefined();
    expect(parseInput(null)).toBeUndefined();
  });
});

describe("withScheme", () => {
  test("an address typed without its scheme gets https, one with a scheme is left alone", () => {
    expect(withScheme("example.com/a")).toBe("https://example.com/a");
    expect(withScheme("localhost:3000")).toBe("https://localhost:3000");
    expect(withScheme("http://intranet")).toBe("http://intranet");
    expect(withScheme("about:blank")).toBe("about:blank");
  });
});

describe("BrowserLive", () => {
  test("a device that watches the listing gets it at once, then only when it changes", async () => {
    const b = fakeBrowser([win(1)]);
    const live = new BrowserLive(() => b.session);
    const sent: MyClawAppServerFrame[] = [];
    const ws = socket();
    live.watch(ws, { type: "browser.watch", windows: true, streams: [] }, (f) => sent.push(f));
    await live.list();
    await live.list();
    expect(sent.filter((f) => f.type === "browser.windows.result").length).toBe(1);
    b.setWindows([win(1, { state: "working", task: "apply to the job" })]);
    await live.list();
    const listings = sent.filter((f) => f.type === "browser.windows.result");
    expect(listings.length).toBe(2);
    expect(listings[1]).toMatchObject({ windows: [{ alias: 1, state: "working", task: "apply to the job" }] });
    live.drop(ws);
  });

  test("two devices share one read of the listing", async () => {
    const b = fakeBrowser([win(1)]);
    const live = new BrowserLive(() => b.session);
    const a = socket();
    const c = socket();
    live.watch(a, { type: "browser.watch", windows: true, streams: [] }, () => undefined);
    live.watch(c, { type: "browser.watch", windows: true, streams: [] }, () => undefined);
    await live.list();
    const before = b.listings();
    await Promise.all([live.list(), live.list()]);
    expect(b.listings() - before).toBe(1);
    live.drop(a);
    live.drop(c);
  });

  test("pictures go to the device that watches them, and a device with a backlog is skipped", () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const sent: MyClawAppServerFrame[] = [];
    const ws = socket();
    live.watch(ws, { type: "browser.watch", windows: false, streams: [{ pageId: "p1", quality: "focus" }] }, (f) => sent.push(f));
    const watch = b.watches.get(ws)!;
    expect(watch.streams).toEqual([{ pageId: "p1", preset: "focus" }]);
    watch.deliver({ type: "frame", frame: { pageId: "p1", seq: 1, data: "A", width: 10, height: 5 } });
    ws.buffered = MAX_BUFFERED_BYTES + 1;
    watch.deliver({ type: "frame", frame: { pageId: "p1", seq: 2, data: "B", width: 10, height: 5 } });
    watch.deliver({ type: "gone", pageId: "p1" });
    expect(sent).toEqual([
      { type: "browser.frame", pageId: "p1", seq: 1, data: "A", width: 10, height: 5 },
      { type: "browser.frame.gone", pageId: "p1" },
    ]);
  });

  test("a wall on a wide screen is streamed at the size it draws, and the phone keeps its small tile", () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const wall = socket();
    const phone = socket();
    live.watch(wall, { type: "browser.watch", windows: false, streams: [{ pageId: "p1", quality: "tile-large" }] }, () => undefined);
    live.watch(phone, { type: "browser.watch", windows: false, streams: [{ pageId: "p1", quality: "tile" }, { pageId: "p2", quality: "tile-large" }] }, () => undefined);

    expect(b.watches.get(wall)!.streams).toEqual([{ pageId: "p1", preset: "tile-large" }]);
    expect(b.watches.get(phone)!.streams).toEqual([
      { pageId: "p1", preset: "tile" },
      { pageId: "p2", preset: "tile-large" },
    ]);
  });

  test("a window shown large on a wide screen is streamed at the page's own size", () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const desk = socket();
    live.watch(desk, { type: "browser.watch", windows: false, streams: [{ pageId: "p1", quality: "focus-large" }] }, () => undefined);

    expect(b.watches.get(desk)!.streams).toEqual([{ pageId: "p1", preset: "focus-large" }]);
  });

  // A device from an older build, or a frame that got garbled: a tile, never nothing.
  test("an unknown quality is watched as a tile", () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const ws = socket();
    live.watch(ws, { type: "browser.watch", windows: false, streams: [{ pageId: "p1", quality: "huge" as "tile" }] }, () => undefined);
    expect(b.watches.get(ws)!.streams).toEqual([{ pageId: "p1", preset: "tile" }]);
  });

  test("watching nothing, or leaving, stops the pictures", () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const ws = socket();
    live.watch(ws, { type: "browser.watch", windows: true, streams: [{ pageId: "p1", quality: "tile" }] }, () => undefined);
    expect(b.watches.size).toBe(1);
    live.watch(ws, { type: "browser.watch", windows: false, streams: [] }, () => undefined);
    expect(b.watches.size).toBe(0);
    live.watch(ws, { type: "browser.watch", windows: false, streams: [{ pageId: "p1", quality: "tile" }] }, () => undefined);
    live.drop(ws);
    expect(b.watches.size).toBe(0);
  });

  test("an input reaches the tab, and one the outbox replays late is dropped", async () => {
    let clock = 100_000;
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session, () => clock);
    await live.input({ type: "browser.input", pageId: "p1", ts: clock - 100, input: { kind: "tap", x: 0.5, y: 0.5 } }, () => undefined);
    await live.input({ type: "browser.input", pageId: "p1", ts: clock - INPUT_STALE_MS - 1, input: { kind: "tap", x: 0.5, y: 0.5 } }, () => undefined);
    clock += 1;
    await live.input({ type: "browser.input", pageId: "p1", ts: clock, input: { kind: "eval" } as never }, () => undefined);
    expect(b.calls).toEqual([{ method: "input", args: ["p1", { kind: "tap", x: 0.5, y: 0.5 }] }]);
  });

  test("an input that fails says why", async () => {
    const b = fakeBrowser();
    b.fail("The tab stopped responding: its page is frozen");
    const live = new BrowserLive(() => b.session);
    const sent: MyClawAppServerFrame[] = [];
    await live.input({ type: "browser.input", pageId: "p1", ts: Date.now(), input: { kind: "text", text: "x" } }, (f) => sent.push(f));
    expect(sent).toEqual([{ type: "browser.control.result", ok: false, error: "The tab stopped responding: its page is frozen" }]);
  });

  test("each control reaches the browser, answered with its id", async () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const sent: MyClawAppServerFrame[] = [];
    const send = (f: MyClawAppServerFrame) => sent.push(f);
    await live.control({ type: "browser.control", id: "1", action: "stage", windowId: 7 }, send);
    await live.control({ type: "browser.control", id: "2", action: "new_window", url: "example.com" }, send);
    await live.control({ type: "browser.control", id: "3", action: "focus_tab", pageId: "p1" }, send);
    await live.control({ type: "browser.control", id: "4", action: "close_tab", pageId: "p1" }, send);
    await live.control({ type: "browser.control", id: "5", action: "close_window", windowId: 7 }, send);
    await live.control({ type: "browser.control", id: "6", action: "back", pageId: "p1" }, send);
    await live.control({ type: "browser.control", id: "7", action: "goto", pageId: "p1", url: "news.test" }, send);
    expect(b.calls.map((c) => [c.method, c.args])).toEqual([
      ["stage", [7]],
      ["createWindow", ["https://example.com", { onStage: true }]],
      ["focusTab", ["p1"]],
      ["closeTab", ["p1"]],
      ["closeWindow", [7]],
      ["go", ["p1", { action: "back" }]],
      ["go", ["p1", { action: "goto", url: "https://news.test" }]],
    ]);
    expect(sent.map((f) => f.type === "browser.control.result" && [f.id, f.ok])).toEqual([
      ["1", true], ["2", true], ["3", true], ["4", true], ["5", true], ["6", true], ["7", true],
    ]);
  });

  test("a control missing what it acts on, a file:// address or a failure is answered, not thrown", async () => {
    const b = fakeBrowser();
    const live = new BrowserLive(() => b.session);
    const sent: MyClawAppServerFrame[] = [];
    const send = (f: MyClawAppServerFrame) => sent.push(f);
    await live.control({ type: "browser.control", id: "a", action: "stage" }, send);
    await live.control({ type: "browser.control", id: "b", action: "new_window", url: "file:///etc/passwd" }, send);
    await live.control({ type: "browser.control", id: "b2", action: "goto", pageId: "p1", url: "FILE:///home" }, send);
    b.fail("There is no window 9 in the browser.");
    await live.control({ type: "browser.control", id: "c", action: "stage", windowId: 9 }, send);
    expect(sent).toEqual([
      { type: "browser.control.result", id: "a", ok: false, error: "Which window?" },
      { type: "browser.control.result", id: "b", ok: false, error: "file:// is not a page: the browser navigates the web." },
      { type: "browser.control.result", id: "b2", ok: false, error: "file:// is not a page: the browser navigates the web." },
      { type: "browser.control.result", id: "c", ok: false, error: "There is no window 9 in the browser." },
    ]);
    expect(b.calls.map((c) => c.method)).toEqual(["stage"]);
  });

  test("with the browser disabled, a watcher is told so and nothing is watched", () => {
    const live = new BrowserLive(() => undefined);
    const sent: MyClawAppServerFrame[] = [];
    live.watch(socket(), { type: "browser.watch", windows: true, streams: [{ pageId: "p1", quality: "tile" }] }, (f) => sent.push(f));
    expect(sent).toEqual([{ type: "browser.windows.result", windows: [], error: "The browser is disabled on this server." }]);
  });
});
