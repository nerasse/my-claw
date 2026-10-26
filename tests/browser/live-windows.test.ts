// The live view's window placement, against a fake CDP: the sidecar's own rules, without a browser.
//
// A window keeps the size it is born with, and a site chooses that size for the popups it opens:
// `window.open(url, "", "width=500,height=600")` gave one window -- and the tile the app drew for
// it -- a portrait shape for the rest of its life, in a wall of landscapes (measured on Chromium
// 147, 2026-10-25: nothing resized a popup, ever). Playwright masks this in the e2e suite: with it
// attached, Chromium opens such a popup at its parent's size, so these tests are the only place
// the rule can be seen to hold.
//
// The sidecar runs under Node and talks CDP; this file stubs `browser.mjs` and imports `live.mjs`
// as it is, so what is tested is the code that ships.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const STAGE = { width: 1920, height: 1080 };
const OFFSTAGE_LEFT = STAGE.width + 2000;

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: "normal" | "minimized" | "maximized";
}

/** The browser's own state: one bounds record per window, and every placement it was told. */
const windows = new Map<number, Bounds>();
const placed: Array<{ windowId: number; bounds: Partial<Bounds> }> = [];
let targets: Array<{ id: string }> = [];
/** The window each page lives in, and the window a page's opener lives in. */
let windowOfPage: (pageId: string) => number | undefined = () => undefined;
let openerOf: (pageId: string) => string | undefined = () => undefined;

function reset(): void {
  windows.clear();
  placed.length = 0;
  targets = [];
  windowOfPage = () => undefined;
  openerOf = () => undefined;
}

// A window that fills the screen is one pixel smaller on each axis once Chromium has placed it:
// measured on Chromium 147, and what the "is it the standard size" test has to allow for.
function clamped(bounds: Partial<Bounds>): Partial<Bounds> {
  return {
    ...bounds,
    ...(bounds.width === STAGE.width ? { width: STAGE.width - 1 } : {}),
    ...(bounds.height === STAGE.height ? { height: STAGE.height - 1 } : {}),
  };
}

mock.module("../../sidecar/browser.mjs", () => ({
  CDP_URL: "http://127.0.0.1:9222",
  browserSession: async () => ({
    send: async (method: string, params: Record<string, any>) => {
      switch (method) {
        case "Browser.getWindowForTarget": {
          const windowId = windowOfPage(params["targetId"]);
          if (windowId === undefined) throw new Error("no such target");
          return { windowId };
        }
        case "Browser.getWindowBounds": {
          const bounds = windows.get(params["windowId"]);
          if (!bounds) throw new Error("no such window");
          return { bounds };
        }
        case "Browser.setWindowBounds": {
          placed.push({ windowId: params["windowId"], bounds: params["bounds"] });
          const current = windows.get(params["windowId"])!;
          if (params["bounds"].windowState) {
            current.windowState = params["bounds"].windowState;
            return {};
          }
          Object.assign(current, clamped(params["bounds"]));
          return {};
        }
        default:
          throw new Error(`unexpected CDP call: ${method}`);
      }
    },
  }),
  frontOf: () => 0,
  getPage: async (pageId: string) => ({ opener: async () => null, pageId }),
  // A page as Playwright hands it back to `page.opener()`: the id the sidecar gave it, which is
  // what tells the placement whose popup it is.
  idOf: (page: { id?: string } | undefined) => page?.id,
  pageHooks: {},
  pageTargets: async () => targets,
  windowOf: async (pageId: string) => {
    const windowId = windowOfPage(pageId);
    if (windowId === undefined) throw new Error("no such window");
    return windowId;
  },
}));

const live = await import("../../sidecar/live.mjs");

/** A window as the browser has it, with one page in it. */
function aWindow(id: number, bounds: Partial<Bounds>): void {
  windows.set(id, { left: 0, top: 0, width: STAGE.width, height: STAGE.height, windowState: "normal", ...bounds });
  targets.push({ id: `page-${id}` });
  const known = windowOfPage;
  windowOfPage = (pageId) => (pageId === `page-${id}` ? id : known(pageId));
}

beforeEach(() => reset());

describe("the size every window works at", () => {
  test("a window a site sized itself is put back, so its tile is the wall's shape", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    // The popup a site's `window.open(..., "width=500,height=600")` opened: born portrait, and
    // nothing in the sidecar ever resized it.
    aWindow(7, { left: OFFSTAGE_LEFT, width: 500, height: 600 });

    await live.settleWindows();

    expect(windows.get(7)).toMatchObject({ left: OFFSTAGE_LEFT, top: 0, width: STAGE.width - 1, height: STAGE.height - 1 });
  });

  test("a window born at the standard size is left alone, so nothing moves under the owner's eyes", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(1, { width: STAGE.width - 1, height: STAGE.height - 1 });

    await live.settleWindows();

    expect(placed).toHaveLength(0);
  });

  test("a window on the screen keeps the screen, and takes the standard size there", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(3, { left: 0, top: 0, width: 500, height: 600 });

    await live.settleWindows();

    expect([...(await live.stagedWindows())]).toEqual([3]);
    expect(placed).toEqual([{ windowId: 3, bounds: { left: 0, top: 0, width: STAGE.width, height: STAGE.height } }]);
  });

  test("a window the owner resized by hand stays where he put it", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(4, { left: OFFSTAGE_LEFT, width: STAGE.width - 1, height: STAGE.height - 1 });
    // Settled at birth: from here on the rule has had its say about this window.
    await live.settleWindows();
    placed.length = 0;
    // He drags its corner in VNC, which the wall has no business undoing.
    windows.get(4)!.width = 1200;
    windows.get(4)!.height = 900;

    await live.settleWindows();

    expect(placed).toHaveLength(0);
  });

  test("a minimized window is left alone: its bounds are stale, and it takes no placement", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(5, { left: OFFSTAGE_LEFT, width: 500, height: 600, windowState: "minimized" });

    await live.settleWindows();

    expect(placed).toHaveLength(0);
  });

  test("the standard size is the server's viewport, not the screen's", async () => {
    // A config that asks for another size: every window follows it, and a window filling the
    // screen is no longer the standard one.
    live.standardSize({ width: 1600, height: 900 });
    aWindow(6, { left: OFFSTAGE_LEFT, width: STAGE.width - 1, height: STAGE.height - 1 });

    await live.settleWindows();

    expect(placed).toEqual([{ windowId: 6, bounds: { left: OFFSTAGE_LEFT, top: 0, width: 1600, height: 900 } }]);
  });

  test("a viewport the server did not state is not a size: the screen's stands", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    expect(live.standardSize(undefined)).toEqual({ width: 1920, height: 1080 });
    expect(live.standardSize({ width: 0, height: 0 })).toEqual({ width: 1920, height: 1080 });
  });
});

describe("a popup", () => {
  test("of a window off the screen takes the standard size and stays off it", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(1, { left: OFFSTAGE_LEFT, width: STAGE.width - 1, height: STAGE.height - 1 });
    // The site's popup: born 500x600, and Chromium puts it where new windows go.
    aWindow(9, { left: OFFSTAGE_LEFT, top: 0, width: 500, height: 600 });

    await live.keepOffStage(null as never, "page-9");

    expect(windows.get(9)).toMatchObject({ left: OFFSTAGE_LEFT, width: STAGE.width - 1, height: STAGE.height - 1 });
  });

  test("of the window on the screen stands where the owner is, at the standard size", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(1, { left: 0, top: 0, width: STAGE.width - 1, height: STAGE.height - 1 });
    // A "sign in with" popup during a captcha: it belongs on the screen, over the page the owner
    // is working in -- but at the size the wall draws, not the 500x600 its site asked for.
    aWindow(10, { left: 0, top: 0, width: 500, height: 600 });

    await live.keepOffStage({ opener: async () => ({ id: "page-1" }) } as never, "page-10");

    expect(windows.get(10)).toMatchObject({ left: 0, top: 0, width: STAGE.width - 1, height: STAGE.height - 1 });
  });
});

describe("staging", () => {
  test("puts one window on the screen and every other one off it, all at the standard size", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(1, { left: 0, top: 0, width: 500, height: 600 });
    aWindow(2, { left: OFFSTAGE_LEFT, width: 500, height: 600 });

    await live.stage(2);

    // The screen's size is given back one pixel short by Chromium itself, which is why a window is
    // "at the standard size" within a pixel rather than exactly.
    expect(windows.get(2)).toMatchObject({ left: 0, top: 0, width: STAGE.width - 1, height: STAGE.height - 1 });
    expect(windows.get(1)).toMatchObject({ left: OFFSTAGE_LEFT, width: STAGE.width - 1, height: STAGE.height - 1 });
  });

  test("refuses a window the browser does not have", async () => {
    live.standardSize({ width: 1920, height: 1080 });
    aWindow(1, {});
    await expect(live.stage(99)).rejects.toThrow(/no window 99/);
  });
});
