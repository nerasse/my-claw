/**
 * Windows kept after a browsing task (docs/browser-windows.md). The case that made them: a run
 * stops at the screen of an e-mail code, the conversation that sent it reads the mail and sends it
 * back to the same window -- minutes, or days, later. Before, only a human handoff kept a window,
 * for thirty minutes, in memory: any other end let the next task take the tab, and a restart freed
 * everything.
 */

import { describe, expect, test } from "bun:test";
import {
  BrowserWindows,
  DEFAULT_HOLD_POLICY,
  holderOf,
  type BrowserWindowView,
  type HoldPolicy,
  type HoldStore,
  type WindowHold,
  type WindowsBackend,
} from "../../src/tools/browser/windows.ts";
import { createBrowserDoneTool, holdPolicyOf, takeBrowserOutcome } from "../../src/tools/browser/session.ts";
import { createHeldBrowserWindowsTool } from "../../src/tools/browser/held.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

function browser(initial: BrowserWindowView[]) {
  let windows = structuredClone(initial);
  const backend: WindowsBackend = {
    listWindows: async () => structuredClone(windows),
    createWindow: async (url) => {
      const windowId = 500 + windows.length;
      windows.push({ windowId, tabs: [{ pageId: `p${windowId}`, url, title: "" }] });
      return { windowId, pageId: `p${windowId}`, url, snapshot: { raw: "", refs: [] } };
    },
    closeWindow: async (id) => {
      windows = windows.filter((w) => w.windowId !== id);
    },
    closeTab: async () => {},
    focusTab: async () => {},
  };
  return { backend, set: (next: BrowserWindowView[]) => (windows = structuredClone(next)) };
}

function memoryStore(initial: WindowHold[] = []): HoldStore & { holds: WindowHold[] } {
  const store = {
    holds: structuredClone(initial),
    load: () => structuredClone(store.holds),
    save: (holds: WindowHold[]) => {
      store.holds = structuredClone(holds);
    },
  };
  return store;
}

const hellowork = (windowId: number, page = "h1"): BrowserWindowView => ({
  windowId,
  tabs: [{ pageId: page, url: "https://www.hellowork.com/fr-fr/candidature/code", title: "Code" }],
});
const other = (windowId: number): BrowserWindowView => ({
  windowId,
  tabs: [{ pageId: `o${windowId}`, url: "https://example.com/", title: "Other" }],
});
const call = (session: string, window: number) => ({ __sessionId: session, window });
const HOUR = 3_600_000;

describe("a run keeps its window without a human", () => {
  test("kept for the conversation that sent it: refused to others, offered to it", async () => {
    const b = browser([hellowork(11), other(12)]);
    const w = new BrowserWindows(b.backend, () => 1_000, memoryStore());
    w.beginRun("run-1", "my-claw-app/thread/neras/career");
    await w.page(call("run-1", 1));
    expect(w.endRun("run-1", { reason: "kept", ms: 72 * HOUR })).toEqual({ windowIds: [11], until: 1_000 + 72 * HOUR });

    w.beginRun("intruder", "my-claw-app/thread/neras/other");
    await expect(w.page(call("intruder", 1))).rejects.toThrow("kept for another conversation");

    // What the next task of the same conversation is handed before it starts.
    expect(await w.describe("", "my-claw-app/thread/neras/career")).toContain("Window 1 (kept for you: continue here");
    w.beginRun("run-2", "my-claw-app/thread/neras/career");
    expect(await w.page(call("run-2", 1))).toBe("h1");
  });

  test("a run that ends any other way gives its window back", async () => {
    const b = browser([hellowork(11)]);
    const w = new BrowserWindows(b.backend, () => 1_000, memoryStore());
    w.beginRun("run-1", "conv");
    await w.page(call("run-1", 1));
    expect(w.endRun("run-1")).toBeUndefined();
    w.beginRun("next", "someone-else");
    expect(await w.page(call("next", 1))).toBe("h1");
  });

  test("the next run of the same scheduled job counts as the same conversation", async () => {
    expect(holderOf("cron/abcda62e67c2/1790526680364")).toBe("cron/abcda62e67c2");
    const b = browser([hellowork(11)]);
    const w = new BrowserWindows(b.backend, () => 1_000, memoryStore());
    w.beginRun("b1", "cron/abcda62e67c2/1790526680364");
    await w.page(call("b1", 1));
    w.endRun("b1", { reason: "kept" });
    w.beginRun("b2", "cron/abcda62e67c2/1790548280000");
    expect(await w.page(call("b2", 1))).toBe("h1");
  });

  test("the duration is capped at the maximum, and the default applies when none is named", async () => {
    const policy: HoldPolicy = { defaultMs: 2 * HOUR, maxMs: 7 * 24 * HOUR, maxWindows: 8 };
    const b = browser([hellowork(11), other(12)]);
    const w = new BrowserWindows(b.backend, () => 0, memoryStore(), () => policy);
    w.beginRun("a", "conv-a");
    await w.page(call("a", 1));
    expect(w.endRun("a", { reason: "kept", ms: 30 * 24 * HOUR })?.until).toBe(7 * 24 * HOUR);
    w.beginRun("b", "conv-b");
    await w.page(call("b", 2));
    expect(w.endRun("b", { reason: "kept" })?.until).toBe(2 * HOUR);
  });

  test("past the maximum number kept, the extra windows are given back", async () => {
    const b = browser([hellowork(11), other(12), other(13)]);
    const w = new BrowserWindows(b.backend, () => 0, memoryStore(), () => ({ ...DEFAULT_HOLD_POLICY, maxWindows: 2 }));
    w.beginRun("a", "conv-a");
    await w.page(call("a", 1));
    w.endRun("a", { reason: "kept" });
    expect(w.keepRoom()).toBe(1);
    w.beginRun("b", "conv-b");
    await w.page(call("b", 2));
    await w.page(call("b", 3));
    expect(w.endRun("b", { reason: "kept" })?.windowIds).toHaveLength(1);
    expect(w.keepRoom()).toBe(0);
  });
});

describe("kept windows survive a restart", () => {
  test("a restart of my-claw: the same window, still kept", async () => {
    const store = memoryStore();
    const b = browser([hellowork(11), other(12)]);
    const before = new BrowserWindows(b.backend, () => 1_000, store);
    before.beginRun("run-1", "conv");
    await before.page(call("run-1", 1));
    before.endRun("run-1", { reason: "kept", ms: 48 * HOUR });
    expect(store.holds).toHaveLength(1);

    const after = new BrowserWindows(b.backend, () => 2_000, store);
    after.beginRun("intruder", "someone-else");
    await expect(after.page(call("intruder", 1))).rejects.toThrow("kept for another conversation");
  });

  test("a restart of the browser: the restored window with the same pages is the kept one", async () => {
    const store = memoryStore([
      { windowId: 11, holder: "conv", until: 10 * HOUR, since: 0, reason: "kept", urls: ["https://www.hellowork.com/fr-fr/candidature/code"] },
    ]);
    // Chromium came back from its session: new window ids, the same pages.
    const b = browser([other(41), hellowork(42, "restored")]);
    const w = new BrowserWindows(b.backend, () => 1_000, store);
    const kept = await w.kept();
    expect(kept.map((h) => h.windowId)).toEqual([42]);
    expect(store.holds[0]!.windowId).toBe(42);

    w.beginRun("intruder", "someone-else");
    await expect(w.page(call("intruder", 2))).rejects.toThrow("kept for another conversation");
    w.beginRun("mine", "conv");
    expect(await w.page(call("mine", 2))).toBe("restored");
  });

  test("an expired hold is dropped at the next read", async () => {
    const store = memoryStore([
      { windowId: 11, holder: "conv", until: 500, since: 0, reason: "kept", urls: [] },
    ]);
    const w = new BrowserWindows(browser([hellowork(11)]).backend, () => 1_000, store);
    expect(await w.kept()).toEqual([]);
    expect(store.holds).toEqual([]);
  });
});

describe("releasing", () => {
  test("a conversation releases its own windows, not another's; the owner releases any", async () => {
    const store = memoryStore();
    const b = browser([hellowork(11), other(12)]);
    const w = new BrowserWindows(b.backend, () => 0, store);
    w.beginRun("a", "conv-a");
    await w.page(call("a", 1));
    w.endRun("a", { reason: "kept" });
    w.beginRun("b", "conv-b");
    await w.page(call("b", 2));
    w.endRun("b", { reason: "kept" });

    const tool = createHeldBrowserWindowsTool(w);
    const listed = await tool.execute({ action: "list", __sessionId: "conv-a" });
    expect(listed.output).toContain("Window 1: kept to continue");
    expect(listed.output).toContain("yours");
    expect(listed.output).toContain("another conversation's");

    expect((await tool.execute({ action: "release", window: 2, __sessionId: "conv-a" })).success).toBe(false);
    expect((await tool.execute({ action: "release", window: 1, __sessionId: "conv-a" })).success).toBe(true);
    expect(store.holds.map((h) => h.holder)).toEqual(["conv-b"]);

    expect(await w.release({ all: true })).toBe(1);
    expect(store.holds).toEqual([]);
  });
});

describe("browser_done", () => {
  test("keep_window records the request with its duration, capped at the owner's maximum", async () => {
    const done = createBrowserDoneTool(() => ({ ...DEFAULT_HOLD_POLICY, maxMs: 7 * 24 * HOUR }), () => 3);
    const result = await done.execute({ __sessionId: "run-x", summary: "stopped at the code screen", keep_window: true, hold: "10d" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("kept for the conversation that sent you");
    expect(result.output).toContain("owner's maximum");
    expect(takeBrowserOutcome("run-x")).toMatchObject({ keepWindow: true, keepMs: 7 * 24 * HOUR, needsHuman: false });
  });

  test("with nothing left to keep, it says so", async () => {
    const done = createBrowserDoneTool(() => DEFAULT_HOLD_POLICY, () => 0);
    const result = await done.execute({ __sessionId: "run-y", summary: "s", keep_window: true });
    expect(result.output).toContain("No window can be kept right now");
    takeBrowserOutcome("run-y");
  });

  test("an unreadable duration is refused, not turned into zero", async () => {
    const done = createBrowserDoneTool();
    expect((await done.execute({ __sessionId: "run-z", summary: "s", hold: "a while" })).success).toBe(false);
  });

  test("the policy is read from the config, with defaults for what it does not say", () => {
    expect(holdPolicyOf({ browser: { holdDefault: "2h", holdMax: "7d", holdMaxWindows: 3 } } as MyClawConfig)).toEqual({
      defaultMs: 2 * HOUR,
      maxMs: 7 * 24 * HOUR,
      maxWindows: 3,
    });
    expect(holdPolicyOf({} as MyClawConfig)).toEqual(DEFAULT_HOLD_POLICY);
    // A default above the ceiling is the ceiling.
    expect(holdPolicyOf({ browser: { holdDefault: "10d", holdMax: "3d" } } as MyClawConfig).defaultMs).toBe(3 * 24 * HOUR);
  });
});
