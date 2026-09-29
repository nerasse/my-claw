/**
 * Who closes a page -- docs/browser-windows.md.
 *
 * 2026-09-29: 52 tabs open, 6.2 GB, the swap full and a release build killed three times. Since
 * 24/09 a run's end only unlocked its windows, and since 27/09 nothing capped or swept them: 237
 * browser runs opened 29 windows and 173 tabs and closed 2 and 12. A page is now its run's: closed
 * once nothing needs it (its run has ended, no run works in its window, no hold keeps the window).
 * The owner's pages, and anything nobody here opened, are never closed.
 */

import { describe, expect, test } from "bun:test";
import {
  BrowserWindows,
  DEFAULT_HOLD_POLICY,
  WARN_BEFORE_MS,
  type BrowserWindowView,
  type HoldStore,
  type OwnedPage,
  type PageStore,
  type WindowHold,
  type WindowsBackend,
} from "../../src/tools/browser/windows.ts";
import { BrowserSession } from "../../src/tools/browser/session.ts";
import { hooks } from "../../src/hooks/index.ts";
import { registerRunNotifications } from "../../src/notifications/run-notifications.ts";
import { buildPushPayload, type PushNotification } from "../../src/notifications/push.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const HOUR = 3_600_000;

function fakeBrowser(initial: BrowserWindowView[] = []) {
  let windows: BrowserWindowView[] = structuredClone(initial);
  let nextWindow = 900;
  let nextPage = 1;
  const closed: string[] = [];
  const backend: WindowsBackend = {
    async listWindows() {
      return structuredClone(windows);
    },
    async createWindow(url) {
      const windowId = nextWindow++;
      const pageId = `new-${nextPage++}`;
      windows.push({ windowId, tabs: [{ pageId, url, title: "" }] });
      return { windowId, pageId, url, snapshot: { raw: "", refs: [] } };
    },
    async closeWindow(windowId) {
      closed.push(...(windows.find((w) => w.windowId === windowId)?.tabs.map((t) => t.pageId) ?? []));
      windows = windows.filter((w) => w.windowId !== windowId);
    },
    async closeTab(pageId) {
      closed.push(pageId);
      windows = windows.map((w) => ({ ...w, tabs: w.tabs.filter((t) => t.pageId !== pageId) })).filter((w) => w.tabs.length > 0);
    },
    async focusTab() {},
  };
  return {
    backend,
    closed,
    add(windowId: number, tab: BrowserWindowView["tabs"][number]) {
      windows.find((w) => w.windowId === windowId)!.tabs.push(tab);
    },
    set(next: BrowserWindowView[]) {
      windows = structuredClone(next);
    },
    get windows() {
      return windows;
    },
    ids() {
      return windows.flatMap((w) => w.tabs.map((t) => t.pageId)).sort();
    },
  };
}

function holdStore(): HoldStore & { holds: WindowHold[] } {
  const store = { holds: [] as WindowHold[], load: () => structuredClone(store.holds), save: (h: WindowHold[]) => { store.holds = structuredClone(h); } };
  return store;
}
function pageStore(): PageStore & { pages: OwnedPage[] } {
  const store = { pages: [] as OwnedPage[], load: () => structuredClone(store.pages), save: (p: OwnedPage[]) => { store.pages = structuredClone(p); } };
  return store;
}

const call = (session: string, window?: number, extra: Record<string, unknown> = {}) => ({ __sessionId: session, ...(window !== undefined ? { window } : {}), ...extra });
const ownerWindow = (): BrowserWindowView => ({ windowId: 1, tabs: [{ pageId: "owner", url: "https://owner.test/", title: "" }] });

describe("a run's pages end with it", () => {
  test("a window the run opened is closed whole, sites' popups included; the owner's is left", async () => {
    const b = fakeBrowser([ownerWindow()]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A", "conv");
    await w.describe("A");
    const { result } = await w.newWindow(call("A"), "https://jobs.test/1");
    // A tab the site opened in that window, and a popup window opened from the run's page.
    b.add(900, { pageId: "site-tab", url: "https://jobs.test/2", title: "" });
    b.set([...b.windows, { windowId: 950, tabs: [{ pageId: "popup", url: "https://sso.test/", title: "", openerPageId: result.pageId }] }]);
    await w.describe("A");
    // Nothing goes while the run works.
    expect(await w.sweep()).toBe(0);
    w.endRun("A");
    expect(await w.sweep()).toBe(3);
    expect(b.ids()).toEqual(["owner"]);
  });

  test("in a window it borrowed, only the tabs it opened go", async () => {
    const b = fakeBrowser([ownerWindow()]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A", "conv");
    await w.page(call("A", 1));
    // browser_navigate(new_tab) lands here: the navigation tool reports it as opened.
    b.add(1, { pageId: "mine", url: "https://jobs.test/", title: "" });
    w.moved(call("A"), 1, "mine", true);
    w.endRun("A");
    expect(await w.sweep()).toBe(1);
    expect(b.ids()).toEqual(["owner"]);
  });
});

describe("a kept window keeps its pages until its hold ends", () => {
  test("kept through the sweep, closed at expiry, the tab it did not open left", async () => {
    let clock = 1_000;
    const b = fakeBrowser([ownerWindow()]);
    const w = new BrowserWindows(b.backend, () => clock, holdStore());
    w.beginRun("A", "conv");
    await w.page(call("A", 1));
    b.add(1, { pageId: "form", url: "https://ashby.test/apply", title: "" });
    w.moved(call("A"), 1, "form", true);
    expect(w.endRun("A", { reason: "kept", ms: 72 * HOUR })).toBeDefined();
    expect(await w.sweep()).toBe(0);
    clock += 72 * HOUR + 1;
    expect(await w.sweep()).toBe(1);
    expect(b.ids()).toEqual(["owner"]);
  });

  test("a release closes them at once", async () => {
    const b = fakeBrowser([]);
    const w = new BrowserWindows(b.backend, Date.now, holdStore());
    w.beginRun("A", "conv");
    await w.describe("A");
    await w.newWindow(call("A"), "https://ashby.test/apply");
    w.endRun("A", { reason: "kept", ms: 72 * HOUR });
    expect(b.ids()).toEqual(["new-1"]);
    expect(await w.release({ alias: 1, holder: "conv" })).toBe(1);
    expect(b.ids()).toEqual([]);
  });

  test("the run sent back to it works in its pages: kept while it works, closed at its end", async () => {
    const b = fakeBrowser([]);
    const w = new BrowserWindows(b.backend, Date.now, holdStore());
    w.beginRun("A", "conv");
    await w.describe("A");
    await w.newWindow(call("A"), "https://hellowork.test/code");
    w.endRun("A", { reason: "kept", ms: 72 * HOUR });
    w.beginRun("B", "conv");
    await w.page(call("B", 1));
    expect(await w.sweep()).toBe(0);
    w.endRun("B");
    expect(await w.sweep()).toBe(1);
  });
});

describe("a restart does not orphan what the runs opened", () => {
  test("my-claw restarts: the pages of runs it lost are closed, a kept one is not", async () => {
    const b = fakeBrowser([]);
    const holds = holdStore();
    const pages = pageStore();
    const before = new BrowserWindows(b.backend, Date.now, holds, () => DEFAULT_HOLD_POLICY, pages);
    before.beginRun("lost", "conv");
    before.beginRun("kept", "conv");
    await before.describe("lost");
    await before.newWindow(call("lost"), "https://a.test/");
    await before.newWindow(call("kept"), "https://b.test/");
    before.endRun("kept", { reason: "kept", ms: 72 * HOUR });
    // The server dies with "lost" still running.
    const after = new BrowserWindows(b.backend, Date.now, holds, () => DEFAULT_HOLD_POLICY, pages);
    expect(await after.sweep()).toBe(1);
    expect(b.windows.map((x) => x.tabs[0]!.url)).toEqual(["https://b.test/"]);
  });

  test("the browser restarts and renumbers every page: they are found again by address", async () => {
    const b = fakeBrowser([ownerWindow()]);
    const pages = pageStore();
    const before = new BrowserWindows(b.backend, Date.now, undefined, () => DEFAULT_HOLD_POLICY, pages);
    before.beginRun("lost", "conv");
    await before.describe("lost");
    await before.newWindow(call("lost"), "https://a.test/job");
    // Chromium comes back from --restore-last-session with new ids for everything.
    b.set([
      { windowId: 7, tabs: [{ pageId: "owner-2", url: "https://owner.test/", title: "" }] },
      { windowId: 8, tabs: [{ pageId: "restored", url: "https://a.test/job", title: "" }] },
    ]);
    const after = new BrowserWindows(b.backend, Date.now, undefined, () => DEFAULT_HOLD_POLICY, pages);
    expect(await after.sweep()).toBe(1);
    expect(b.ids()).toEqual(["owner-2"]);
  });
});

describe("before a long hold closes, the owner is told once, and can keep it", () => {
  test("warned an hour before, once; a short hold never; extended, warned again later", async () => {
    let clock = 0;
    const b = fakeBrowser([ownerWindow(), { windowId: 2, tabs: [{ pageId: "x", url: "https://x.test/", title: "" }] }]);
    const w = new BrowserWindows(b.backend, () => clock, holdStore());
    w.beginRun("long", "conv");
    await w.page(call("long", 1));
    w.endRun("long", { reason: "kept", ms: 72 * HOUR });
    w.beginRun("short", "conv");
    await w.page(call("short", 2));
    w.endRun("short", { reason: "human" });
    expect(w.expiring()).toEqual([]);
    clock = 72 * HOUR - WARN_BEFORE_MS;
    expect(w.expiring().map((h) => h.windowId)).toEqual([1]);
    expect(w.expiring()).toEqual([]);
    // Kept another day: the warning comes back an hour before the new end.
    expect((await w.extend({ alias: 1, holder: "conv" }, 24 * HOUR))?.until).toBe(clock + 24 * HOUR);
    expect(await w.extend({ alias: 1, holder: "someone-else" }, HOUR)).toBeUndefined();
    clock += 24 * HOUR - WARN_BEFORE_MS;
    expect(w.expiring().map((h) => h.windowId)).toEqual([1]);
  });

  test("the notification opens the conversation that kept it and says how to keep it", async () => {
    const sent: PushNotification[] = [];
    const off = registerRunNotifications({
      titleOf: async () => "t",
      publish: async (n) => { sent.push(n); return { delivered: 1, rang: false }; },
      isForegroundOn: async () => false,
    });
    try {
      hooks.emit("browser:hold:expiring", { holder: "my-claw-app/thread/neras/career-1", alias: 3, until: Date.now() + HOUR, label: "HappyRobot application" });
      await new Promise((r) => setTimeout(r, 0));
      expect(sent[0]?.body).toContain("/windows keep 3 24h");
      expect(JSON.parse(buildPushPayload(sent[0]!)).url).toBe("myclaw://thread/career-1");
    } finally {
      off();
    }
  });
});

describe("the housekeeping tick", () => {
  test("closes frozen tabs only while no run works, and never one a human was handed", async () => {
    const paths: string[] = [];
    const mock = mockFetch(async (input) => {
      const path = String(input).split("/").pop() ?? "";
      paths.push(path);
      if (path === "list-windows") return new Response(JSON.stringify({ windows: [{ windowId: 1, tabs: [{ pageId: "cord", url: "https://cord.test/", title: "" }] }] })) as never;
      if (path === "frozen") return new Response(JSON.stringify({ frozen: [{ pageId: "cord", url: "https://cord.test/", title: "" }] })) as never;
      return new Response("{}") as never;
    });
    try {
      const session = new BrowserSession({ browser: { enabled: true } } as MyClawConfig, holdStore(), pageStore());
      session.beginRun("busy", "conv");
      expect(await session.housekeep()).toEqual({ closed: 0, frozen: 0 });
      expect(paths).not.toContain("frozen");
      await session.endRun("busy");
      expect((await session.housekeep()).frozen).toBe(1);
      expect(paths).toContain("close-target");
    } finally {
      mock.restore();
    }
  });
});
