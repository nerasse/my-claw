import { describe, expect, test } from "bun:test";
import {
  BrowserWindows,
  HANDOFF_HOLD_MS,
  MAX_AGENT_WINDOWS,
  SWEEP_ABOVE_TABS,
  SWEEP_IDLE_MS,
  type BrowserWindowView,
  type WindowsBackend,
} from "../../src/tools/browser/windows.ts";
import { isBrowserInfraError } from "../../src/tools/browser/session.ts";

/** A browser in memory: windows and tabs the tests arrange, and a record of what was closed. */
function fakeBrowser(initial: BrowserWindowView[] = []) {
  let windows: BrowserWindowView[] = structuredClone(initial);
  let nextWindow = 900;
  let nextPage = 1;
  const closedTabs: string[] = [];
  const focused: string[] = [];
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
      windows = windows.filter((w) => w.windowId !== windowId);
    },
    async closeTab(pageId) {
      closedTabs.push(pageId);
      windows = windows.map((w) => ({ ...w, tabs: w.tabs.filter((t) => t.pageId !== pageId) })).filter((w) => w.tabs.length > 0);
    },
    async focusTab(pageId) {
      focused.push(pageId);
    },
  };
  return {
    backend,
    closedTabs,
    focused,
    set(next: BrowserWindowView[]) {
      windows = structuredClone(next);
    },
    get windows() {
      return windows;
    },
  };
}

const run = (session: string, window?: number, extra: Record<string, unknown> = {}) => ({
  __sessionId: session,
  ...(window !== undefined ? { window } : {}),
  ...extra,
});

const reddit = (windowId: number, pageId: string): BrowserWindowView => ({
  windowId,
  tabs: [{ pageId, url: "https://www.reddit.com/r/bun", title: "Reddit" }],
});

describe("BrowserWindows: holding", () => {
  test("naming a free window takes it silently and hands back its tab", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    expect(await w.page(run("A", 1))).toBe("r1");
    expect(await w.describe("A")).toContain("Window 1 (yours)");
  });

  test("a window another run holds is refused with what to do, and the refusal is not an infra failure", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    w.beginRun("B");
    await w.page(run("A", 1));
    const refusal = await w.page(run("B", 1)).catch((e: Error) => e.message);
    expect(refusal).toContain("Window 1 is in use by another task");
    expect(refusal).toContain("even for the same site");
    expect(refusal).toContain("Do not stop and do not wait");
    expect(isBrowserInfraError(refusal)).toBe(false);
  });

  test("two runs on two windows both proceed, on the same site", async () => {
    const b = fakeBrowser([reddit(11, "r1"), reddit(12, "r2")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    w.beginRun("B");
    const [a, bb] = await Promise.all([w.page(run("A", 1)), w.page(run("B", 2))]);
    expect([a, bb]).toEqual(["r1", "r2"]);
  });

  test("two runs racing for the same free window: exactly one gets it", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    w.beginRun("B");
    const outcomes = await Promise.allSettled([w.page(run("A", 1)), w.page(run("B", 1))]);
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
    expect(outcomes.filter((o) => o.status === "rejected").length).toBe(1);
  });

  test("one run may hold several windows", async () => {
    const b = fakeBrowser([reddit(11, "r1"), reddit(12, "r2")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    await w.page(run("A", 1));
    await w.page(run("A", 2));
    const text = await w.describe("A");
    expect(text).toContain("Window 1 (yours)");
    expect(text).toContain("Window 2 (yours)");
  });

  test("the end of a run gives its windows back, to anyone", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A", "conv-1");
    await w.page(run("A", 1));
    w.endRun("A", false);
    w.beginRun("B", "conv-2");
    expect(await w.page(run("B", 1))).toBe("r1");
  });

  test("an action without a window is refused and names the tool to start with", async () => {
    const w = new BrowserWindows(fakeBrowser([reddit(11, "r1")]).backend);
    const refusal = await w.page(run("A")).catch((e: Error) => e.message);
    expect(refusal).toContain("Name the window");
    expect(refusal).toContain("browser_new_window");
  });

  test("an unknown window is refused, not guessed", async () => {
    const w = new BrowserWindows(fakeBrowser([reddit(11, "r1")]).backend);
    const refusal = await w.page(run("A", 7)).catch((e: Error) => e.message);
    expect(refusal).toContain("There is no window 7");
  });

  test("a window number given as a string is still a window number", async () => {
    const w = new BrowserWindows(fakeBrowser([reddit(11, "r1")]).backend);
    expect(await w.page(run("A", undefined, { window: "1" }))).toBe("r1");
  });
});

describe("BrowserWindows: human handoff", () => {
  test("after a handoff the window is kept for its conversation, and refused to others", async () => {
    let clock = 1_000;
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("A", "conv-1");
    await w.page(run("A", 1));
    w.endRun("A", true);

    w.beginRun("OTHER", "conv-2");
    const refusal = await w.page(run("OTHER", 1)).catch((e: Error) => e.message);
    expect(refusal).toContain("kept for a human");

    // The same conversation takes it back, whether through `send` or a new delegation.
    w.beginRun("A2", "conv-1");
    expect(await w.page(run("A2", 1))).toBe("r1");
  });

  test("the handoff hold expires", async () => {
    let clock = 1_000;
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("A", "conv-1");
    await w.page(run("A", 1));
    w.endRun("A", true);
    clock += HANDOFF_HOLD_MS + 1;
    w.beginRun("OTHER", "conv-2");
    expect(await w.page(run("OTHER", 1))).toBe("r1");
  });
});

describe("BrowserWindows: windows and tabs", () => {
  test("a new window is the caller's, and the cap counts agent windows only", async () => {
    const human = Array.from({ length: 3 }, (_, i) => reddit(100 + i, `h${i}`));
    const b = fakeBrowser(human);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    for (let i = 0; i < MAX_AGENT_WINDOWS; i++) await w.newWindow(run("A"), `https://site-${i}.test`);
    const refusal = await w.newWindow(run("A"), "https://one-more.test").catch((e: Error) => e.message);
    expect(refusal).toContain(`already has ${MAX_AGENT_WINDOWS} windows opened by agents`);
    // The owner's three windows were free and are offered for reuse.
    expect(refusal).toContain("window 1");
  });

  test("a window a site opened neither counts against the cap nor is free: it follows its opener", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    w.beginRun("B");
    await w.page(run("A", 1));
    b.set([reddit(11, "r1"), { windowId: 12, tabs: [{ pageId: "pop", url: "https://pay.test", title: "", openerPageId: "r1" }] }]);
    const refusal = await w.page(run("B", 2)).catch((e: Error) => e.message);
    expect(refusal).toContain("in use by another task");
    expect(await w.page(run("A", 2))).toBe("pop");
    for (let i = 0; i < MAX_AGENT_WINDOWS; i++) await w.newWindow(run("A"), `https://site-${i}.test`);
  });

  test("focus_tab makes a tab the run's page; close_tab forgets it", async () => {
    const b = fakeBrowser([{ windowId: 11, tabs: [{ pageId: "t1", url: "https://a.test", title: "" }, { pageId: "t2", url: "https://b.test", title: "" }] }]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    await w.focusTab(run("A", 1, { tab: 2 }));
    expect(b.focused).toEqual(["t2"]);
    expect(await w.page(run("A", 1))).toBe("t2");
    await w.closeTab(run("A", 1, { tab: 2 }));
    expect(await w.page(run("A", 1))).toBe("t1");
  });

  test("closing a window frees its number and its hold", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    await w.page(run("A", 1));
    expect(await w.closeWindow(run("A", 1))).toBe(1);
    expect(await w.describe("A")).toContain("None open yet");
  });

  test("the run's current tab is marked in the listing", async () => {
    const b = fakeBrowser([{ windowId: 11, tabs: [{ pageId: "t1", url: "https://a.test", title: "A" }, { pageId: "t2", url: "https://b.test", title: "B" }] }]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    await w.focusTab(run("A", 1, { tab: 1 }));
    const text = await w.describe("A");
    expect(text).toContain("[1] A - https://a.test <- your current tab");
    expect(text).not.toContain("[2] B - https://b.test <- your current tab");
  });
});

describe("BrowserWindows: the sweep", () => {
  /** A run that opened `count` tabs in one window, then ended long ago. */
  async function idleAgentTabs(count: number) {
    let clock = 1_000;
    const b = fakeBrowser([{ windowId: 1, tabs: [{ pageId: "owner", url: "https://owner.test", title: "" }] }]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("A");
    await w.describe("A");
    const { result } = await w.newWindow(run("A"), "https://agent.test/0");
    const agentWindow = b.windows.find((x) => x.tabs.some((t) => t.pageId === result.pageId))!;
    for (let i = 1; i < count; i++) agentWindow.tabs.push({ pageId: `a${i}`, url: `https://agent.test/${i}`, title: "" });
    await w.describe("A");
    w.endRun("A", false);
    return { b, w, advance: (ms: number) => (clock += ms) };
  }

  test("past the threshold, idle agent tabs nobody holds are closed, and never the owner's", async () => {
    const { b, w, advance } = await idleAgentTabs(SWEEP_ABOVE_TABS + 2);
    advance(SWEEP_IDLE_MS);
    w.beginRun("B");
    await w.newWindow(run("B"), "https://fresh.test");
    expect(b.closedTabs.length).toBe(3);
    expect(b.closedTabs).not.toContain("owner");
  });

  test("tabs used recently are not swept", async () => {
    const { b, w, advance } = await idleAgentTabs(SWEEP_ABOVE_TABS + 2);
    advance(SWEEP_IDLE_MS - 1);
    w.beginRun("B");
    await w.newWindow(run("B"), "https://fresh.test");
    expect(b.closedTabs).toEqual([]);
  });

  test("a held window is never swept", async () => {
    const { b, w, advance } = await idleAgentTabs(SWEEP_ABOVE_TABS + 2);
    advance(SWEEP_IDLE_MS);
    w.beginRun("C");
    await w.page(run("C", 2));
    w.beginRun("B");
    await w.newWindow(run("B"), "https://fresh.test");
    expect(b.closedTabs).toEqual([]);
  });

  test("tabs open when the server started are never the agent's", async () => {
    let clock = 1_000;
    const many = Array.from({ length: SWEEP_ABOVE_TABS + 3 }, (_, i) => ({ pageId: `old${i}`, url: `https://old.test/${i}`, title: "" }));
    const b = fakeBrowser([{ windowId: 1, tabs: many }]);
    const w = new BrowserWindows(b.backend, () => clock);
    clock += SWEEP_IDLE_MS * 10;
    w.beginRun("A");
    await w.newWindow(run("A"), "https://fresh.test");
    expect(b.closedTabs).toEqual([]);
  });
});
