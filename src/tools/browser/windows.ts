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

/** How long a window is kept when nothing says otherwise (`browser.holdDefault`). */
export const DEFAULT_HOLD_MS = 30 * 60_000;
/** The longest a window can be kept (`browser.holdMax`): long enough for a form left over a weekend. */
export const DEFAULT_HOLD_MAX_MS = 7 * 24 * 60 * 60_000;
/** How many windows can be kept at once (`browser.holdMaxWindows`). */
export const DEFAULT_HOLD_MAX_WINDOWS = 8;

export interface HoldPolicy {
  defaultMs: number;
  maxMs: number;
  maxWindows: number;
}

export const DEFAULT_HOLD_POLICY: HoldPolicy = {
  defaultMs: DEFAULT_HOLD_MS,
  maxMs: DEFAULT_HOLD_MAX_MS,
  maxWindows: DEFAULT_HOLD_MAX_WINDOWS,
};

/**
 * A window kept for a conversation after the run that worked in it ended: for a human who has a
 * blocker to solve in it, or because the run stopped at a step it will be sent back to (an e-mail
 * code the caller has to read first). Persisted, so a my-claw restart does not free it.
 */
export interface WindowHold {
  windowId: number;
  /** The conversation it is kept for (see `holderOf`). */
  holder: string;
  until: number;
  since: number;
  reason: "human" | "kept";
  label?: string;
  /**
   * What its tabs showed, kept current while the window is open. If the browser restarts, window
   * ids change; the restored window with the same pages is the kept one.
   */
  urls: string[];
  /** When the owner was told it is about to close (`expiring`), so it is said once. */
  warnedAt?: number;
}

/** Where holds survive a restart. The tests keep them in memory. */
export interface HoldStore {
  load(): WindowHold[];
  save(holds: WindowHold[]): void;
}

/**
 * A page a run opened, and so the run's to close -- docs/browser-windows.md, "Who closes a page".
 * Persisted: a my-claw restart ends every run, and the pages they opened must not outlive that as
 * nobody's.
 */
export interface OwnedPage {
  pageId: string;
  /** The run that opened it (or opened the page or the window it came from). */
  owner: string;
  /** Its last known address: a browser restart renumbers pages, and this is how it is found again. */
  url: string;
  /** The first page of a window the run opened: every tab of that window is the run's too. */
  window?: boolean;
  /** When it was last seen missing, so an entry for a page closed by hand is dropped. */
  missingSince?: number;
}

export interface PageStore {
  load(): OwnedPage[];
  save(pages: OwnedPage[]): void;
}

/** How long an owned page may be missing before its entry is dropped: longer than a browser restart. */
const PAGE_MISSING_GRACE_MS = 10 * 60_000;
/** A hold is announced before it ends when it was kept this long at least: a short one was just handed over. */
export const WARN_HOLDS_FROM_MS = 2 * 60 * 60_000;
/** How long before its end a hold is announced. */
export const WARN_BEFORE_MS = 60 * 60_000;

/**
 * Who a window is kept for. A conversation is its own session; a scheduled job's run is one
 * session per run, and the run that comes back to the window is the next one, so every run of a
 * job counts as the job.
 */
export function holderOf(session: string): string {
  const cron = /^(cron\/[^/]+)\/\d+$/.exec(session);
  return cron ? cron[1]! : session;
}

/** Pages that say nothing about which window this was. */
function meaningful(url: string): boolean {
  return url !== "" && url !== "about:blank" && !url.startsWith("chrome://");
}

interface RunWindows {
  parent?: string;
  /** What the run was asked to do, as the owner's live view names it. */
  label?: string;
  /** The page the run works on in each window it holds. */
  current: Map<number, string>;
}

/** One window as the owner's live view shows it -- docs/browser-live.md. */
export interface WindowOverview {
  /** The number agents use for it. */
  alias: number;
  windowId: number;
  onStage: boolean;
  /** A run works in it, it waits for a human after a handoff, or nobody holds it. */
  state: "working" | "waiting" | "free";
  /** Until when it is kept, when it is waiting. */
  keptUntil?: number;
  /** The task of the run working in it, or of the one that handed it over. */
  task?: string;
  tabs: Array<{ pageId: string; title: string; url: string; active: boolean }>;
}

const TASK_LABEL_CHARS = 140;

/** The first line of a browser task (`Task: ...`), short enough for a tile. */
export function taskLabel(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((l) => l.trim() !== "")?.replace(/^Task:\s*/, "").trim();
  if (!line) return undefined;
  return line.length > TASK_LABEL_CHARS ? `${line.slice(0, TASK_LABEL_CHARS - 1)}…` : line;
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
 * instead, never waited for. A run's own lock is the server's memory: it cannot outlive its run,
 * because a crash that loses the locks loses the runs with them. A window kept after the run (for a
 * human, or for the conversation to come back to) is different: that is work waiting, and it is
 * persisted so a restart does not hand it to the next task (docs/browser-windows.md).
 *
 * Nothing here caps the browser, and nothing closes a tab behind anyone's back. What a run opens
 * is the run's (`OwnedPage`): it is closed when nothing needs it any more -- its run has ended, no
 * run works in its window and no hold keeps that window. A page nobody here opened (the owner's, a
 * window restored from before) is never closed. The sweep that applies it is `sweep`.
 */
export class BrowserWindows {
  private readonly windowByAlias = new Map<number, number>();
  private readonly aliasByWindow = new Map<number, number>();
  private nextAlias = 1;
  /** windowId -> the session of the run holding it. */
  private readonly locks = new Map<number, string>();
  /** windowId -> what it is kept for. Loaded from the store at the first read, saved on every change. */
  private readonly holds = new Map<number, WindowHold>();
  /** Holds whose window this process has not seen yet (after a restart), or lost (the browser went down). */
  private readonly unbound = new Set<number>();
  private loaded = false;
  private readonly runs = new Map<string, RunWindows>();
  private readonly lastUsed = new Map<string, number>();
  private layout: BrowserWindowView[] = [];
  /** pageId -> the run it belongs to. Loaded from the store at the first read, saved on every change. */
  private readonly owned = new Map<string, OwnedPage>();
  private pagesLoaded = false;

  constructor(
    private readonly backend: WindowsBackend,
    private readonly now: () => number = Date.now,
    private readonly store?: HoldStore,
    private readonly policy: () => HoldPolicy = () => DEFAULT_HOLD_POLICY,
    private readonly pageStore?: PageStore,
  ) {}

  /** Whether a run is working, for what should only happen when none is (the frozen-tab probe). */
  busy(): boolean {
    return this.runs.size > 0 || this.locks.size > 0;
  }

  /**
   * Closes every page a run opened that nothing needs any more: its run has ended, no run works in
   * its window, and no hold keeps that window. A window whose every tab goes is closed whole.
   * Returns how many pages were closed. Called when a run ends, when a hold is released, and on
   * the browser's housekeeping tick, which is where an expired hold's pages go.
   */
  async sweep(): Promise<number> {
    const windows = await this.refresh();
    const closeable = new Set<string>();
    for (const w of windows) {
      if (this.locks.has(w.windowId) || this.heldNow(w.windowId)) continue;
      for (const t of w.tabs) {
        const page = this.owned.get(t.pageId);
        if (page && !this.runs.has(page.owner)) closeable.add(t.pageId);
      }
    }
    if (closeable.size === 0) return 0;
    let closed = 0;
    for (const w of windows) {
      const gone = w.tabs.filter((t) => closeable.has(t.pageId));
      if (gone.length === 0) continue;
      try {
        if (gone.length === w.tabs.length) {
          await this.backend.closeWindow(w.windowId);
          this.forgetWindow(w.windowId);
        } else {
          for (const t of gone) {
            await this.backend.closeTab(t.pageId);
            this.forgetPage(t.pageId);
          }
        }
        for (const t of gone) this.owned.delete(t.pageId);
        closed += gone.length;
      } catch {
        // Left for the next sweep: a tab the browser refused to close now is still nobody's.
      }
    }
    this.savePages();
    return closed;
  }

  /**
   * The holds about to end that the owner has not been told about yet, marked as told. Only a hold
   * kept for a while (`WARN_HOLDS_FROM_MS`): one of thirty minutes was just handed over, and the
   * handoff said so. The pages go at the end; this is the chance to keep them.
   */
  expiring(): WindowHold[] {
    this.loadHolds();
    const now = this.now();
    const due = this.activeHolds().filter(
      (h) => h.warnedAt === undefined && h.until - h.since >= WARN_HOLDS_FROM_MS && h.until - now <= WARN_BEFORE_MS,
    );
    for (const hold of due) hold.warnedAt = now;
    if (due.length > 0) this.saveHolds();
    return due;
  }

  /**
   * Keeps a kept window longer: `ms` from now, capped at the maximum. `holder` limits it to the
   * windows kept for that conversation; without it, any (the owner). Returns the hold, or undefined
   * when no such window is kept.
   */
  async extend(target: { alias: number; holder?: string }, ms: number): Promise<WindowHold | undefined> {
    await this.refresh();
    const windowId = this.windowByAlias.get(target.alias);
    const hold = windowId !== undefined ? this.holds.get(windowId) : undefined;
    if (!hold || hold.until <= this.now()) return undefined;
    if (target.holder !== undefined && hold.holder !== holderOf(target.holder)) return undefined;
    hold.until = this.now() + Math.min(ms, this.policy().maxMs);
    delete hold.warnedAt;
    this.saveHolds();
    return hold;
  }

  beginRun(session: string, parent?: string, label?: string): void {
    this.runs.set(session, { ...(parent ? { parent } : {}), ...(label ? { label } : {}), current: new Map() });
  }

  /**
   * Gives back every window the run held. Asked to keep them (a human handoff, or the run stopping
   * at a step it will be sent back to), they stay kept for its conversation instead, for `keepMs`
   * or the default, capped at the maximum. Past `maxWindows` kept at once, the windows the run used
   * least recently are given back rather than kept.
   *
   * Returns the windows kept, the one the run worked in last first: that is the one a human is
   * shown, and the one the caller is told about.
   */
  endRun(session: string, keep?: { reason: "human" | "kept"; ms?: number }): { windowIds: number[]; until: number } | undefined {
    this.loadHolds();
    const run = this.runs.get(session);
    const holder = holderOf(run?.parent ?? session);
    const mine: Array<{ windowId: number; at: number }> = [];
    for (const [windowId, owner] of this.locks) {
      if (owner !== session) continue;
      this.locks.delete(windowId);
      const page = run?.current.get(windowId);
      mine.push({ windowId, at: (page ? this.lastUsed.get(page) : undefined) ?? -1 });
    }
    this.runs.delete(session);
    if (!keep || mine.length === 0) return undefined;

    const policy = this.policy();
    const until = this.now() + Math.min(keep.ms ?? policy.defaultMs, policy.maxMs);
    const room = Math.max(0, policy.maxWindows - this.activeHolds().length);
    mine.sort((a, b) => b.at - a.at);
    const kept = mine.slice(0, room).map((m) => m.windowId);
    for (const windowId of kept) {
      this.holds.set(windowId, {
        windowId,
        holder,
        until,
        since: this.now(),
        reason: keep.reason,
        ...(run?.label ? { label: run.label } : {}),
        urls: this.tabsOf(windowId).map((t) => t.url).filter(meaningful),
      });
    }
    this.saveHolds();
    return kept.length > 0 ? { windowIds: kept, until } : undefined;
  }

  /** How many more windows can be kept, for the tool that asks before promising. */
  keepRoom(): number {
    this.loadHolds();
    return Math.max(0, this.policy().maxWindows - this.activeHolds().length);
  }

  /** The kept windows, soonest to expire first, as the owner's list shows them. */
  async kept(): Promise<Array<WindowHold & { alias?: number; open: boolean }>> {
    await this.refresh();
    return this.activeHolds()
      .sort((a, b) => a.until - b.until)
      .map((hold) => {
        const open = this.isOpen(hold.windowId);
        return { ...hold, open, ...(open ? { alias: this.alias(hold.windowId) } : {}) };
      });
  }

  /**
   * Gives a kept window back. `holder` limits it to the windows kept for that conversation (a
   * conversation frees its own); without it, any (the owner). Returns what was released.
   */
  async release(target: { alias?: number; all?: boolean; holder?: string }): Promise<number> {
    await this.refresh();
    let released = 0;
    for (const hold of this.activeHolds()) {
      if (target.holder !== undefined && hold.holder !== holderOf(target.holder)) continue;
      if (!target.all) {
        if (target.alias === undefined) continue;
        const windowId = this.windowByAlias.get(target.alias);
        if (windowId !== hold.windowId) continue;
      }
      this.holds.delete(hold.windowId);
      this.unbound.delete(hold.windowId);
      released++;
    }
    if (released > 0) {
      this.saveHolds();
      // Released is done with: what the run opened in it goes now, not at the next tick.
      await this.sweep().catch(() => 0);
    }
    return released;
  }

  /** The number agents know a window by. */
  aliasOf(windowId: number): number {
    return this.alias(windowId);
  }

  /** The browser's windows and who is in them, for the owner's live view. */
  async overview(): Promise<WindowOverview[]> {
    const windows = await this.refresh();
    return windows.map((w) => {
      const holder = this.locks.get(w.windowId);
      const hold = this.holds.get(w.windowId);
      const waiting = holder === undefined && hold !== undefined && hold.until > this.now();
      const task = holder !== undefined ? this.runs.get(holder)?.label : waiting ? hold?.label : undefined;
      return {
        alias: this.alias(w.windowId),
        windowId: w.windowId,
        onStage: w.onStage === true,
        state: holder !== undefined ? "working" : waiting ? "waiting" : "free",
        ...(waiting && hold ? { keptUntil: hold.until } : {}),
        ...(task ? { task } : {}),
        tabs: w.tabs.map((t) => ({ pageId: t.pageId, title: t.title, url: t.url, active: t.active === true })),
      };
    });
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

  /** The address of the page the calling run works on in the window it names, read fresh from the browser. */
  async currentUrl(args: Record<string, unknown>): Promise<string> {
    const pageId = await this.page(args);
    await this.refresh();
    return this.layout.flatMap((w) => w.tabs).find((t) => t.pageId === pageId)?.url ?? "";
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
    const session = sessionOf(args);
    const run = this.runOf(session);
    run.current.set(windowId, pageId);
    this.lastUsed.set(pageId, this.now());
    if (!opened) return;
    this.own(pageId, session);
    const window = this.layout.find((w) => w.windowId === windowId);
    if (window && !window.tabs.some((t) => t.pageId === pageId)) window.tabs.push({ pageId, url: "", title: "" });
  }

  /** Opens a window for the calling run, which holds it from the start. */
  async newWindow(args: Record<string, unknown>, url: string): Promise<{ alias: number; result: BrowserResult }> {
    const result = await this.backend.createWindow(url);
    this.locks.set(result.windowId, sessionOf(args));
    this.layout.push({ windowId: result.windowId, tabs: [{ pageId: result.pageId, url: result.url, title: "" }] });
    this.moved(args, result.windowId, result.pageId, true);
    this.own(result.pageId, sessionOf(args), { url: result.url, window: true });
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
    const pages = this.tabsOf(windowId).map((t) => t.pageId);
    await this.backend.closeWindow(windowId);
    this.forgetWindow(windowId);
    if (this.holds.delete(windowId)) this.saveHolds();
    this.disown(pages);
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
    this.disown([pageId]);
    return { alias: this.alias(windowId), tab };
  }

  /**
   * The windows, their tabs and who holds them, as the calling run should read them. `caller` is
   * the conversation the run works for, when the run has not started yet (the task handed to a new
   * browser run): a window kept for that conversation is the one the run is meant to continue in.
   */
  async describe(session = "", caller?: string): Promise<string> {
    const windows = await this.refresh();
    if (windows.length === 0) {
      return "## Browser windows\nNone open yet: browser_new_window(url) opens one.";
    }
    const current = this.runs.get(session)?.current;
    const lines = ["## Browser windows"];
    for (const w of windows) {
      const state = this.stateFor(w.windowId, session, caller);
      const mine = current?.get(w.windowId);
      const hold = this.holds.get(w.windowId);
      const label =
        state === "yours"
          ? "yours"
          : state === "kept-for-you"
            ? `kept for you${hold?.reason === "human" ? " after a human handoff" : ""}: continue here${hold?.label ? ` (${hold.label})` : ""}`
            : state === "held"
              ? "in use by another task: do not use"
              : state === "kept"
                ? "kept for another conversation: do not use"
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
    if (hold && hold.until > this.now() && hold.holder !== holderOf(this.runOf(session).parent ?? session)) {
      throw new Error(
        `Window ${alias} is kept for another conversation${hold.reason === "human" ? ", for a human who is solving a blocker in it" : ""}. Do not stop and do not wait: take a free window from browser_list_windows, or open one with browser_new_window.`,
      );
    }
    if (hold) {
      this.holds.delete(windowId);
      this.saveHolds();
    }
    this.locks.set(windowId, session);
  }

  /** A window kept by a hold that has not ended. */
  private heldNow(windowId: number): boolean {
    const hold = this.holds.get(windowId);
    return hold !== undefined && hold.until > this.now();
  }

  private own(pageId: string, owner: string, extra: { url?: string; window?: boolean } = {}): void {
    this.loadPages();
    const known = this.owned.get(pageId);
    this.owned.set(pageId, {
      pageId,
      owner,
      url: extra.url ?? known?.url ?? "",
      ...(extra.window || known?.window ? { window: true } : {}),
    });
    this.savePages();
  }

  private disown(pageIds: string[]): void {
    let changed = false;
    for (const id of pageIds) changed = this.owned.delete(id) || changed;
    if (changed) this.savePages();
  }

  private loadPages(): void {
    if (this.pagesLoaded) return;
    this.pagesLoaded = true;
    for (const page of this.pageStore?.load() ?? []) this.owned.set(page.pageId, page);
  }

  private savePages(): void {
    try {
      this.pageStore?.save([...this.owned.values()]);
    } catch {
      // Ownership still holds for this process; only a restart would forget it.
    }
  }

  /**
   * Keeps ownership on the pages it belongs to: a tab a site opened from an owned page is its
   * owner's, and so is any tab of a window a run opened. After a restart that renumbered every page
   * (none of the owned ids is open any more), each entry finds its page again by address. An entry
   * whose page stays missing past the grace is dropped: it was closed by hand.
   */
  private bindPages(windows: BrowserWindowView[]): void {
    this.loadPages();
    let changed = false;
    const openIds = new Set(windows.flatMap((w) => w.tabs.map((t) => t.pageId)));
    const entries = [...this.owned.values()];
    const renumbered = entries.length > 0 && openIds.size > 0 && entries.every((p) => !openIds.has(p.pageId));
    if (renumbered) {
      const unowned = windows.flatMap((w) => w.tabs).filter((t) => !this.owned.has(t.pageId) && meaningful(t.url));
      for (const entry of entries) {
        const match = unowned.findIndex((t) => t.url === entry.url);
        if (match < 0) continue;
        const [page] = unowned.splice(match, 1);
        this.owned.delete(entry.pageId);
        const { missingSince: _gone, ...rest } = entry;
        this.owned.set(page!.pageId, { ...rest, pageId: page!.pageId });
        changed = true;
      }
    }
    for (const entry of [...this.owned.values()]) {
      if (openIds.has(entry.pageId)) {
        if (entry.missingSince !== undefined) {
          delete entry.missingSince;
          changed = true;
        }
        continue;
      }
      if (entry.missingSince === undefined) {
        entry.missingSince = this.now();
        changed = true;
      } else if (this.now() - entry.missingSince > PAGE_MISSING_GRACE_MS) {
        this.owned.delete(entry.pageId);
        changed = true;
      }
    }
    for (const w of windows) {
      const opener = w.tabs.map((t) => this.owned.get(t.pageId)).find((p) => p?.window);
      for (const t of w.tabs) {
        const page = this.owned.get(t.pageId);
        if (page) {
          if (meaningful(t.url) && page.url !== t.url) {
            page.url = t.url;
            changed = true;
          }
          continue;
        }
        const from = t.openerPageId ? this.owned.get(t.openerPageId) : undefined;
        const owner = from?.owner ?? opener?.owner;
        if (owner === undefined) continue;
        this.owned.set(t.pageId, { pageId: t.pageId, owner, url: t.url });
        changed = true;
      }
    }
    if (changed) this.savePages();
  }

  private stateFor(windowId: number, session: string, caller?: string): "yours" | "held" | "kept" | "kept-for-you" | "free" {
    const owner = this.locks.get(windowId);
    if (owner !== undefined) return owner === session ? "yours" : "held";
    const hold = this.holds.get(windowId);
    if (!hold || hold.until <= this.now()) return "free";
    const viewer = caller ?? this.runs.get(session)?.parent;
    return viewer !== undefined && hold.holder === holderOf(viewer) ? "kept-for-you" : "kept";
  }

  private activeHolds(): WindowHold[] {
    return [...this.holds.values()].filter((h) => h.until > this.now());
  }

  private loadHolds(): void {
    if (this.loaded) return;
    this.loaded = true;
    let expired = false;
    for (const hold of this.store?.load() ?? []) {
      if (hold.until <= this.now()) {
        expired = true;
        continue;
      }
      this.holds.set(hold.windowId, hold);
      this.unbound.add(hold.windowId);
    }
    if (expired) this.saveHolds();
  }

  private saveHolds(): void {
    try {
      this.store?.save(this.activeHolds());
    } catch {
      // The holds still work for this process; only a restart would forget them.
    }
  }

  /**
   * Keeps the holds on the windows they belong to. A hold whose window is open follows its pages;
   * one whose window is not (a restart of my-claw, or of the browser, which renumbers windows) goes
   * to the free window showing the same pages, when there is one; one that has expired goes.
   */
  private bindHolds(windows: BrowserWindowView[]): void {
    this.loadHolds();
    let changed = false;
    const open = new Map(windows.map((w) => [w.windowId, w]));
    for (const hold of [...this.holds.values()]) {
      if (hold.until <= this.now()) {
        this.holds.delete(hold.windowId);
        this.unbound.delete(hold.windowId);
        changed = true;
        continue;
      }
      const window = open.get(hold.windowId);
      if (window) {
        this.unbound.delete(hold.windowId);
        const urls = window.tabs.map((t) => t.url).filter(meaningful);
        if (urls.length > 0 && urls.join("\n") !== hold.urls.join("\n")) {
          hold.urls = urls;
          changed = true;
        }
        continue;
      }
      this.unbound.add(hold.windowId);
      let best: { window: BrowserWindowView; overlap: number } | undefined;
      for (const candidate of windows) {
        if (this.holds.has(candidate.windowId) || this.locks.has(candidate.windowId)) continue;
        const overlap = candidate.tabs.filter((t) => meaningful(t.url) && hold.urls.includes(t.url)).length;
        if (overlap > 0 && (!best || overlap > best.overlap)) best = { window: candidate, overlap };
      }
      if (!best) continue;
      this.holds.delete(hold.windowId);
      this.unbound.delete(hold.windowId);
      this.holds.set(best.window.windowId, { ...hold, windowId: best.window.windowId });
      changed = true;
    }
    if (changed) this.saveHolds();
  }

  private async refresh(): Promise<BrowserWindowView[]> {
    const windows = await this.backend.listWindows();
    this.bindHolds(windows);
    this.bindPages(windows);
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
    // Its hold stays: a browser restart brings the same pages back under a new window id, and
    // bindHolds moves the hold there. Only the window's own close (closeWindow) gives it up.
    for (const tab of this.tabsOf(windowId)) this.forgetPage(tab.pageId);
    this.layout = this.layout.filter((w) => w.windowId !== windowId);
    for (const run of this.runs.values()) run.current.delete(windowId);
  }

  private forgetPage(pageId: string): void {
    this.lastUsed.delete(pageId);
    for (const w of this.layout) w.tabs = w.tabs.filter((t) => t.pageId !== pageId);
  }
}
