import type { BrowserResult, BrowserTabView, BrowserWindowView } from "../../browser/types.ts";

export type { BrowserTabView, BrowserWindowView };

/** What the windows need from the sidecar, and nothing else: the tests stand one up in memory. */
export interface WindowsBackend {
  listWindows(): Promise<BrowserWindowView[]>;
  createWindow(url: string): Promise<BrowserResult & { windowId: number }>;
  closeWindow(windowId: number): Promise<void>;
  closeTab(pageId: string): Promise<void>;
  focusTab(pageId: string): Promise<void>;
}

/** How long a window stays held for its conversation after a human handoff. */
export const HANDOFF_HOLD_MS = 30 * 60_000;

interface RunWindows {
  parent?: string;
  /** The page the run works on in each window it holds. */
  current: Map<number, string>;
}

function sessionOf(args: Record<string, unknown>): string {
  return typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
}

function aliasArg(args: Record<string, unknown>): number | undefined {
  const raw = args["window"];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function tabArg(args: Record<string, unknown>): number | undefined {
  const raw = args["tab"];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The shared browser, as windows held by runs -- docs/browser-windows.md.
 *
 * Every browser tool names a window; the first one that names a free window takes it for the calling
 * run, and the run's end gives it back. A window another run holds is refused with what to do
 * instead, never waited for. Everything here is the server's memory: a hold cannot outlive its run,
 * because a crash that loses the holds loses the runs with them.
 *
 * Nothing here caps the browser or closes a tab behind anyone's back: how many windows the runs
 * open is theirs to decide, and what that costs is the machine's.
 */
export class BrowserWindows {
  private readonly windowByAlias = new Map<number, number>();
  private readonly aliasByWindow = new Map<number, number>();
  private nextAlias = 1;
  /** windowId -> the session of the run holding it. */
  private readonly locks = new Map<number, string>();
  /** windowId -> the conversation it is kept for after a human handoff. */
  private readonly holds = new Map<number, { parent: string; until: number }>();
  private readonly runs = new Map<string, RunWindows>();
  private readonly lastUsed = new Map<string, number>();
  private layout: BrowserWindowView[] = [];

  constructor(
    private readonly backend: WindowsBackend,
    private readonly now: () => number = Date.now,
  ) {}

  beginRun(session: string, parent?: string): void {
    this.runs.set(session, { ...(parent ? { parent } : {}), current: new Map() });
  }

  /** Gives back every window the run held; after a human handoff they stay kept for its conversation. */
  endRun(session: string, handoff: boolean): void {
    const parent = this.runs.get(session)?.parent;
    for (const [windowId, owner] of this.locks) {
      if (owner !== session) continue;
      this.locks.delete(windowId);
      if (handoff && parent) this.holds.set(windowId, { parent, until: this.now() + HANDOFF_HOLD_MS });
    }
    this.runs.delete(session);
  }

  /** The page the calling run works on in the window it names, taking the window if it is free. */
  async page(args: Record<string, unknown>): Promise<string> {
    const session = sessionOf(args);
    const windowId = await this.window(args);
    const run = this.runOf(session);
    let pageId = run.current.get(windowId);
    if (!pageId) {
      let tabs = this.tabsOf(windowId);
      if (tabs.length === 0) {
        await this.refresh();
        tabs = this.tabsOf(windowId);
      }
      const chosen = this.mostRecent(tabs);
      if (!chosen) throw new Error(`Window ${this.alias(windowId)} has no tab left. browser_list_windows shows what is open.`);
      pageId = chosen.pageId;
      run.current.set(windowId, pageId);
    }
    this.lastUsed.set(pageId, this.now());
    return pageId;
  }

  /** The window the calling run names, taken for it. For the tools that act on a window, not a page. */
  async window(args: Record<string, unknown>): Promise<number> {
    const alias = aliasArg(args);
    if (alias === undefined) {
      throw new Error(
        "Name the window: every browser action takes `window`, the number browser_list_windows shows. To start somewhere new, use browser_new_window.",
      );
    }
    let windowId = this.windowByAlias.get(alias);
    if (windowId === undefined || !this.isOpen(windowId)) {
      await this.refresh();
      windowId = this.windowByAlias.get(alias);
    }
    if (windowId === undefined || !this.isOpen(windowId)) {
      throw new Error(`There is no window ${alias}. browser_list_windows shows the open ones; browser_new_window opens one.`);
    }
    this.acquire(sessionOf(args), windowId);
    return windowId;
  }

  /** A navigation landed on `pageId`: it is the run's page in that window from now on. */
  moved(args: Record<string, unknown>, windowId: number, pageId: string, opened: boolean): void {
    const run = this.runOf(sessionOf(args));
    run.current.set(windowId, pageId);
    this.lastUsed.set(pageId, this.now());
    if (!opened) return;
    const window = this.layout.find((w) => w.windowId === windowId);
    if (window && !window.tabs.some((t) => t.pageId === pageId)) window.tabs.push({ pageId, url: "", title: "" });
  }

  /** Opens a window for the calling run, which holds it from the start. */
  async newWindow(args: Record<string, unknown>, url: string): Promise<{ alias: number; result: BrowserResult }> {
    const result = await this.backend.createWindow(url);
    this.locks.set(result.windowId, sessionOf(args));
    this.layout.push({ windowId: result.windowId, tabs: [{ pageId: result.pageId, url: result.url, title: "" }] });
    this.moved(args, result.windowId, result.pageId, true);
    return { alias: this.alias(result.windowId), result };
  }

  /**
   * Whether the tab is in a window kept for a human who was handed a blocker (a captcha, a code):
   * such a tab is never closed for the browser's sake, even frozen, because someone is working in
   * it. What the layout last showed is what counts; a tab it has never shown is nobody's.
   */
  keptForHuman(pageId: string): boolean {
    const window = this.layout.find((w) => w.tabs.some((t) => t.pageId === pageId));
    if (!window) return false;
    const hold = this.holds.get(window.windowId);
    return hold !== undefined && hold.until > this.now();
  }

  async closeWindow(args: Record<string, unknown>): Promise<number> {
    const windowId = await this.window(args);
    const alias = this.alias(windowId);
    await this.backend.closeWindow(windowId);
    this.forgetWindow(windowId);
    return alias;
  }

  /** Makes a tab of a held window the run's page, and the one the window shows. */
  async focusTab(args: Record<string, unknown>): Promise<{ alias: number; tab: number; pageId: string }> {
    const { windowId, tab, pageId } = await this.tabOf(args);
    await this.backend.focusTab(pageId);
    this.runOf(sessionOf(args)).current.set(windowId, pageId);
    this.lastUsed.set(pageId, this.now());
    return { alias: this.alias(windowId), tab, pageId };
  }

  async closeTab(args: Record<string, unknown>): Promise<{ alias: number; tab: number }> {
    const { windowId, tab, pageId } = await this.tabOf(args);
    await this.backend.closeTab(pageId);
    const run = this.runOf(sessionOf(args));
    if (run.current.get(windowId) === pageId) run.current.delete(windowId);
    this.forgetPage(pageId);
    return { alias: this.alias(windowId), tab };
  }

  /** The windows, their tabs and who holds them, as the calling run should read them. */
  async describe(session = ""): Promise<string> {
    const windows = await this.refresh();
    if (windows.length === 0) {
      return "## Browser windows\nNone open yet: browser_new_window(url) opens one.";
    }
    const current = this.runs.get(session)?.current;
    const lines = ["## Browser windows"];
    for (const w of windows) {
      const state = this.stateFor(w.windowId, session);
      const mine = current?.get(w.windowId);
      const label =
        state === "yours"
          ? "yours"
          : state === "kept-for-you"
            ? "kept for you after a human handoff"
            : state === "held"
              ? "in use by another task: do not use"
              : state === "kept"
                ? "kept for a human handoff: do not use"
                : "free";
      lines.push(`Window ${this.alias(w.windowId)} (${label})`);
      w.tabs.forEach((t, i) => {
        const marker = t.pageId === mine ? " <- your current tab" : "";
        lines.push(`  [${i + 1}] ${t.title ? `${t.title} - ` : ""}${t.url}${marker}`);
      });
    }
    return lines.join("\n");
  }

  private acquire(session: string, windowId: number): void {
    const alias = this.alias(windowId);
    const owner = this.locks.get(windowId);
    if (owner === session) return;
    if (owner !== undefined) {
      throw new Error(
        `Window ${alias} is in use by another task. Do not stop and do not wait: take a free window from browser_list_windows, or open one with browser_new_window -- even for the same site.`,
      );
    }
    const hold = this.holds.get(windowId);
    if (hold && hold.until > this.now() && hold.parent !== this.runOf(session).parent) {
      throw new Error(
        `Window ${alias} is kept for a human who is solving a blocker in it. Do not stop and do not wait: take a free window from browser_list_windows, or open one with browser_new_window.`,
      );
    }
    this.holds.delete(windowId);
    this.locks.set(windowId, session);
  }

  private stateFor(windowId: number, session: string): "yours" | "held" | "kept" | "kept-for-you" | "free" {
    const owner = this.locks.get(windowId);
    if (owner !== undefined) return owner === session ? "yours" : "held";
    const hold = this.holds.get(windowId);
    if (!hold || hold.until <= this.now()) return "free";
    return hold.parent === this.runs.get(session)?.parent ? "kept-for-you" : "kept";
  }

  private async refresh(): Promise<BrowserWindowView[]> {
    const windows = await this.backend.listWindows();
    const open = new Set(windows.map((w) => w.windowId));
    const windowOfPage = new Map<string, number>();
    for (const w of windows) for (const t of w.tabs) windowOfPage.set(t.pageId, w.windowId);

    for (const windowId of [...this.aliasByWindow.keys()]) if (!open.has(windowId)) this.forgetWindow(windowId);

    // A window a site opened belongs to the run holding the window its opener lives in.
    for (const w of windows) {
      if (this.locks.has(w.windowId)) continue;
      for (const tab of w.tabs) {
        const openerWindow = tab.openerPageId ? windowOfPage.get(tab.openerPageId) : undefined;
        const owner = openerWindow !== undefined ? this.locks.get(openerWindow) : undefined;
        if (owner !== undefined) {
          this.locks.set(w.windowId, owner);
          break;
        }
      }
    }

    for (const pageId of [...this.lastUsed.keys()]) if (!windowOfPage.has(pageId)) this.lastUsed.delete(pageId);
    for (const run of this.runs.values()) {
      for (const [windowId, pageId] of run.current) if (windowOfPage.get(pageId) !== windowId) run.current.delete(windowId);
    }
    for (const w of windows) this.alias(w.windowId);
    this.layout = windows;
    return windows;
  }

  private async tabOf(args: Record<string, unknown>): Promise<{ windowId: number; tab: number; pageId: string }> {
    const windowId = await this.window(args);
    const tab = tabArg(args);
    if (tab === undefined) throw new Error("Name the tab: its number in the window, as browser_list_windows shows it.");
    await this.refresh();
    const pageId = this.tabsOf(windowId)[tab - 1]?.pageId;
    if (!pageId) throw new Error(`Window ${this.alias(windowId)} has no tab ${tab}. browser_list_windows shows its tabs.`);
    return { windowId, tab, pageId };
  }

  private mostRecent(tabs: BrowserTabView[]): BrowserTabView | undefined {
    let best: BrowserTabView | undefined;
    let bestAt = -1;
    for (const tab of tabs) {
      const at = this.lastUsed.get(tab.pageId) ?? -1;
      if (!best || at >= bestAt) {
        best = tab;
        bestAt = at;
      }
    }
    return best;
  }

  private tabsOf(windowId: number): BrowserTabView[] {
    return this.layout.find((w) => w.windowId === windowId)?.tabs ?? [];
  }

  private isOpen(windowId: number): boolean {
    return this.layout.some((w) => w.windowId === windowId);
  }

  private runOf(session: string): RunWindows {
    let run = this.runs.get(session);
    if (!run) {
      run = { current: new Map() };
      this.runs.set(session, run);
    }
    return run;
  }

  private alias(windowId: number): number {
    let alias = this.aliasByWindow.get(windowId);
    if (alias === undefined) {
      alias = this.nextAlias++;
      this.aliasByWindow.set(windowId, alias);
      this.windowByAlias.set(alias, windowId);
    }
    return alias;
  }

  private forgetWindow(windowId: number): void {
    const alias = this.aliasByWindow.get(windowId);
    if (alias !== undefined) this.windowByAlias.delete(alias);
    this.aliasByWindow.delete(windowId);
    this.locks.delete(windowId);
    this.holds.delete(windowId);
    for (const tab of this.tabsOf(windowId)) this.forgetPage(tab.pageId);
    this.layout = this.layout.filter((w) => w.windowId !== windowId);
    for (const run of this.runs.values()) run.current.delete(windowId);
  }

  private forgetPage(pageId: string): void {
    this.lastUsed.delete(pageId);
    for (const w of this.layout) w.tabs = w.tabs.filter((t) => t.pageId !== pageId);
  }
}
