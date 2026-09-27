import { describe, expect, test } from "bun:test";
import {
  BrowserWindows,
  DEFAULT_HOLD_MS,
  type BrowserWindowView,
  type WindowsBackend,
} from "../../src/tools/browser/windows.ts";
import { BrowserSession, isBrowserInfraError, recordBrowserOutcome, takeBrowserOutcome } from "../../src/tools/browser/session.ts";
import { taskLabel } from "../../src/tools/browser/windows.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

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
    w.endRun("A");
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
    w.endRun("A", { reason: "human" });

    w.beginRun("OTHER", "conv-2");
    const refusal = await w.page(run("OTHER", 1)).catch((e: Error) => e.message);
    expect(refusal).toContain("for a human who is solving a blocker");

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
    w.endRun("A", { reason: "human" });
    clock += DEFAULT_HOLD_MS + 1;
    w.beginRun("OTHER", "conv-2");
    expect(await w.page(run("OTHER", 1))).toBe("r1");
  });

  // Owner, 2026-09-26: never close a tab an agent handed to the user. The client asks this before
  // closing a frozen tab on its own.
  test("a tab of a window kept for a human is known as such, until the hold ends", async () => {
    let clock = 1_000;
    const b = fakeBrowser([reddit(11, "r1"), reddit(12, "r2")]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("A", "conv-1");
    await w.page(run("A", 1));
    await w.page(run("A", 2));
    w.endRun("A");
    expect(w.keptForHuman("r1")).toBe(false);

    w.beginRun("H", "conv-2");
    await w.page(run("H", 1));
    w.endRun("H", { reason: "human" });
    expect(w.keptForHuman("r1")).toBe(true);
    expect(w.keptForHuman("r2")).toBe(false);
    expect(w.keptForHuman("unknown")).toBe(false);

    clock += DEFAULT_HOLD_MS + 1;
    expect(w.keptForHuman("r1")).toBe(false);
  });
});

describe("BrowserWindows: windows and tabs", () => {
  // Owner, 2026-09-26: no cap. How many windows the runs open is theirs to decide.
  test("a new window is the caller's, however many agents already opened", async () => {
    const human = Array.from({ length: 3 }, (_, i) => reddit(100 + i, `h${i}`));
    const b = fakeBrowser(human);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    w.beginRun("B");
    for (let i = 0; i < 30; i++) await w.newWindow(run(i % 2 ? "A" : "B"), `https://site-${i}.test`);
    const { alias } = await w.newWindow(run("A"), "https://one-more.test");
    expect(await w.page(run("A", alias))).toBeTruthy();
    expect(b.windows.length).toBe(34);
    const refusal = await w.page(run("B", alias)).catch((e: Error) => e.message);
    expect(refusal).toContain("in use by another task");
  });

  test("a window a site opened is not free: it follows its opener", async () => {
    const b = fakeBrowser([reddit(11, "r1")]);
    const w = new BrowserWindows(b.backend);
    w.beginRun("A");
    w.beginRun("B");
    await w.page(run("A", 1));
    b.set([reddit(11, "r1"), { windowId: 12, tabs: [{ pageId: "pop", url: "https://pay.test", title: "", openerPageId: "r1" }] }]);
    const refusal = await w.page(run("B", 2)).catch((e: Error) => e.message);
    expect(refusal).toContain("in use by another task");
    expect(await w.page(run("A", 2))).toBe("pop");
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

// Owner, 2026-09-26: nothing closes a tab behind anyone's back. Tabs pile up until someone
// closes them; what that costs is the machine's.
describe("BrowserWindows: no sweep", () => {
  test("idle agent tabs are never closed, however many and however old", async () => {
    let clock = 1_000;
    const b = fakeBrowser([{ windowId: 1, tabs: [{ pageId: "owner", url: "https://owner.test", title: "" }] }]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("A");
    await w.describe("A");
    const { result } = await w.newWindow(run("A"), "https://agent.test/0");
    const agentWindow = b.windows.find((x) => x.tabs.some((t) => t.pageId === result.pageId))!;
    for (let i = 1; i < 40; i++) agentWindow.tabs.push({ pageId: `a${i}`, url: `https://agent.test/${i}`, title: "" });
    await w.describe("A");
    w.endRun("A");
    clock += 7 * 24 * 60 * 60_000;
    w.beginRun("B");
    await w.newWindow(run("B"), "https://fresh.test");
    await w.page(run("B", 2, { tab: 1 }));
    expect(b.closedTabs).toEqual([]);
  });
});

describe("BrowserSession: the windows decide what the client may close", () => {
  // The client closes a frozen tab on its own; only the windows know that a human was handed one.
  test("a frozen tab in a window handed to a human is not closed by the shared client", async () => {
    const paths: string[] = [];
    const mock = mockFetch(async (input) => {
      const path = String(input).split("/").pop() ?? "";
      paths.push(path);
      if (path === "list-windows") return new Response(JSON.stringify({ windows: [reddit(11, "r1")] })) as never;
      if (path === "probe") return new Response(JSON.stringify({ open: true, responsive: false, url: "https://captcha.test" })) as never;
      if (path === "close-target") return new Response("{}") as never;
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    try {
      const session = new BrowserSession({ browser: { enabled: true } } as MyClawConfig);
      session.beginRun("run-h", "conv-1");
      await session.windows.page(run("run-h", 1));
      recordBrowserOutcome("run-h", { needsHuman: true });
      session.endRun("run-h");
      const error = await session.client.snapshot("r1").then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toContain("left open");
      expect(paths).not.toContain("close-target");
    } finally {
      mock.restore();
    }
  });
});

describe("BrowserWindows: the owner's live view", () => {
  test("a task names its window by its first line", () => {
    expect(taskLabel("Task: apply to the Nabla job\nStart URL: https://x\n\n## Browser windows")).toBe("apply to the Nabla job");
    expect(taskLabel("  \n continue")).toBe("continue");
    expect(taskLabel(undefined)).toBeUndefined();
    expect(taskLabel(`Task: ${"x".repeat(300)}`)!.length).toBe(140);
  });

  test("each window says whether a run works in it, waits for a human, or is free, and which tab it shows", async () => {
    let clock = 1_000;
    const b = fakeBrowser([
      { windowId: 11, onStage: true, tabs: [{ pageId: "a", url: "https://a.test", title: "A", active: true }] },
      { windowId: 12, tabs: [{ pageId: "b", url: "https://b.test", title: "B" }] },
      { windowId: 13, tabs: [{ pageId: "c", url: "https://c.test", title: "C" }] },
    ]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("R1", "conv-1", "search the jobs");
    await w.page(run("R1", 1));
    w.beginRun("R2", "conv-2", "solve the login");
    await w.page(run("R2", 2));
    w.endRun("R2", { reason: "human" });
    const overview = await w.overview();
    expect(overview).toEqual([
      { alias: 1, windowId: 11, onStage: true, state: "working", task: "search the jobs", tabs: [{ pageId: "a", title: "A", url: "https://a.test", active: true }] },
      { alias: 2, windowId: 12, onStage: false, state: "waiting", keptUntil: 1_000 + DEFAULT_HOLD_MS, task: "solve the login", tabs: [{ pageId: "b", title: "B", url: "https://b.test", active: false }] },
      { alias: 3, windowId: 13, onStage: false, state: "free", tabs: [{ pageId: "c", title: "C", url: "https://c.test", active: false }] },
    ]);
    clock += DEFAULT_HOLD_MS + 1;
    expect((await w.overview())[1]).toMatchObject({ state: "free" });
    expect((await w.overview())[1]!.task).toBeUndefined();
  });

  test("a handoff names the window the run worked in last, a normal end names none", async () => {
    let clock = 1_000;
    const b = fakeBrowser([reddit(11, "r1"), reddit(12, "r2")]);
    const w = new BrowserWindows(b.backend, () => clock);
    w.beginRun("A", "conv-1");
    await w.page(run("A", 2));
    clock += 10;
    await w.page(run("A", 1));
    expect(w.endRun("A", { reason: "human" })?.windowIds[0]).toBe(11);
    w.beginRun("B", "conv-1");
    await w.page(run("B", 2));
    expect(w.endRun("B")).toBeUndefined();
  });
});

describe("BrowserSession: a handoff puts its window on the VNC screen", () => {
  test("the window is staged, and the outcome names it for the handoff message", async () => {
    const paths: Array<{ path: string; body: Record<string, unknown> }> = [];
    const mock = mockFetch(async (input, init) => {
      const path = String(input).split("/").pop() ?? "";
      paths.push({ path, body: JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown> });
      if (path === "list-windows") return new Response(JSON.stringify({ windows: [reddit(11, "r1"), reddit(12, "r2")] })) as never;
      return new Response("{}") as never;
    });
    try {
      const session = new BrowserSession({ browser: { enabled: true } } as MyClawConfig);
      session.beginRun("run-s", "conv-1", "Task: log in");
      await session.windows.page(run("run-s", 2));
      recordBrowserOutcome("run-s", { summary: "captcha", needsHuman: true });
      await session.endRun("run-s");
      expect(paths.filter((p) => p.path === "stage").map((p) => p.body)).toEqual([{ windowId: 12 }]);
      expect(takeBrowserOutcome("run-s")).toMatchObject({ needsHuman: true, onScreen: 2 });

      session.beginRun("run-t", "conv-2");
      await session.windows.page(run("run-t", 1));
      recordBrowserOutcome("run-t", { summary: "done" });
      await session.endRun("run-t");
      expect(paths.filter((p) => p.path === "stage").length).toBe(1);
      expect(takeBrowserOutcome("run-t")?.onScreen).toBeUndefined();
    } finally {
      mock.restore();
    }
  });
});
